import { describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import type { ExecutionPayload, Tx } from "@aztec-labs/stdlib/tx"
import { L2_PROPOSED } from "./claim"
import { MERCHANT_MAX_DELAY, MERCHANT_MIN_DELAY, type MerchantList } from "./merchants"
import {
	type ListOptions,
	memoryPaymentStore,
	openedCommitment,
	openRequest,
	PaymentGate,
	type PaymentIntent,
	type PaymentStore,
	paymentKey,
	payReplacingStale,
	payRequest,
	RESERVATION_TTL_MS,
	requestStamp,
	siloedCompletionTag,
	transferPrivate,
} from "./payments"
import { TOKEN_REFUSALS } from "./rules"
import {
	MERCHANT_SIDE_SLOT,
	REQUEST_OPENED_EFFECT,
	STAMP_BUCKET_SLOT,
	STANDARD_TX_LIFETIME,
	stamp,
	stampBucket,
	stampDeadline,
	stampUnmarkedUntil,
} from "./stamp"
import { fakeWallet } from "./test/fake-wallet"
import { MANIFEST } from "./test/fixtures"

const token = await AztecAddress.random()
const [merchant, alice, elsewhere] = await Promise.all([AztecAddress.random(), AztecAddress.random(), AztecAddress.random()])
const LIST: MerchantList = {
	block: 1,
	at: 0n,
	entries: new Map([
		[
			merchant.toString(),
			{
				off: false,
				scheduledOff: false,
				changeAt: 0n,
				delay: MERCHANT_MAX_DELAY,
				scheduledDelay: MERCHANT_MAX_DELAY,
				delayChangeAt: 0n,
			},
		],
	]),
}
const MINED = [TxStatus.PROPOSED, TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.FINALIZED]
/** The first second of an hour bucket, so a stamp opened now stays fresh for two hours. */
const T0 = 1_778_400_000n

const receipt = ({ status, reverted }: { status: TxStatus; reverted: boolean }) => ({
	status,
	isMined: () => MINED.includes(status),
	isPending: () => status === TxStatus.PENDING,
	isDropped: () => status === TxStatus.DROPPED,
	hasExecutionSucceeded: () => !reverted,
	hasExecutionReverted: () => reverted,
})

/** One chain: a tx sent through any node lands at `landAt` unless `lose` drops it; a landed private payment completes. */
function fakeChain() {
	const chain = {
		ts: T0,
		finalizedTs: T0,
		lose: false,
		revert: false,
		landAt: TxStatus.CHECKPOINTED as TxStatus,
		included: [] as Tx[],
		receipts: new Map<string, { status: TxStatus; reverted: boolean }>(),
		stamps: new Set<string>(),
		completions: new Set<string>(),
		payloads: [] as ExecutionPayload[],
	}
	const node = {
		sendTx: async (tx: Tx) => {
			if (chain.lose) return
			chain.included.push(tx)
			chain.receipts.set(tx.getTxHash().toString(), { status: chain.landAt, reverted: chain.revert })
			if (!chain.revert) for (const log of tx.data.getNonEmptyPrivateLogs()) chain.completions.add(log.fields[0].toString())
		},
		getTxReceipt: async (h: TxHash) => receipt(chain.receipts.get(h.toString()) ?? { status: TxStatus.DROPPED, reverted: false }),
		getBlockData: async (tag: string) => ({
			header: { globalVariables: { timestamp: tag === "finalized" ? chain.finalizedTs : chain.ts } },
		}),
		findLeavesIndexes: async (_b: unknown, _t: unknown, leaves: Fr[]) =>
			leaves.map((n) => (chain.stamps.has(n.toString()) ? { data: 0n } : undefined)),
		getPrivateLogsByTags: async ({ tags }: { tags: { value: Fr }[] }) => [chain.completions.has(tags[0]!.value.toString()) ? [{}] : []],
		getPublicLogsByTags: async () => [[]],
	} as unknown as AztecNode
	const finalize = (tx: Tx) => {
		const r = chain.receipts.get(tx.getTxHash().toString())!
		chain.receipts.set(tx.getTxHash().toString(), { ...r, status: TxStatus.FINALIZED })
	}
	return { chain, node, finalize }
}
type World = ReturnType<typeof fakeChain>

type Hooks = {
	beforeSend?: () => Promise<void> | void
	afterSend?: () => Promise<void> | void
	publicTarget?: AztecAddress
	/** The expiry the proven tx commits, after its anchor; the standard one unless the payment read shorter-lived state. */
	lifetime?: bigint
}

/**
 * A wallet whose send proves the payload's payment and hands it to `node`: a private payment carries the request's
 * completion log, a public one the call to `publicTarget` (the token unless a hook names another contract). The proof
 * anchors at the chain's latest block.
 */
function fakePayer(node: AztecNode, w: World, hooks: Hooks = {}): Wallet {
	return {
		getChainInfo: async () => ({ chainId: new Fr(MANIFEST.l1.chainId), version: new Fr(MANIFEST.l2.rollupVersion) }),
		sendTx: async (p: ExecutionPayload, opts?: { wait?: unknown }) => {
			await hooks.beforeSend?.()
			w.chain.payloads.push(p)
			const call = p.calls[0]!
			const isPublic = call.name === "transfer_public_to_commitment"
			const logs = isPublic ? [] : [{ fields: [await siloedCompletionTag(token, call.args[1]!)] }]
			const calls = isPublic
				? [{ request: { contractAddress: hooks.publicTarget ?? token }, calldata: [call.selector.toField(), ...call.args] }]
				: []
			const txHash = TxHash.random()
			const tx = {
				getTxHash: () => txHash,
				data: {
					constants: { anchorBlockHeader: { globalVariables: { timestamp: w.chain.ts } } },
					expirationTimestamp: w.chain.ts + (hooks.lifetime ?? STANDARD_TX_LIFETIME),
					getNonEmptyPrivateLogs: () => logs,
				},
				getPublicCallRequestsWithCalldata: () => calls,
			} as unknown as Tx
			await node.sendTx(tx)
			await hooks.afterSend?.()
			return opts?.wait === NO_WAIT ? { txHash, offchainEffects: [], offchainMessages: [] } : { receipt: { txHash } }
		},
	} as unknown as Wallet
}

/** A request opened for a merchant at `bucket` (the chain's current one by default). */
async function stampedRequest(w: World, bucket = stampBucket(w.chain.ts), commitment = Fr.random()): Promise<Fr> {
	w.chain.stamps.add((await siloNullifier(token, stamp(commitment, bucket))).toString())
	return commitment
}

/** The capsules a payment carried, as `[slot, value]`. */
const capsulesOf = (p: ExecutionPayload) => p.capsules.map((c) => [c.storageSlot.toBigInt(), c.data[0]!.toBigInt()])

/** A tab: its own gate and bound wallet over the shared store and chain. */
async function tab(store: PaymentStore, w: World, hooks?: Hooks, now?: () => number) {
	const gate = new PaymentGate(w.node, store, now)
	const wallet = await gate.bindWallet(async (node) => fakePayer(node, w, hooks))
	const pay = (c: Fr, from = alice, kind: PaymentIntent["kind"] = "private") =>
		payRequest(gate, wallet, token, { from, commitment: c, amount: 5n, kind }, { list: LIST, fee: "account-public" })
	return { gate, wallet, pay }
}

const refusal = (reason: string) => expect.objectContaining({ name: "PaymentRefusedError", reason })
const gated = () => {
	let open = () => {}
	const shut = new Promise<void>((r) => {
		open = r
	})
	return { shut, open }
}

describe("payRequest", () => {
	it("pays once, then refuses the same request from this client until and after it is final", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		const t = await tab(store, w)
		await t.pay(c)
		expect((await store.get(paymentKey(token, c)))?.state).toBe("sent")
		await expect(t.pay(c)).rejects.toEqual(refusal("in-flight"))
		w.finalize(w.chain.included[0]!)
		await expect(t.pay(c)).rejects.toEqual(refusal("paid"))
		expect(w.chain.included).toHaveLength(1)
	})

	it("with L2_PROPOSED, returns at the proposed block and keeps the request blocked until the payment is final", async () => {
		const w = fakeChain()
		w.chain.landAt = TxStatus.PROPOSED
		const c = await stampedRequest(w)
		const gate = new PaymentGate(w.node, memoryPaymentStore())
		const wallet = await gate.bindWallet(async (node) => fakePayer(node, w))
		const pay = () =>
			payRequest(
				gate,
				wallet,
				token,
				{ from: alice, commitment: c, amount: 5n, kind: "private" },
				{ list: LIST, fee: "account-public", wait: L2_PROPOSED },
			)
		await pay()
		await expect(pay()).rejects.toEqual(refusal("in-flight"))
		expect(w.chain.included).toHaveLength(1)
	})

	it("refuses a wallet not built on its gate, before reserving anything", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		const gate = new PaymentGate(w.node, store)
		const unbound = fakePayer(w.node, w)
		await expect(
			payRequest(
				gate,
				unbound,
				token,
				{ from: alice, commitment: c, amount: 5n, kind: "private" },
				{ list: LIST, fee: "account-public" },
			),
		).rejects.toThrow(/bindWallet/)
		expect(await store.get(paymentKey(token, c))).toBeUndefined()
	})

	it("lets exactly one of two tabs pay, refusing the other before it proves", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		const [a, b] = await Promise.all([tab(store, w), tab(store, w)])
		const results = await Promise.allSettled([a.pay(c), b.pay(c)])
		expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
		expect(results.find((r) => r.status === "rejected")).toEqual({ status: "rejected", reason: refusal("in-flight") })
		expect(w.chain.included).toHaveLength(1)
	})

	it("after a reload mid-payment, keeps the request blocked until the finalized chain passes the lost tx's expiry", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		w.chain.lose = true
		const closed = await tab(store, w, {
			afterSend: () => {
				throw new Error("tab closed")
			},
		})
		await expect(closed.pay(c)).rejects.toThrow("tab closed")
		w.chain.lose = false
		const reloaded = await tab(store, w)
		w.chain.ts += 90_000n
		await expect(reloaded.pay(c), "the latest block alone can still be pruned").rejects.toEqual(refusal("in-flight"))
		w.chain.finalizedTs += STANDARD_TX_LIFETIME
		await expect(reloaded.pay(c)).rejects.toEqual(refusal("in-flight"))
		w.chain.finalizedTs += 1n
		expect(await reloaded.gate.status(paymentKey(token, c))).toBeUndefined()
		expect(w.chain.included).toHaveLength(0)
	})

	it("releases the request when the payment fails before it is sent", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		const failing = await tab(store, w, {
			beforeSend: () => {
				throw new Error("Simulation error: Balance too low")
			},
		})
		await expect(failing.pay(c)).rejects.toThrow("Balance too low")
		expect(await store.get(paymentKey(token, c))).toBeUndefined()
		await (await tab(store, w)).pay(c)
		expect(w.chain.included).toHaveLength(1)
	})

	it("keeps a reverted payment's request blocked until the revert is final", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		const t = await tab(store, w)
		w.chain.revert = true
		await expect(t.pay(c)).rejects.toThrow(/rejected on Aztec/)
		w.chain.revert = false
		await expect(t.pay(c), "a prune could still undo the revert").rejects.toEqual(refusal("in-flight"))
		w.finalize(w.chain.included[0]!)
		await t.pay(c)
		expect(w.chain.included).toHaveLength(2)
	})

	// A superseded attempt whose proof came out marked must not answer `stale`: its caller would replace a request the
	// other tab's payment is still landing in.
	it.each([
		["", STANDARD_TX_LIFETIME],
		[", even when its proof came out marked", 3_600n],
	])("never lets an abandoned reservation reach the node once another tab took it over%s", async (_, lifetime) => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		let ms = 0
		const proving = gated()
		const slow = await tab(store, w, { beforeSend: () => proving.shut, lifetime }, () => ms)
		const first = slow.pay(c)
		await Bun.sleep(10)
		ms += RESERVATION_TTL_MS + 1
		await (await tab(store, w, undefined, () => ms)).pay(c)
		proving.open()
		await expect(first).rejects.toEqual(refusal("in-flight"))
		expect(w.chain.included).toHaveLength(1)
	})

	it("in one tab, refuses a second attempt while a lapsed first one is still sending, and the first never lands", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		let ms = 0
		const proving = gated()
		let held = true
		const t = await tab(store, w, { beforeSend: () => (held ? proving.shut : undefined) }, () => ms)
		const first = t.pay(c)
		await Bun.sleep(10)
		ms += RESERVATION_TTL_MS + 1
		held = false
		await expect(t.pay(c)).rejects.toEqual(refusal("in-flight"))
		proving.open()
		await expect(first).rejects.toEqual(refusal("in-flight"))
		expect(w.chain.included).toHaveLength(0)
		await t.pay(c)
		expect(w.chain.included).toHaveLength(1)
	})

	it("never lets a late send response overwrite the record of a payment that replaced it", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		const response = gated()
		const stalled = await tab(store, w, { afterSend: () => response.shut })
		w.chain.revert = true
		const first = stalled.pay(c)
		while (w.chain.included.length === 0) await Bun.sleep(5)
		w.chain.revert = false
		w.finalize(w.chain.included[0]!)
		await (await tab(store, w)).pay(c)
		const replacement = w.chain.included[1]!.getTxHash().toString()
		response.open()
		await expect(first).rejects.toThrow(/rejected on Aztec/)
		expect(await store.get(paymentKey(token, c))).toMatchObject({ state: "sent", txHash: replacement })
		await expect((await tab(store, w)).pay(c)).rejects.toEqual(refusal("in-flight"))
		expect(w.chain.included).toHaveLength(2)
	})

	it("records a public payment only when it is the token's call into this request", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const paid = Fr.random()
		await (await tab(store, w)).pay(paid, merchant, "public")
		expect((await store.get(paymentKey(token, paid)))?.state).toBe("sent")
		const unrelated = Fr.random()
		const elsewhereTab = await tab(store, w, { publicTarget: elsewhere })
		await expect(elsewhereTab.pay(unrelated, merchant, "public")).rejects.toThrow(/without passing the payment gate/)
		expect((await store.get(paymentKey(token, unrelated)))?.state, "a send the gate missed still blocks the request").toBe("sent")
	})

	it("refuses a request already completed on chain, and a user paying an unstamped one, before proving", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const paid = await stampedRequest(w)
		w.chain.completions.add((await siloedCompletionTag(token, paid)).toString())
		const t = await tab(store, w)
		await expect(t.pay(paid)).rejects.toEqual(refusal("completed-on-chain"))
		const unstamped = Fr.random()
		await expect(t.pay(unstamped)).rejects.toThrow(TOKEN_REFUSALS.payment)
		await t.pay(unstamped, merchant)
		expect(w.chain.included).toHaveLength(1)
		expect(await store.get(paymentKey(token, paid))).toBeUndefined()
	})

	it("pays through a fresh stamp with the side and bucket capsules, and a merchant by its own proof", async () => {
		const w = fakeChain()
		const t = await tab(memoryPaymentStore(), w)
		const bucket = stampBucket(w.chain.ts)
		await t.pay(await stampedRequest(w))
		await t.pay(await stampedRequest(w), merchant)
		w.chain.ts = stampUnmarkedUntil(bucket)
		await t.pay(await stampedRequest(w, bucket), merchant)
		expect(w.chain.payloads.map(capsulesOf)).toEqual([
			[
				[MERCHANT_SIDE_SLOT.toBigInt(), 0n],
				[STAMP_BUCKET_SLOT.toBigInt(), bucket],
			],
			[
				[MERCHANT_SIDE_SLOT.toBigInt(), 0n],
				[STAMP_BUCKET_SLOT.toBigInt(), bucket],
			],
			[[MERCHANT_SIDE_SLOT.toBigInt(), 1n]],
		])
	})

	it("refuses a user's private payment through a stamp no longer fresh as stale, releasing it, and pays it publicly", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		w.chain.ts = stampUnmarkedUntil(stampBucket(w.chain.ts))
		const t = await tab(store, w)
		await expect(t.pay(c)).rejects.toEqual(refusal("stale"))
		expect(await store.get(paymentKey(token, c))).toBeUndefined()
		await t.pay(c, alice, "public")
		expect(w.chain.included).toHaveLength(1)
	})

	it("refuses as stale a merchant's payment whose own read, its switch-off pending, would cap earlier than a live stamp", async () => {
		const w = fakeChain()
		const c = await stampedRequest(w)
		w.chain.ts = stampUnmarkedUntil(stampBucket(w.chain.ts))
		const t = await tab(memoryPaymentStore(), w)
		const settled = LIST.entries.get(merchant.toString())!
		const switchingOff = { ...settled, scheduledOff: true, changeAt: w.chain.ts + MERCHANT_MIN_DELAY }
		const list = { ...LIST, entries: new Map([[merchant.toString(), switchingOff]]) }
		const intent = { from: merchant, commitment: c, amount: 5n, kind: "private" as const }
		await expect(payRequest(t.gate, t.wallet, token, intent, { list, fee: "account-public" })).rejects.toEqual(refusal("stale"))
		expect(w.chain.payloads).toEqual([])
	})

	it("refuses at the gate a private payment into a stamped request whose proof came out marked, a merchant's too", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const c = await stampedRequest(w)
		const marked = await tab(store, w, { lifetime: STANDARD_TX_LIFETIME - 3_600n })
		await expect(marked.pay(c)).rejects.toEqual(refusal("stale"))
		const bucket = stampBucket(w.chain.ts)
		w.chain.ts = stampUnmarkedUntil(bucket)
		const live = await stampedRequest(w, bucket)
		await expect(marked.pay(live, merchant), "its read shortened after the list's").rejects.toEqual(refusal("stale"))
		expect([w.chain.included.length, await store.get(paymentKey(token, c)), await store.get(paymentKey(token, live))]).toEqual([
			0,
			undefined,
			undefined,
		])
		await marked.pay(Fr.random(), merchant)
		expect(w.chain.included, "with no stamp to use instead, a merchant's marked payment goes").toHaveLength(1)
	})
})

