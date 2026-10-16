// @vitest-environment node
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { type ClaimTicket, encodeTicket, memoryPaymentStore, PaymentGate } from "@galactica-net/inference-money-core"
import type { SentTx } from "@galactica-net/inference-money-demo"
import { describe, expect, it, vi } from "vitest"
import { MANIFEST, TOUR, WALLETS } from "@/config/network"
import type { PendingDeposit, Tickets } from "@/demo/tickets"
import type { DemoWallet } from "@/demo/wallet"
import { oneAtATime } from "@/lib/one-at-a-time"
import type { LiveCtx } from "./actions"
import { archivedDeposits, recheckDeposit, replay, runDraft, withConflictRetry } from "./actions"
import { DEPOSITS_CLOSED } from "./draft"
import type { Outcome } from "./outcome"

/** Requests the page opened, in order, each held open until `hold` settles. */
const requests = vi.hoisted(() => ({ order: [] as string[], hold: undefined as Promise<void> | undefined }))
/**
 * The commitments payments went into, and how the next are refused: by `PaymentRefusedError` reasons in order, then,
 * with `refuse`, on the payment rule, by the client's list before sending ("list") or in a node's reply ("text").
 */
const payments = vi.hoisted(() => ({ refuse: undefined as "list" | "text" | undefined, refusals: [] as string[], into: [] as unknown[] }))

/** Where a claim this page made stands on L2, and how many claims it sent. */
const claims = vi.hoisted(() => ({
	state: "checkpointed" as "proposed" | "checkpointed" | "finalized" | "pruned",
	sent: 0,
	result: "claimed" as "claimed" | "already",
	binding: "matches" as "binds" | "matches",
	consent: undefined as unknown,
	/** A ticket the next claim rebuilds, as a reorg that moved the deposit's Inbox message would make it. */
	rebuilt: undefined as unknown,
}))

const portal = vi.hoisted(() => ({ open: true, deposits: 0 }))

/** What the L1 reader answers for each stored draft, by its text: a verdict, or "found" for its ticket. */
const deposits = vi.hoisted(() => ({ verdicts: new Map<string, string>() }))

// A deposit this page sent is still unconfirmed on Ethereum unless `deposits` says otherwise (a "broken" one cannot
// even be read back); a claim ticket's nullifier is wherever `claims` says.
vi.mock("@galactica-net/inference-money-core", async (original) => {
	const real = await original<typeof import("@galactica-net/inference-money-core")>()
	const { Fr } = await import("@aztec-labs/aztec.js/fields")
	const { AztecAddress } = await import("@aztec-labs/aztec.js/addresses")
	const intent = { recipient: AztecAddress.ZERO, amount: 10_000n, kind: "private" }
	const ticket = { messageHash: "0x01", leafIndex: 1n, depositor: "0xd", draft: { secretOrSalt: Fr.ZERO, intent } }
	return {
		...real,
		decodeDepositDraft: (s: string) => ({ marker: s }),
		reconcileDeposit: async (d: { marker: string }) => {
			if (d.marker === "broken") throw new Error("Cannot read properties of undefined (reading 'message')")
			const verdict = deposits.verdicts.get(d.marker) ?? "pending"
			return verdict === "found" ? { ...ticket, draft: d } : verdict
		},
		decodeClaimTicket: (s: string) => {
			if (s === "unreadable") throw new Error("not a claim ticket")
			if (s === "tampered") return { ...ticket, messageHash: undefined }
			return ticket
		},
		syncMerchantList: async () => ({}),
		depositsOpen: async () => portal.open,
		claimBinding: async () => claims.binding,
		openRequest: async () => {
			requests.order.push("open")
			await requests.hold
			requests.order.push("opened")
			return { commitment: 1 }
		},
		payRequest: async (_gate: unknown, _wallet: unknown, _token: unknown, p: { commitment: unknown }) => {
			payments.into.push(p.commitment)
			const reason = payments.refusals.shift()
			if (reason) throw new real.PaymentRefusedError(reason as never)
			if (payments.refuse === "list") throw new real.ListRefusal(real.TOKEN_REFUSALS.payment)
			if (payments.refuse === "text") throw new Error(real.TOKEN_REFUSALS.payment)
		},
		// Each tip holds the blocks of the tips after it: a proposed claim shows only at "proposed", a pruned one nowhere.
		isClaimConsumed: async (_t: unknown, _node: unknown, _m: unknown, at = "checkpointed") => {
			const tips = ["proposed", "checkpointed", "finalized"]
			return tips.indexOf(claims.state) >= tips.indexOf(at)
		},
	}
})
vi.mock("@galactica-net/inference-money-demo", async (original) => ({
	...(await original<typeof import("@galactica-net/inference-money-demo")>()),
	castClaim: async (_s: unknown, _t: unknown, _on: unknown, consent: unknown, rebuild?: { keep(t: unknown): void }) => {
		claims.sent++
		claims.consent = consent
		if (claims.rebuilt) rebuild?.keep(claims.rebuilt)
		return claims.result
	},
	castDeposit: async () => {
		portal.deposits++
		throw new Error("no deposit flow in these tests")
	},
}))

