import { beforeAll, describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
	type Address,
	concat,
	encodeAbiParameters,
	encodeEventTopics,
	getAddress,
	type Hex,
	hexToBigInt,
	hexToNumber,
	keccak256,
	type Log,
	numberToHex,
	type PublicClient,
	pad,
	parseEventLogs,
	slice,
	toHex,
	type WalletClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { PERMIT2_DEPOSIT_ROUTER_ABI } from "./abi"
import { MessageNotConsumableError, withRebuiltTicket } from "./claim"
import { claimSecretHash } from "./claim-secret"
import {
	assertPublicRecipient,
	type ClaimTicket,
	confirmDeposit,
	type DepositDraft,
	KeyHolderRequiredError,
	PublicDepositToUserError,
	prepareDeposit,
	reconcileDeposit,
	submitDeposit,
	ticketFromReceiptLogs,
} from "./deposit"
import { NetworkMismatchError } from "./network"
import { BridgePausedError, type PauseSource } from "./pause"
import type { DepositTypedData } from "./permit2"
import { a, MANIFEST as M } from "./test/fixtures"
import type { L1Ctx } from "./types"

const ACCOUNT = getAddress(a(0xaa))
const TX: Hex = pad("0x7e", { size: 32 })
const NOW = 1_000n
const now = () => NOW
let recipient: AztecAddress
/** The bridge's pause flag as the L2 node reports it. */
const pauseFlag = (paused = false) => {
	const s = { paused }
	const node: PauseSource = { getPublicStorageAt: async () => new Fr(s.paused ? 1n : 0n) }
	return { s, node }
}
const LIVE = pauseFlag().node

beforeAll(async () => {
	recipient = await AztecAddress.random()
})

function depositLog(
	d: DepositDraft,
	o: { address?: Address; blockNumber?: bigint; depositor?: Address; index?: bigint; key?: Hex } = {},
): Log {
	const topics = encodeEventTopics({
		abi: PERMIT2_DEPOSIT_ROUTER_ABI,
		eventName: "Deposit",
		args: { depositor: o.depositor ?? ACCOUNT, aztecRecipient: d.witness.aztecRecipient },
	})
	const data = encodeAbiParameters(
		[{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bool" }],
		[o.key ?? pad("0x4e7"), o.index ?? 42n, d.intent.amount, d.witness.secretHash, d.witness.isPrivate],
	)
	return {
		address: o.address ?? M.l1.router,
		topics: topics as [Hex, ...Hex[]],
		data,
		blockNumber: o.blockNumber ?? 120n,
		blockHash: pad("0xb"),
		transactionHash: TX,
		transactionIndex: 0,
		logIndex: 0,
		removed: false,
	}
}

const blockHash = (n: bigint) => pad(numberToHex(n), { size: 32 })

/** An L1 whose finalized block, tip, receipts and logs the test sets; counts every send. */
function chain(account: Address = ACCOUNT) {
	const s = {
		finalized: { number: 100n, timestamp: NOW },
		/** What a switched provider reports for the finalized block's hash. */
		finalizedHashOverride: undefined as Hex | undefined,
		latest: 150n,
		receipts: new Map<Hex, { status: "success" | "reverted"; logs: Log[] }>(),
		logs: [] as Log[],
		failGetLogs: false,
		onGetLogs: undefined as (() => void) | undefined,
		/** Permit2's nonce bitmap words by position, as the reader reports them; every read is recorded. */
		nonceWords: new Map<bigint, bigint>(),
		failNonceRead: false,
		nonceReads: [] as unknown[],
		chainId: M.l1.chainId,
		readerChainId: M.l1.chainId,
		sentOnChain: undefined as number | undefined,
		sentGas: undefined as bigint | undefined,
		estimateError: undefined as Error | undefined,
		selected: account,
		sends: 0,
		sendError: undefined as Error | undefined,
		signError: undefined as Error | undefined,
		signs: 0,
		onSign: undefined as (() => void) | undefined,
		sign: undefined as ((typedData: DepositTypedData) => Promise<Hex>) | undefined,
	}
	const receipt = async ({ hash }: { hash: Hex }) => {
		const r = s.receipts.get(hash)
		if (!r) throw new Error("TransactionReceiptNotFoundError")
		return r
	}
	const publicClient = {
		getChainId: async () => s.readerChainId,
		getBlock: async (q: { blockNumber?: bigint }) =>
			q.blockNumber === undefined
				? { ...s.finalized, hash: s.finalizedHashOverride ?? blockHash(s.finalized.number) }
				: { number: q.blockNumber, hash: blockHash(q.blockNumber) },
		getBlockNumber: async () => s.latest,
		getTransactionReceipt: receipt,
		waitForTransactionReceipt: receipt,
		estimateContractGas: async () => {
			if (s.estimateError) throw s.estimateError
			return 200_000n
		},
		getLogs: async (q: { address: Address; args: { depositor: Address }; fromBlock: bigint; toBlock: bigint }) => {
			if (s.failGetLogs) throw new Error("RPC 503")
			s.onGetLogs?.()
			const inRange = s.logs.filter((l) => (l.blockNumber ?? 0n) >= q.fromBlock && (l.blockNumber ?? 0n) <= q.toBlock)
			return parseEventLogs({
				abi: PERMIT2_DEPOSIT_ROUTER_ABI,
				eventName: "Deposit",
				logs: inRange,
				args: { depositor: q.args.depositor },
			})
		},
		readContract: async (q: { args: readonly [Address, bigint] }) => {
			s.nonceReads.push(q)
			if (s.failNonceRead) throw new Error("missing trie node")
			return s.nonceWords.get(q.args[1]) ?? 0n
		},
	} as unknown as PublicClient
	const walletClient = {
		chain: undefined,
		getChainId: async () => s.chainId,
		getAddresses: async () => [s.selected],
		signTypedData: async ({ account: _, ...typedData }: DepositTypedData & { account: unknown }) => {
			s.signs++
			s.onSign?.()
			if (s.signError) throw s.signError
			return s.sign ? s.sign(typedData) : pad("0x5195", { size: 65 })
		},
		writeContract: async (req: { chain: { id: number } | null; gas?: bigint }) => {
			s.sentOnChain = req.chain?.id
			s.sentGas = req.gas
			s.sends++
			if (s.sendError) throw s.sendError
			return TX
		},
	} as unknown as WalletClient
	const l1: L1Ctx = { publicClient, walletClient, account }
	return { s, l1 }
}

const draft = (kind: "public" | "private" = "public", amount = 1_000_000n) => prepareDeposit({ amount, recipient, kind }, M, now)

describe("prepareDeposit", () => {
	it("mirrors each router intent rule, plus the recipient an L2 claim needs", async () => {
		await expect(draft("public", 0n)).rejects.toThrow("positive")
		await expect(draft("public", 2n ** 128n)).rejects.toThrow("L2 token can hold")
		await expect(prepareDeposit({ amount: 1n, recipient: AztecAddress.ZERO, kind: "public" }, M, now)).rejects.toThrow("zero")
		const offCurve = AztecAddress.fromBigIntUnsafe(4n) // x = 4 has no point on Grumpkin
		expect(await offCurve.isValid()).toBe(false)
		await expect(prepareDeposit({ amount: 1n, recipient: offCurve, kind: "public" }, M, now)).rejects.toThrow("not a valid")
		await draft("public", 2n ** 128n - 1n)
	})

	it("a public deposit names its recipient; a private one commits it inside the secret hash instead", async () => {
		const pub = await draft("public")
		expect(pub.witness).toMatchObject({ aztecRecipient: recipient.toString(), isPrivate: false })
		const priv = await draft("private")
		expect(priv.witness).toMatchObject({ aztecRecipient: pad("0x0"), isPrivate: true })
		expect(priv.secretHash.equals(await claimSecretHash(priv.secretOrSalt, recipient))).toBe(true)
		expect(priv.typedData.message).toMatchObject({ spender: M.l1.router, deadline: NOW + 1800n, permitted: { token: M.l1.usdc } })
	})
})

describe("submitDeposit", () => {
	it("refuses a wrong chain or a switched account before sending anything", async () => {
		const wrongChain = chain()
		wrongChain.s.chainId = 1
		await expect(submitDeposit(await draft(), wrongChain.l1, M, LIVE)).rejects.toBeInstanceOf(NetworkMismatchError)
		const switched = chain()
		switched.s.selected = getAddress(a(0xbb))
		const d = await draft()
		await expect(submitDeposit(d, switched.l1, M, LIVE)).rejects.toBeInstanceOf(NetworkMismatchError)
		expect(wrongChain.s.sends + switched.s.sends).toBe(0)
		expect(d.submission).toBeUndefined()
	})

	it("records the pre-send finalized block and the hash, and never sends a draft twice", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		expect(await submitDeposit(d, l1, M, LIVE)).toBe(TX)
		expect(d.submission).toEqual({ account: ACCOUNT, chainId: M.l1.chainId, fromBlock: 100n, fromBlockHash: blockHash(100n) })
		expect(d.l1TxHash).toBe(TX)
		expect(s.sentOnChain).toBe(M.l1.chainId)
		await expect(submitDeposit(d, l1, M, LIVE)).rejects.toThrow("already sent")
		expect(s.sends).toBe(1)
	})

	it("a concurrent second call is refused outright and cannot disturb the first one's record", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		const [first, second] = await Promise.allSettled([submitDeposit(d, l1, M, LIVE), submitDeposit(d, l1, M, LIVE)])
		expect(first).toMatchObject({ status: "fulfilled", value: TX })
		expect(second).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ message: expect.stringContaining("being sent") }),
		})
		expect([s.signs, s.sends]).toEqual([1, 1])
		expect(d.submission).toBeDefined()
	})

	it("refuses an L1 reader on another chain before signing: its finalized block would misplace the recovery scan", async () => {
		const { s, l1 } = chain()
		s.readerChainId = 1
		await expect(submitDeposit(await draft(), l1, M, LIVE)).rejects.toBeInstanceOf(NetworkMismatchError)
		expect(s.signs).toBe(0)
	})

	it("sends with headroom over the estimate; a deposit whose estimate reverts is never marked sent", async () => {
		const { s, l1 } = chain()
		await submitDeposit(await draft(), l1, M, LIVE)
		expect(s.sentGas).toBe(300_000n)
		const reverting = await draft()
		s.estimateError = new Error("execution reverted")
		await expect(submitDeposit(reverting, l1, M, LIVE)).rejects.toThrow("reverted")
		expect([reverting.submission, s.sends]).toEqual([undefined, 1])
	})

	it("an explicit refusal of the send leaves the draft sendable; any other failure keeps it submitted", async () => {
		const { s, l1 } = chain()
		const refused = await draft()
		s.sendError = Object.assign(new Error("User rejected the request."), { code: 4001 })
		await expect(submitDeposit(refused, l1, M, LIVE)).rejects.toThrow("rejected")
		expect(refused.submission).toBeUndefined()
		const lost = await draft()
		s.sendError = new Error("wallet disconnected")
		await expect(submitDeposit(lost, l1, M, LIVE)).rejects.toThrow("disconnected")
		expect(lost.submission).toBeDefined()
		expect(lost.l1TxHash).toBeUndefined()
	})

	it("a refusal-shaped send error frees the draft only from a wallet that asks its user, never from a local key", async () => {
		const key = privateKeyToAccount(keccak256(toHex("local signer")))
		const refusal = Object.assign(new Error("User rejected the request."), { code: 4001 })
		for (const [account, freed] of [
			[key, false],
			[{ address: key.address, type: "json-rpc" }, true],
		] as const) {
			const { s, l1 } = chain(key.address)
			Object.assign(l1.walletClient, { account })
			s.sendError = refusal
			const d = await draft()
			await expect(submitDeposit(d, l1, M, LIVE)).rejects.toThrow("rejected")
			expect(d.submission === undefined, account.type).toBe(freed)
		}
	})

	it("a wallet that cannot sign (unsupported method, disconnect) leaves the draft unsent and retryable", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		s.signError = new Error("Method eth_signTypedData_v4 not supported")
		await expect(submitDeposit(d, l1, M, LIVE)).rejects.toThrow("not supported")
		expect(d.submission).toBeUndefined()
		expect(s.sends).toBe(0)
		s.signError = undefined
		expect(await submitDeposit(d, l1, M, LIVE)).toBe(TX)
	})

	it("a paused bridge is refused before the signature, and a pause that lands during it before the send", async () => {
		const { s, l1 } = chain()
		const flag = pauseFlag(true)
		const d = await draft()
		await expect(submitDeposit(d, l1, M, flag.node)).rejects.toBeInstanceOf(BridgePausedError)
		expect(s.signs).toBe(0)
		flag.s.paused = false
		s.onSign = () => {
			flag.s.paused = true
		}
		await expect(submitDeposit(d, l1, M, flag.node)).rejects.toBeInstanceOf(BridgePausedError)
		expect([s.signs, s.sends]).toEqual([1, 0])
		expect(d.submission).toBeUndefined()
	})
})