describe("payReplacingStale", () => {
	const opener = (w: World) => {
		const opened: Fr[] = []
		const reopen = async () => {
			opened.push(await stampedRequest(w))
			return opened.at(-1)!
		}
		return { opened, reopen }
	}

	it("pays a request opened anew when the stored one is refused as stale", async () => {
		const w = fakeChain()
		const t = await tab(memoryPaymentStore(), w)
		const stored = await stampedRequest(w)
		w.chain.ts = stampUnmarkedUntil(stampBucket(w.chain.ts))
		const { opened, reopen } = opener(w)
		await payReplacingStale(t.gate, token, stored, (c) => t.pay(c), reopen)
		expect([opened.length, w.chain.included.length]).toEqual([1, 1])
		await expect(t.pay(stored), "a replaced request is never stale again").rejects.toEqual(refusal("replaced"))
	})

	it("reaches a new request through a replacement that went stale unpaid", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const stored = await stampedRequest(w)
		w.chain.ts = stampUnmarkedUntil(stampBucket(w.chain.ts))
		const { opened, reopen } = opener(w)
		const broke = await tab(store, w, {
			beforeSend: () => {
				throw new Error("Simulation error: Balance too low")
			},
		})
		await expect(payReplacingStale(broke.gate, token, stored, (c) => broke.pay(c), reopen)).rejects.toThrow("Balance too low")
		w.chain.ts = stampUnmarkedUntil(stampBucket(w.chain.ts))
		const t = await tab(store, w)
		await payReplacingStale(t.gate, token, stored, (c) => t.pay(c), reopen)
		expect([opened.length, w.chain.included.length]).toEqual([2, 1])
	})

	it("lets two tabs that meet one stale request share its replacement, which is paid once", async () => {
		const w = fakeChain()
		const store = memoryPaymentStore()
		const [a, b] = await Promise.all([tab(store, w), tab(store, w)])
		const stored = await stampedRequest(w)
		w.chain.ts = stampUnmarkedUntil(stampBucket(w.chain.ts))
		const { opened, reopen } = opener(w)
		const [entered, opening] = [gated(), gated()]
		const slow = async () => {
			entered.open()
			await opening.shut
			return reopen()
		}
		const first = payReplacingStale(a.gate, token, stored, (c) => a.pay(c), slow)
		await entered.shut
		const second = payReplacingStale(b.gate, token, stored, (c) => b.pay(c), reopen)
		opening.open()
		const results = await Promise.allSettled([first, second])
		expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
		expect([opened.length, w.chain.included.length]).toEqual([1, 1])
	})

	it("opens nothing for a stale request whose first payment is still recorded as sent", async () => {
		const w = fakeChain()
		const t = await tab(memoryPaymentStore(), w)
		const stored = await stampedRequest(w)
		await t.pay(stored)
		w.chain.ts = stampUnmarkedUntil(stampBucket(w.chain.ts))
		const { opened, reopen } = opener(w)
		await expect(payReplacingStale(t.gate, token, stored, (c) => t.pay(c), reopen)).rejects.toEqual(refusal("in-flight"))
		expect([opened.length, w.chain.included.length]).toEqual([0, 1])
	})
})