const HASH = `0x${"12".repeat(32)}`

/** A context whose node knows one tx, landed (proposed, succeeded) or dropped, and finalizes at `finalizedAt`. */
function ctxWith(landed: boolean, finalizedAt = 0n): LiveCtx {
	return ctxWithReceipt(landed ? TxStatus.PROPOSED : TxStatus.DROPPED, landed, finalizedAt)
}

/** The node's one tx has `status`, and executed or reverted; blocks finalize at `finalizedAt`. */
function ctxWithReceipt(status: TxStatus, succeeded: boolean, finalizedAt = 0n): LiveCtx {
	const sent: SentTx[] = []
	const mined = status !== TxStatus.DROPPED
	const receipt = {
		status,
		isPending: () => false,
		isDropped: () => !mined,
		isMined: () => mined,
		hasExecutionSucceeded: () => mined && succeeded,
		hasExecutionReverted: () => mined && !succeeded,
	}
	const node = {
		getTxReceipt: async () => receipt,
		getTxEffect: async () => undefined,
		getBlockData: async () => ({ header: { globalVariables: { timestamp: finalizedAt } } }),
	}
	const demo = { sent, node, exclusive: oneAtATime() } as unknown as DemoWallet
	return {
		demo,
		m: MANIFEST,
		l1RpcUrl: "http://127.0.0.1:9",
		tickets: undefined as never,
		tour: TOUR,
		explorer: undefined,
		requests: new Map(),
	}
}

const send = (ctx: LiveCtx, expiresAt = 0n, refused?: true) =>
	ctx.demo.sent.push({ hash: HASH, feePayer: "0x0", expiresAt, anchorTs: 0n, ...(refused && { refused }) })
const DONE: Outcome = { kind: "settled", detail: "done", rows: [] }

