// @vitest-environment node
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import { type ExitTicket, encodeTicket } from "@galactica-net/inference-money-core"
import { describe, expect, it, vi } from "vitest"
import { MANIFEST, TOUR, WALLETS } from "@/config/network"
import type { PendingExit, Tickets } from "@/demo/tickets"
import type { DemoWallet } from "@/demo/wallet"
import type { LiveCtx } from "./actions"
import { finishPayouts } from "./payouts"

const HASH = TxHash.fromString(`0x${"12".repeat(32)}`)
const TICKET: ExitTicket = {
	l2TxHash: HASH,
	recipient: WALLETS.A_demo,
	amount: 10_000n,
	messageHash: `0x${"0a".repeat(32)}`,
	messageIndexInTx: 0,
}
const EXPIRES = 1_000n

/** What Ethereum and the node say: whether the burn's message is located, and each payout sent. */
const chain = vi.hoisted(() => ({
	paid: 0,
	located: "ticket" as "ticket" | "reverted" | "reverted-unfinalized",
	hold: undefined as Promise<void> | undefined,
}))
vi.mock("@galactica-net/inference-money-core", async (original) => ({
	...(await original<typeof import("@galactica-net/inference-money-core")>()),
	locateWithdrawal: async () => (chain.located === "ticket" ? TICKET : chain.located),
	isExitWithdrawn: async () => false,
	finishWithdrawal: async () => {
		chain.paid++
		await chain.hold
		return `0x${"78".repeat(32)}`
	},
}))

/** A page whose node reports the burn at `status`, with its finalized tip at `finalTs`. */
function ctxWith(status: TxStatus, entries: PendingExit[], finalTs = 0n) {
	const store = new Map(entries.map((e) => [e.id, e]))
	const tickets = {
		exits: () => [...store.values()],
		putExit: (e: PendingExit) => store.set(e.id, e),
		dropExit: (id: string) => store.delete(id),
	} as unknown as Tickets
	const node = {
		getTxReceipt: async () => ({
			status,
			isDropped: () => status === TxStatus.DROPPED,
			isPending: () => status === TxStatus.PENDING,
			isMined: () => status === TxStatus.CHECKPOINTED,
			hasExecutionReverted: () => false,
		}),
		getBlockData: async () => ({ header: { globalVariables: { timestamp: finalTs } } }),
	}
	const demo = { node } as unknown as DemoWallet
	const ctx: LiveCtx = {
		demo,
		m: MANIFEST,
		l1RpcUrl: "http://127.0.0.1:9",
		tickets,
		tour: TOUR,
		explorer: undefined,
		requests: new Map(),
	}
	return { ctx, store }
}

const sent = { l2TxHash: HASH.toString(), recipient: WALLETS.A_demo, amount: "10000", expiresAt: EXPIRES.toString() }
const burned = (o: Partial<PendingExit> = {}): PendingExit => ({ id: "0", actor: "alice", since: 0, sent, ...o })
const pass = (ctx: LiveCtx) => finishPayouts(ctx, WALLETS, () => {})

describe("finishPayouts", () => {
	it("pays out a burn a reload interrupted once checkpointed, and reads a cached one's burn again on every pass", async () => {
		expect(await pass(ctxWith(TxStatus.PENDING, [burned()]).ctx)).toMatchObject([{ amount: 10_000n, state: "proving" }])
		const landed = ctxWith(TxStatus.CHECKPOINTED, [burned()])
		expect([await pass(landed.ctx), chain.paid, landed.store.size]).toEqual([[], 1, 0])
		// A located burn whose checkpoint was pruned away is no longer payable, and not forgotten either.
		const pruned = ctxWith(TxStatus.DROPPED, [burned({ ticket: encodeTicket("exit", TICKET) })], EXPIRES)
		expect([await pass(pruned.ctx), chain.paid]).toMatchObject([[{ state: "stuck", note: /no longer land/ }], 1])
	})

	it("retires a burn only once it can no longer land, and drops reverted or unreadable entries without blocking the rest", async () => {
		const expired = ctxWith(TxStatus.DROPPED, [burned()], EXPIRES + 1n)
		expect([await pass(expired.ctx), expired.store.size]).toEqual([[], 0])
		// A prune can re-include a burn its checkpoint reverted, so it stays listed until that revert is final.
		chain.located = "reverted-unfinalized"
		const reverted = ctxWith(TxStatus.CHECKPOINTED, [burned()])
		expect([await pass(reverted.ctx), reverted.store.size]).toMatchObject([[{ state: "stuck", note: /rejected/ }], 1])
		chain.located = "reverted"
		expect([await pass(reverted.ctx), reverted.store.size]).toEqual([[], 0])
		chain.located = "ticket"
		const before = chain.paid
		const unreadable: PendingExit = { id: "1", actor: "alice", since: 0, ticket: "not a ticket" }
		const tampered: PendingExit = { id: "3", actor: "alice", since: 0, ticket: '{"protocolVersion":2,"kind":"exit","ticket":{}}' }
		const legacy: PendingExit = { id: "2", actor: "alice", since: 1, ticket: encodeTicket("exit", TICKET) }
		const mixed = ctxWith(TxStatus.CHECKPOINTED, [unreadable, tampered, legacy])
		expect([await pass(mixed.ctx), chain.paid - before, mixed.store.size]).toEqual([[], 1, 0])
	})

	it("runs one pass at a time, page-wide, so overlapping checks send a payout once", async () => {
		const { ctx } = ctxWith(TxStatus.CHECKPOINTED, [burned()])
		const before = chain.paid
		let release = () => {}
		chain.hold = new Promise<void>((r) => {
			release = r
		})
		const first = pass(ctx)
		const second = pass(ctx)
		await vi.waitFor(() => expect(chain.paid - before).toBe(1))
		release()
		chain.hold = undefined
		await Promise.all([first, second])
		expect(chain.paid - before).toBe(1)
	})
})