describe("the private deposit's key-holder pre-check", () => {
	// Deterministic test keys; they hold nothing anywhere.
	const holder = privateKeyToAccount(keccak256(toHex("depositor")))
	const stranger = privateKeyToAccount(keccak256(toHex("stranger")))
	const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
	/** The same key's other valid signature: `s` mirrored, `v` flipped; viem recovers it, OpenZeppelin refuses it. */
	const highS = (sig: Hex) => {
		const v = hexToNumber(slice(sig, 64, 65))
		return concat([
			slice(sig, 0, 32),
			numberToHex(N - hexToBigInt(slice(sig, 32, 64)), { size: 32 }),
			numberToHex(v === 27 ? 28 : 27, { size: 1 }),
		])
	}
	const yParity = (sig: Hex) => concat([slice(sig, 0, 64), numberToHex(hexToNumber(slice(sig, 64, 65)) - 27, { size: 1 })])

	it("sends the account's own signature", async () => {
		const { s, l1 } = chain(holder.address)
		s.sign = (td) => holder.signTypedData(td)
		expect(await submitDeposit(await draft("private"), l1, M, LIVE)).toBe(TX)
	})

	it("refuses a contract's, another key's, a compact, a high-s or a 0/1-v signature before estimating or sending", async () => {
		const forms: ((td: DepositTypedData) => Promise<Hex>)[] = [
			async () => pad("0x5195", { size: 65 }),
			async () => "0x1234",
			async (td) => slice(await holder.signTypedData(td), 0, 64),
			(td) => stranger.signTypedData(td),
			async (td) => highS(await holder.signTypedData(td)),
			async (td) => yParity(await holder.signTypedData(td)),
		]
		for (const form of forms) {
			const { s, l1 } = chain(holder.address)
			s.sign = form
			s.estimateError = new Error("estimated")
			const d = await draft("private")
			await expect(submitDeposit(d, l1, M, LIVE)).rejects.toBeInstanceOf(KeyHolderRequiredError)
			expect([s.sends, d.submission]).toEqual([0, undefined])
		}
	})

	it("leaves the public leg to the router, which never checks its signer", async () => {
		const { l1 } = chain(holder.address)
		expect(await submitDeposit(await draft("public"), l1, M, LIVE)).toBe(TX)
	})
})