describe("withConflictRetry", () => {
	it("settles on a send whose earlier copy landed, without sending again", async () => {
		const ctx = ctxWith(true)
		let attempts = 0
		const outcome = await withConflictRetry(ctx, async () => {
			attempts++
			send(ctx)
			throw new Error("Tx dropped: Existing nullifier")
		}, ["transfer"])
		expect([attempts, outcome.kind, outcome.kind === "settled" && outcome.detail]).toEqual([
			1,
			"settled",
			"It went through: the network had it already.",
		])
	})

	it("sends a one-send action again only once its first try provably cannot land", async () => {
		// The node doesn't hold the first try, which expires at 10: proven gone only by a finalized block past its expiry.
		// A drop (a lost response) or the node's outright refusal is its word alone.
		for (const [refused, finalizedAt, retried] of [
			[undefined, 10n, false],
			[undefined, 11n, true],
			[true, 10n, false],
			[true, 11n, true],
		] as const) {
			const ctx = ctxWith(false, finalizedAt)
			let attempts = 0
			const outcome = await withConflictRetry(ctx, async () => {
				if (attempts++ > 0) return DONE
				send(ctx, 10n, refused)
				throw new Error("Invalid tx: Existing nullifier")
			}, ["transfer"])
			if (retried) expect([attempts, outcome]).toEqual([2, DONE])
			else expect([attempts, outcome]).toEqual([1, { kind: "failed", detail: expect.stringMatching(/may still take the first try/) }])
		}
	})

	it("sends again after a reverted first try only once the revert is final, since a prune can undo it", async () => {
		for (const [status, retried] of [
			[TxStatus.PROPOSED, false],
			[TxStatus.CHECKPOINTED, false],
			[TxStatus.FINALIZED, true],
		] as const) {
			const ctx = ctxWithReceipt(status, false)
			let attempts = 0
			const outcome = await withConflictRetry(ctx, async () => {
				if (attempts++ > 0) return DONE
				send(ctx, 10n)
				throw new Error("Existing nullifier")
			}, ["transfer"])
			if (retried) expect([attempts, outcome]).toEqual([2, DONE])
			else expect([attempts, outcome]).toEqual([1, { kind: "failed", detail: expect.stringMatching(/may still take the first try/) }])
		}
	})

	it("leaves a payment that sent anything unconfirmed, runs once more on a conflict found before sending, never re-runs a deposit", async () => {
		for (const landed of [false, true]) {
			const ctx = ctxWith(landed)
			let attempts = 0
			const outcome = await withConflictRetry(ctx, async () => {
				if (attempts++ > 0) return DONE
				send(ctx)
				throw new Error("Duplicate nullifier in tx")
			}, ["request", "pay"])
			expect([attempts, outcome]).toEqual([1, { kind: "failed", detail: expect.stringMatching(/may still take the first try/) }])
		}
		for (const [kinds, outcome, runs] of [
			[["request", "pay"], DONE, 2],
			[[], "Existing nullifier", 1],
		] as const) {
			let attempts = 0
			const result = await withConflictRetry(
				ctxWith(false),
				async () => {
					if (attempts++ > 0) return DONE
					throw new Error("Existing nullifier")
				},
				kinds,
			).catch((e: Error) => e.message)
			expect([result, attempts], `kinds [${kinds}]`).toEqual([outcome, runs])
		}
		const ctx = ctxWith(false)
		const twice = withConflictRetry(ctx, async () => Promise.reject(new Error("Existing nullifier")), ["transfer"])
		await expect(twice).rejects.toThrow("Existing nullifier")
		await expect(withConflictRetry(ctx, async () => Promise.reject(new Error("Balance too low")), ["transfer"])).rejects.toThrow(
			"Balance too low",
		)
	})
})

describe("replay", () => {
	it("plays the recorded step, labelled recorded, and says why the live one could not run", () => {
		const outcome = replay(ctxWith(false), "deposit", "This Ethereum wallet holds 0.00 demo USDC, less than that.")
		expect(outcome).toMatchObject({
			kind: "settled",
			detail: /less than that\. This replays the recorded run instead, so nothing moved now\.$/,
		})
		expect(outcome.kind === "settled" && outcome.rows.map((r) => [r.key, r.source])).toEqual([["deposit", "recorded"]])
	})
})

describe("deposit", () => {
	it("re-reads the portal first: a rollup switch since the page opened refuses it before any read or signature", async () => {
		portal.open = false
		// Nothing listens there: a balance read or a signature would fail with a connection error instead.
		const ctx: LiveCtx = { ...ctxWith(false), l1RpcUrl: "http://127.0.0.1:9" }
		const outcome = await runDraft(ctx, { actor: "bob", action: "deposit", to: "bob", amount: 10_000n }, WALLETS, () => {})
		expect([outcome, portal.deposits]).toEqual([{ kind: "failed", detail: DEPOSITS_CLOSED }, 0])
		portal.open = true
	})
})