describe("requestStamp", () => {
	it("finds the newest live stamp in one node call, and none past its deadline", async () => {
		const w = fakeChain()
		const bucket = stampBucket(w.chain.ts)
		const c = await stampedRequest(w, bucket - 3n)
		await stampedRequest(w, bucket - 1n, c)
		let calls = 0
		const node = {
			...w.node,
			findLeavesIndexes: (...a: Parameters<AztecNode["findLeavesIndexes"]>) => {
				calls++
				return w.node.findLeavesIndexes(...a)
			},
		}
		expect(await requestStamp(node, token, c)).toMatchObject({ bucket: bucket - 1n, state: "fresh" })
		w.chain.ts = stampDeadline(bucket - 1n)
		expect(await requestStamp(node, token, c)).toMatchObject({ bucket: bucket - 1n, state: "live" })
		w.chain.ts += 1n
		expect(await requestStamp(node, token, c)).toBeUndefined()
		expect(calls).toBe(3)
	})
})

describe("openedCommitment", () => {
	it("takes the one request effect the token emitted", async () => {
		const c = Fr.random()
		const effect = (contractAddress: AztecAddress, data: Fr[]) => ({ contractAddress, data })
		const effects = [
			effect(elsewhere, [REQUEST_OPENED_EFFECT, Fr.random()]),
			effect(token, [Fr.random()]),
			effect(token, [REQUEST_OPENED_EFFECT, c]),
		]
		expect(openedCommitment(effects, token).equals(c)).toBe(true)
		expect(() => openedCommitment(effects.slice(0, 2), token)).toThrow(/opened 0/)
		expect(() => openedCommitment([...effects, effects[2]!], token)).toThrow(/opened 2/)
	})
})