describe("confirmDeposit and the receipt's Deposit event", () => {
	it("a reverted receipt throws and leaves the draft intact", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		await submitDeposit(d, l1, M, LIVE)
		s.receipts.set(TX, { status: "reverted", logs: [] })
		await expect(confirmDeposit(d, l1, M, undefined, { attempts: 1, waitMs: async () => {} })).rejects.toThrow("reverted")
		expect(d.l1TxHash).toBe(TX)
		expect(d.submission).toBeDefined()
	})

	it("only the router's log counts: a same-signature log the token emitted is ignored, and two router logs are refused", async () => {
		const { l1 } = chain()
		const d = await draft()
		await submitDeposit(d, l1, M, LIVE)
		const forged = depositLog(d, { address: M.l1.usdc, index: 666n })
		expect(ticketFromReceiptLogs(d, [forged, depositLog(d)], M)).toMatchObject({
			leafIndex: 42n,
			messageHash: pad("0x4e7"),
			depositor: ACCOUNT,
		})
		expect(() => ticketFromReceiptLogs(d, [depositLog(d), depositLog(d, { index: 43n })], M)).toThrow("exactly one")
		expect(() => ticketFromReceiptLogs(d, [depositLog(d, { depositor: getAddress(a(0xbb)) })], M)).toThrow("does not match")
	})
})