describe("claim", () => {
	it("replays the recorded claim only when this page has nothing pending, and waits on its own deposit", async () => {
		const pending: PendingDeposit[] = [{ id: "d1", user: "alice", since: 0, draft: "sent, not yet mined" }]
		const tickets = { deposits: () => pending, dropDeposit: () => {}, putDeposit: () => {} } as unknown as Tickets
		// viem refuses an empty URL; nothing dials it, since the reconcile is mocked.
		const ctx: LiveCtx = { ...ctxWith(false), l1RpcUrl: "http://127.0.0.1:9", tickets }
		const claim = () => runDraft(ctx, { actor: "alice", action: "claim", to: "alice" }, WALLETS, () => {})
		expect(await claim()).toEqual({ kind: "failed", detail: "That deposit is still confirming on Ethereum; try again in a minute." })
		pending.length = 0
		const outcome = await claim()
		expect(outcome.kind === "settled" && outcome.rows.map((r) => [r.key, r.source])).toEqual([["claim", "recorded"]])
	})

	it("never offers a claim already proposed, keeps its secret until it is final, and claims again once pruned", async () => {
		const store = new Map<string, PendingDeposit>([["d1", { id: "d1", user: "bob", since: 0, claim: "ticket", claimed: true }]])
		const tickets = {
			deposits: () => [...store.values()],
			putDeposit: (d: PendingDeposit) => store.set(d.id, d),
			dropDeposit: (id: string) => store.delete(id),
		} as unknown as Tickets
		const ctx: LiveCtx = { ...ctxWith(false), tickets }
		const claim = () => runDraft(ctx, { actor: "bob", action: "claim", to: "bob" }, WALLETS, () => {})
		const nothing = { kind: "failed", detail: "There is nothing to claim: deposit first." }
		for (const state of ["proposed", "checkpointed"] as const) {
			claims.state = state
			expect([await claim(), store.has("d1")]).toEqual([nothing, true])
		}
		claims.state = "pruned"
		expect((await claim()).kind).toBe("settled")
		expect([claims.sent, store.get("d1")?.claimed]).toEqual([1, true])
		claims.state = "finalized"
		expect([await claim(), store.get("d1")]).toEqual([
			nothing,
			{ id: "d1", user: "bob", since: 0, claim: "ticket", claimed: true, final: true },
		])
		store.set("d2", { id: "d2", user: "bob", since: 1, claim: "unreadable" })
		store.set("d4", { id: "d4", user: "bob", since: 1, claim: "tampered" })
		store.set("d3", { id: "d3", user: "bob", since: 2, claim: "ticket" })
		claims.state = "pruned"
		expect([(await claim()).kind, claims.sent, [...store.keys()]]).toEqual(["settled", 2, ["d1", "d3"]])
	})

	it("keeps a ticket's secret when the node calls final a claim this page never sent", async () => {
		const store = new Map<string, PendingDeposit>([["d1", { id: "d1", user: "bob", since: 0, claim: "ticket" }]])
		const tickets = {
			deposits: () => [...store.values()],
			putDeposit: (d: PendingDeposit) => store.set(d.id, d),
			dropDeposit: (id: string) => store.delete(id),
		} as unknown as Tickets
		const claim = () => runDraft({ ...ctxWith(false), tickets }, { actor: "bob", action: "claim", to: "bob" }, WALLETS, () => {})
		Object.assign(claims, { state: "finalized", result: "already" })
		try {
			expect((await claim()).kind).toBe("settled")
			expect(await claim()).toEqual({ kind: "failed", detail: "There is nothing to claim: deposit first." })
			expect(store.get("d1")).toEqual({ id: "d1", user: "bob", since: 0, claim: "ticket", claimed: true, final: true })
		} finally {
			claims.result = "claimed"
		}
	})

	it("archives a deposit Ethereum does not show, never offers it, and a re-check moves it on or keeps it, salt intact", async () => {
		const archived: PendingDeposit = { id: "a1", user: "bob", since: 0, draft: "gone", archived: true }
		const store = new Map<string, PendingDeposit>([["a1", { id: "a1", user: "bob", since: 0, draft: "gone" }]])
		const tickets = {
			deposits: () => [...store.values()],
			putDeposit: (d: PendingDeposit) => store.set(d.id, d),
			dropDeposit: (id: string) => store.delete(id),
		} as unknown as Tickets
		const ctx: LiveCtx = { ...ctxWith(false), l1RpcUrl: "http://127.0.0.1:9", tickets }
		const claim = () => runDraft(ctx, { actor: "bob", action: "claim", to: "bob" }, WALLETS, () => {})
		deposits.verdicts.set("gone", "not-deposited")
		try {
			expect(await claim()).toEqual({ kind: "failed", detail: expect.stringContaining("keeps its record below") })
			expect(store.get("a1")).toEqual(archived)
			expect(await claim()).toEqual({ kind: "failed", detail: "There is nothing to claim: deposit first." })
			expect(archivedDeposits(ctx)).toEqual([{ id: "a1", user: "bob", amount: undefined }])
			for (const [verdict, after] of [
				["not-deposited", ["gone", true, undefined]],
				["pending", ["gone", undefined, undefined]],
				["found", [undefined, undefined, "gone"]],
			] as const) {
				store.set("a1", archived)
				deposits.verdicts.set("gone", verdict)
				await recheckDeposit(ctx, "a1")
				const p = store.get("a1")
				const salt = p?.claim && (JSON.parse(p.claim) as { ticket: { draft: { marker: string } } }).ticket.draft.marker
				expect([p?.draft, p?.archived, salt], verdict).toEqual([...after])
			}
			store.set("a1", { ...archived, final: true, archived: undefined })
			const gone = "There is nothing to check there any more."
			expect([await recheckDeposit(ctx, "a1"), await recheckDeposit(ctx, "missing")]).toEqual([gone, gone])
		} finally {
			deposits.verdicts.clear()
		}
	})

	it("asks before a first claim binds the account: a decline sends nothing and keeps the ticket, an accept consents", async () => {
		const store = new Map<string, PendingDeposit>([["d1", { id: "d1", user: "bob", since: 0, claim: "ticket" }]])
		const tickets = {
			deposits: () => [...store.values()],
			putDeposit: (d: PendingDeposit) => store.set(d.id, d),
			dropDeposit: (id: string) => store.delete(id),
		} as unknown as Tickets
		const questions: string[] = []
		let accept = false
		const confirm = (q: string) => questions.push(q) > 0 && accept
		const ctx: LiveCtx = { ...ctxWith(false), tickets, confirm }
		const claim = () => runDraft(ctx, { actor: "bob", action: "claim", to: "bob" }, WALLETS, () => {})
		Object.assign(claims, { state: "pruned", binding: "binds" })
		const sent = claims.sent
		expect(await claim()).toEqual({ kind: "failed", detail: "Nothing claimed: the binding was declined." })
		expect([claims.sent - sent, store.get("d1")?.claimed]).toEqual([0, undefined])
		expect(questions).toEqual([expect.stringContaining("for good, to 0xd (the address it came from)")])
		accept = true
		expect((await claim()).kind).toBe("settled")
		expect([claims.sent - sent, claims.consent]).toEqual([1, { allowBind: true }])
		claims.binding = "matches"
	})

	it("never reports a mint for a message something consumed before, and keeps its secret until that is final", async () => {
		const store = new Map<string, PendingDeposit>([["d1", { id: "d1", user: "bob", since: 0, claim: "ticket" }]])
		const tickets = {
			deposits: () => [...store.values()],
			putDeposit: (d: PendingDeposit) => store.set(d.id, d),
			dropDeposit: (id: string) => store.delete(id),
		} as unknown as Tickets
		claims.state = "pruned"
		claims.result = "already"
		try {
			const outcome = await runDraft({ ...ctxWith(false), tickets }, { actor: "bob", action: "claim", to: "bob" }, WALLETS, () => {})
			expect([outcome, store.get("d1")?.claimed]).toEqual([
				{
					kind: "settled",
					detail: "That deposit was already taken on Aztec, by an earlier claim or a return, so nothing was minted now.",
					rows: [],
				},
				true,
			])
		} finally {
			claims.result = "claimed"
		}
	})

	it("stores a ticket its claim rebuilt in place of the old one, and marks that one claimed", async () => {
		const store = new Map<string, PendingDeposit>([["d1", { id: "d1", user: "bob", since: 0, claim: "ticket" }]])
		const tickets = {
			deposits: () => [...store.values()],
			putDeposit: (d: PendingDeposit) => store.set(d.id, d),
			dropDeposit: (id: string) => store.delete(id),
		} as unknown as Tickets
		const rebuilt = { messageHash: "0x02", leafIndex: 2n, depositor: "0xd", draft: { marker: "moved" } } as unknown as ClaimTicket
		Object.assign(claims, { state: "pruned", rebuilt })
		try {
			expect(
				(await runDraft({ ...ctxWith(false), tickets }, { actor: "bob", action: "claim", to: "bob" }, WALLETS, () => {})).kind,
			).toBe("settled")
			expect(store.get("d1")).toEqual({ id: "d1", user: "bob", since: 0, claim: encodeTicket("claim", rebuilt), claimed: true })
		} finally {
			claims.rebuilt = undefined
		}
	})

	it("never lets a deposit still confirming, or one it cannot read back right now, hold up the claims after it", async () => {
		const store = new Map<string, PendingDeposit>([
			["b0", { id: "b0", user: "bob", since: -1, draft: "confirming" }],
			["b1", { id: "b1", user: "bob", since: 0, draft: "broken" }],
			["b2", { id: "b2", user: "bob", since: 1, claim: "ticket" }],
		])
		const tickets = {
			deposits: () => [...store.values()],
			putDeposit: (d: PendingDeposit) => store.set(d.id, d),
			dropDeposit: (id: string) => store.delete(id),
		} as unknown as Tickets
		const ctx: LiveCtx = { ...ctxWith(false), tickets }
		const before = claims.sent
		expect((await runDraft(ctx, { actor: "bob", action: "claim", to: "bob" }, WALLETS, () => {})).kind).toBe("settled")
		expect([claims.sent - before, [...store.keys()], store.get("b2")?.claimed]).toEqual([1, ["b0", "b1", "b2"], true])
	})
})