describe("openRequest", () => {
	it("lets only a merchant that stays one open a request for another account, refusing anyone else before any send", async () => {
		const [leaving, stayed] = await Promise.all([AztecAddress.random(), AztecAddress.random()])
		const listed = LIST.entries.get(merchant.toString())!
		const list: MerchantList = {
			...LIST,
			entries: new Map([
				...LIST.entries,
				[leaving.toString(), { ...listed, scheduledOff: true, changeAt: LIST.at + MERCHANT_MIN_DELAY }],
				// A cancelled switch-off leaves its timestamp pending with the merchant still on.
				[stayed.toString(), { ...listed, changeAt: LIST.at + MERCHANT_MIN_DELAY }],
			]),
		}
		const open = async (from: AztecAddress, to: AztecAddress) => {
			const w = fakeWallet()
			const opened = openRequest(w.wallet, {} as never, token, { from, to, completer: alice }, { list, fee: "account-public" })
			return { message: String(await opened.catch((e: unknown) => e)), sent: w.sent.length }
		}
		for (const [from, to] of [
			[alice, merchant],
			[leaving, alice],
		] as const) {
			expect(await open(from, to)).toEqual({ message: expect.stringContaining("Only a merchant opens"), sent: 0 })
		}
		const pad = await open(stayed, alice)
		expect(pad.sent, "a merchant's pad for a user is sent").toBe(1)
		expect(pad.message).not.toContain("Only a merchant opens")
	})
})

describe("payment fees", () => {
	it("pays through the method named, and leaves the payer to the account only on account-public", async () => {
		const sponsor = { paymentMethod: new SponsoredFeePaymentMethod(AztecAddress.fromStringUnsafe(MANIFEST.l2.sponsoredFpc as string)) }
		const transfer = { from: alice, to: merchant, amount: 5n }
		const sponsored = fakeWallet()
		await transferPrivate(sponsored.wallet, token, transfer, { list: LIST, fee: sponsor })
		expect(sponsored.sent[0]).toMatchObject({
			calls: ["sponsor_unconditionally", "transfer_private_to_private"],
			feePayer: MANIFEST.l2.sponsoredFpc,
		})
		const own = fakeWallet()
		await transferPrivate(own.wallet, token, transfer, { list: LIST, fee: "account-public" })
		expect(own.sent[0]).toMatchObject({ calls: ["transfer_private_to_private"], feePayer: undefined })
		// @ts-expect-error a payment call always names who pays its fee
		const unnamed: ListOptions = { list: LIST }
		const untyped = fakeWallet()
		await expect(transferPrivate(untyped.wallet, token, transfer, unnamed)).rejects.toThrow(/Name the fee payer/)
		expect(untyped.sent).toHaveLength(0)
	})
})