describe("reconcileDeposit", () => {
	it("after a receipt timeout, finds the mined deposit by hash and never re-sends", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		await submitDeposit(d, l1, M, LIVE)
		await expect(confirmDeposit(d, l1, M, undefined, { attempts: 1, waitMs: async () => {} })).rejects.toThrow("not confirmed")
		s.receipts.set(TX, { status: "success", logs: [depositLog(d)] })
		expect(await reconcileDeposit(d, l1, M)).toMatchObject({ leafIndex: 42n, depositor: ACCOUNT })
		expect(s.sends).toBe(1)
	})

	it("finds a deposit whose hash never arrived, or whose hash was replaced, by scanning the router's logs", async () => {
		for (const hashKnown of [false, true]) {
			const { s, l1 } = chain()
			const d = await draft()
			if (!hashKnown) s.sendError = new Error("wallet response lost")
			await submitDeposit(d, l1, M, LIVE).catch(() => {})
			expect(d.l1TxHash === TX).toBe(hashKnown)
			s.logs = [depositLog(d, { address: M.l1.usdc, index: 666n }), depositLog(d)]
			expect(await reconcileDeposit(d, l1, M)).toMatchObject({ leafIndex: 42n })
		}
	})

	it("finds a deposit re-mined below the tip seen at send time, across several scan chunks", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		await submitDeposit(d, l1, M, LIVE)
		s.latest = 20_000n
		s.logs = [depositLog(d, { blockNumber: 101n })]
		expect(await reconcileDeposit(d, l1, M)).toMatchObject({ leafIndex: 42n })
		s.logs = [depositLog(d, { blockNumber: 19_999n })]
		expect(await reconcileDeposit(d, l1, M)).toMatchObject({ leafIndex: 42n })
	})

	it("is not-deposited only after a complete scan through a finalized block past the deadline", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		await submitDeposit(d, l1, M, LIVE)
		const deadline = d.typedData.message.deadline
		s.finalized = { number: 140n, timestamp: deadline }
		expect(await reconcileDeposit(d, l1, M)).toBe("pending")
		s.finalized = { number: 140n, timestamp: deadline + 1n }
		s.failGetLogs = true
		expect(await reconcileDeposit(d, l1, M)).toBe("pending")
		s.failGetLogs = false
		expect(await reconcileDeposit(d, l1, M)).toBe("not-deposited")
		expect(s.sends).toBe(1)
	})

	it("an empty scan past the deadline is pending while Permit2 shows the permit's nonce spent at the finalized block", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		d.typedData.message.nonce = (5n << 8n) | 255n
		s.sendError = new Error("wallet response lost")
		await submitDeposit(d, l1, M, LIVE).catch(() => {})
		s.finalized = { number: 140n, timestamp: d.typedData.message.deadline + 1n }
		s.nonceWords.set(5n, 1n << 255n)
		expect(await reconcileDeposit(d, l1, M)).toBe("pending")
		expect(s.nonceReads).toEqual([
			expect.objectContaining({ address: M.l1.permit2, functionName: "nonceBitmap", args: [ACCOUNT, 5n], blockNumber: 140n }),
		])
		for (const [word, bits] of [
			[5n, 1n << 254n],
			[6n, 1n << 255n],
		] as const) {
			s.nonceWords = new Map([[word, bits]])
			expect(await reconcileDeposit(d, l1, M), `word ${word}`).toBe("not-deposited")
		}
		s.failNonceRead = true
		expect(await reconcileDeposit(d, l1, M)).toBe("pending")
	})

	it("a tip read that lags the finalized block still scans through it before any verdict", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		await submitDeposit(d, l1, M, LIVE)
		s.latest = 120n
		s.finalized = { number: 140n, timestamp: d.typedData.message.deadline + 1n }
		s.logs = [depositLog(d, { blockNumber: 130n })]
		expect(await reconcileDeposit(d, l1, M)).toMatchObject({ leafIndex: 42n })
	})

	it("never gives a verdict from another chain or deployment: a reader that switches mid-scan throws, keeping the draft", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		await submitDeposit(d, l1, M, LIVE)
		s.finalized = { number: 140n, timestamp: d.typedData.message.deadline + 1n }
		s.onGetLogs = () => {
			s.readerChainId = 1
		}
		await expect(reconcileDeposit(d, l1, M)).rejects.toBeInstanceOf(NetworkMismatchError)
		await expect(reconcileDeposit(d, l1, M)).rejects.toBeInstanceOf(NetworkMismatchError)
		s.readerChainId = M.l1.chainId
		s.onGetLogs = undefined
		const otherRouter = { ...M, l1: { ...M.l1, router: getAddress(a(0xcc)) } }
		await expect(reconcileDeposit(d, l1, otherRouter)).rejects.toBeInstanceOf(NetworkMismatchError)
		expect(await reconcileDeposit(d, l1, M)).toBe("not-deposited")
	})

	it("never trusts a scan boundary another chain reported while the signature was pending", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		s.finalizedHashOverride = pad("0xbad", { size: 32 })
		await submitDeposit(d, l1, M, LIVE)
		s.finalizedHashOverride = undefined
		s.finalized = { number: 140n, timestamp: d.typedData.message.deadline + 1n }
		await expect(reconcileDeposit(d, l1, M)).rejects.toBeInstanceOf(NetworkMismatchError)
	})

	it("a draft never submitted is not-deposited without touching the chain", async () => {
		const d = await draft()
		expect(await reconcileDeposit(d, chain().l1, M)).toBe("not-deposited")
	})
})