describe("runDraft", () => {
	it("runs one live action at a time, page-wide, as a remount of live mode would otherwise start a second", async () => {
		const base = ctxWith(false)
		const cast = { galactica: { address: "0xg" }, alice: { address: "0xa" } }
		const ctx: LiveCtx = { ...base, demo: { ...base.demo, cast } as unknown as DemoWallet }
		let release = () => {}
		requests.hold = new Promise<void>((r) => {
			release = r
		})
		const draft = { actor: "galactica", action: "request", to: "alice" } as const
		const runs = [runDraft(ctx, draft, WALLETS, () => {}), runDraft(ctx, draft, WALLETS, () => {})]
		await vi.waitFor(() => expect(requests.order).toEqual(["open"]))
		release()
		requests.hold = undefined
		await Promise.all(runs)
		expect(requests.order).toEqual(["open", "opened", "open", "opened"])
	})

	it("forgets a request only when its own list refused paying it before any send, so the next payment opens a fresh one", async () => {
		const base = ctxWith(false)
		const cast = { galactica: { address: "0xg" }, alice: { address: "0xa" } }
		const ctx: LiveCtx = { ...base, demo: { ...base.demo, cast } as unknown as DemoWallet }
		ctx.requests.set("galactica>alice", 1 as never)
		const pay = { actor: "alice", action: "pay", to: "galactica", amount: 10_000n } as const
		try {
			payments.refuse = "text"
			expect([(await runDraft(ctx, pay, WALLETS, () => {})).kind, ctx.requests.size], "a reply's text").toEqual(["refused", 1])
			payments.refuse = "list"
			expect([(await runDraft(ctx, pay, WALLETS, () => {})).kind, ctx.requests.size]).toEqual(["refused", 0])
		} finally {
			payments.refuse = undefined
		}
		const opened = requests.order.length
		expect((await runDraft(ctx, pay, WALLETS, () => {})).kind).toBe("settled")
		expect(requests.order.slice(opened)).toEqual(["open", "opened"])
	})

	it.each([
		["stale", "replaces it and pays the new one in the same action", ["open", "opened"], [2, 1], "settled"],
		["in-flight", "opens nothing and pays nothing more while its first payment may land", [], [2], "failed"],
	] as const)("a stored request refused as %s: %s", async (reason, _, opens, into, kind) => {
		const base = ctxWith(false)
		const cast = { galactica: { address: "0xg" }, alice: { address: "0xa" } }
		const gate = new PaymentGate(base.demo.node, memoryPaymentStore())
		const ctx: LiveCtx = { ...base, demo: { ...base.demo, cast, gate } as unknown as DemoWallet }
		ctx.requests.set("galactica>alice", 2 as never)
		const pay = { actor: "alice", action: "pay", to: "galactica", amount: 10_000n } as const
		payments.refusals.push(reason)
		payments.into.length = 0
		const opened = requests.order.length
		expect((await runDraft(ctx, pay, WALLETS, () => {})).kind).toBe(kind)
		expect([requests.order.slice(opened), payments.into]).toEqual([opens, into])
		expect(ctx.requests.get("galactica>alice")).toBe(kind === "settled" ? undefined : (2 as never))
	})
})