describe("withRebuiltTicket", () => {
	const MISSING = [new MessageNotConsumableError(), new Error("Tried to consume nonexistent L1-to-L2 message")]

	/**
	 * A ticket from the first receipt (leaf 42, key 0x4e7), then L1 as `reorg` leaves it; `use` fails on that ticket,
	 * and on any other only when `again`.
	 */
	async function claimAfter(reorg: (s: ReturnType<typeof chain>["s"], d: DepositDraft) => void, first: Error, again = false) {
		const { s, l1 } = chain()
		const d = await draft()
		await submitDeposit(d, l1, M, LIVE)
		const t = ticketFromReceiptLogs(d, [depositLog(d)], M)
		reorg(s, d)
		const events: string[] = []
		const keep = (r: ClaimTicket) => events.push(`keep ${r.leafIndex} ${r.messageHash}`)
		const use = async (r: ClaimTicket) => {
			events.push(`use ${r.leafIndex} ${r.messageHash}`)
			if (r === t || again) throw first
			return "claimed"
		}
		const outcome = await withRebuiltTicket(t, l1, M, keep, use).catch((e: unknown) => e)
		return { outcome, events }
	}
	const remined = (o: { index?: bigint; key?: Hex }) => (s: ReturnType<typeof chain>["s"], d: DepositDraft) =>
		s.receipts.set(TX, { status: "success", logs: [depositLog(d, o)] })
	const KEY = pad("0x4e7")

	it("on a missing message, claims once more with the ticket L1 shows now, stored first, when its leaf or key moved", async () => {
		const moved = pad("0x4e8")
		for (const first of MISSING) {
			for (const [o, leaf, key] of [
				[{ index: 43n }, 43n, KEY],
				[{ key: moved }, 42n, moved],
			] as const) {
				expect(await claimAfter(remined(o), first)).toEqual({
					outcome: "claimed",
					events: [`use 42 ${KEY}`, `keep ${leaf} ${key}`, `use ${leaf} ${key}`],
				})
			}
		}
	})

	it("throws the first failure when L1 shows the same ticket, none yet, or none at all, and never claims a third time", async () => {
		const [first] = MISSING
		const stays = [
			["the same leaf and key", remined({})],
			["pending", (s: ReturnType<typeof chain>["s"]) => s.receipts.delete(TX)],
			[
				"not-deposited",
				(s: ReturnType<typeof chain>["s"], d: DepositDraft) => {
					s.receipts.delete(TX)
					s.finalized = { number: 140n, timestamp: d.typedData.message.deadline + 1n }
				},
			],
		] as const
		for (const [why, reorg] of stays)
			expect(await claimAfter(reorg, first as Error), why).toEqual({ outcome: first, events: [`use 42 ${KEY}`] })
		const again = await claimAfter(remined({ index: 43n }), first as Error, true)
		expect(again.events).toEqual([`use 42 ${KEY}`, `keep 43 ${KEY}`, `use 43 ${KEY}`])
		expect(again.outcome).toBe(first)
	})

	it("claims nothing more when storing the rebuilt ticket fails, and reads L1 on no other failure", async () => {
		const { s, l1 } = chain()
		const d = await draft()
		await submitDeposit(d, l1, M, LIVE)
		const t = ticketFromReceiptLogs(d, [depositLog(d)], M)
		s.receipts.set(TX, { status: "success", logs: [depositLog(d, { index: 43n })] })
		const uses: bigint[] = []
		const failing = async (r: ClaimTicket) => {
			uses.push(r.leafIndex)
			throw new MessageNotConsumableError()
		}
		const full = () => {
			throw new Error("storage full")
		}
		await expect(withRebuiltTicket(t, l1, M, full, failing)).rejects.toThrow("storage full")
		expect(uses).toEqual([42n])
		// A reader on another chain throws from any reconcile, so the plain failure surfacing proves none ran.
		s.readerChainId = 1
		const other = new Error("Balance too low")
		await expect(withRebuiltTicket(t, l1, M, full, () => Promise.reject(other))).rejects.toBe(other)
	})
})

describe("assertPublicRecipient", () => {
	it("passes a switched-on merchant and refuses a user or a switched-off merchant", async () => {
		const [merchant, user, off] = await Promise.all([AztecAddress.random(), AztecAddress.random(), AztecAddress.random()])
		const SETTLED_DELAY = { delay: undefined, scheduledDelay: undefined, delayChangeAt: 0n }
		const list = {
			block: 1,
			at: NOW,
			entries: new Map([
				[merchant.toString(), { ...SETTLED_DELAY, off: false, scheduledOff: false, changeAt: 0n }],
				[off.toString(), { ...SETTLED_DELAY, off: true, scheduledOff: true, changeAt: 0n }],
			]),
		}
		expect(() => assertPublicRecipient(list, merchant)).not.toThrow()
		expect(() => assertPublicRecipient(list, user)).toThrow(PublicDepositToUserError)
		expect(() => assertPublicRecipient(list, off)).toThrow(PublicDepositToUserError)
	})
})
