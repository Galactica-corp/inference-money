import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import {
	decodeExitTicket,
	type ExitTicket,
	encodeTicket,
	finalFate,
	finishWithdrawal,
	isExitWithdrawn,
	locateWithdrawal,
	outboxReader,
} from "@galactica-net/inference-money-core"
import { demoL1, l1CtxOf, withdrawWorld } from "@galactica-net/inference-money-demo"
import { type Address, isAddressEqual } from "viem"
import type { PendingExit } from "@/demo/tickets"
import { oneAtATime } from "@/lib/one-at-a-time"
import { type FeedRow, PUBLIC_TEXT } from "@/tour/player"
import type { LiveCtx } from "./actions"

/** A withdrawal burned on Aztec whose Ethereum payout is still to come. */
export interface Payout {
	id: string
	recipient: Address
	amount: bigint
	/** Waiting for Ethereum to accept the proof of its block, or stuck for a reason the page shows. */
	state: "proving" | "stuck"
	note?: string
}

/** Not proven yet: one poll, never a wait, so a page check stays short. */
const ONE_POLL = { timeoutMs: 0 }
const NOT_PROVEN = /not proven on Ethereum yet/
const CHECKPOINTED: readonly TxStatus[] = [TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.FINALIZED]
const NOTE = {
	unknown: "Aztec does not hold this burn right now; it stays listed until it can no longer land.",
	rejected: "Aztec rejected this burn, so nothing left the account; it stays listed until that is final.",
}

/** The codec revives whatever JSON it holds, so a tampered ticket decodes too: it must hold what the page reads. */
function decoded(ticket: string | undefined): ExitTicket | undefined {
	try {
		const t = ticket === undefined ? undefined : decodeExitTicket(ticket)
		const whole = t?.l2TxHash instanceof TxHash && typeof t.recipient === "string" && typeof t.amount === "bigint"
		return whole && typeof t.messageHash === "string" && Number.isInteger(t.messageIndexInTx) ? t : undefined
	} catch {
		return undefined
	}
}

/**
 * Where `p`'s burn stands, read again on every pass: a pruned checkpoint can undo a burn located before, or a revert.
 * One the node does not hold is retired only once `finalFate` proves it gone (a finalized block past its expiry, read
 * first), and a reverted one only once its block is finalized.
 */
async function locate(ctx: LiveCtx, p: PendingExit, sent: NonNullable<PendingExit["sent"]>) {
	const hash = TxHash.fromString(sent.l2TxHash)
	const fate = await finalFate(ctx.demo.node, sent.l2TxHash, BigInt(sent.expiresAt))
	const receipt = await ctx.demo.node.getTxReceipt(hash)
	if (receipt.isDropped()) return fate === "gone" ? "none" : "unknown"
	if (!CHECKPOINTED.includes(receipt.status)) return "waiting"
	const cached = decoded(p.ticket)
	if (cached) return cached
	const found = await locateWithdrawal(sent.recipient as Address, BigInt(sent.amount), hash, ctx.demo.node, ctx.m)
	if (found === "reverted") return "none"
	if (found === "reverted-unfinalized") return "rejected"
	ctx.tickets.putExit({ ...p, ticket: encodeTicket("exit", found) })
	return found
}

/** Pays `t` out if its proof is on Ethereum, from the recipient's own demo wallet, which holds gas. */
async function pay(ctx: LiveCtx, wallets: Record<"A_demo" | "B_demo", Address>, t: ExitTicket, onRow: (row: FeedRow) => void) {
	const signer = demoL1(ctx.l1RpcUrl, ctx.m, isAddressEqual(t.recipient, wallets.B_demo) ? "bob" : "alice")
	const outbox = outboxReader(signer.publicClient, ctx.m.l1.outbox)
	if (await isExitWithdrawn(t, ctx.demo.node, outbox)) return
	const hash = await finishWithdrawal(t, ctx.demo.node, outbox, l1CtxOf(signer), ctx.m, undefined, ONE_POLL)
	const href = ctx.explorer && `${ctx.explorer.l1Tx}${hash}`
	onRow({ key: hash, source: "live", chain: "ethereum", text: PUBLIC_TEXT.withdraw, items: withdrawWorld(t.recipient, t.amount), href })
}

/** Pays `p` out when it can; else what the page shows of it. An entry naming nothing readable is dropped. */
async function payOne(
	ctx: LiveCtx,
	wallets: Record<"A_demo" | "B_demo", Address>,
	p: PendingExit,
	onRow: (row: FeedRow) => void,
): Promise<Payout | undefined> {
	const legacy = p.sent ? undefined : decoded(p.ticket)
	const named = p.sent ?? legacy
	if (!named) {
		ctx.tickets.dropExit(p.id)
		return undefined
	}
	const shown = { id: p.id, recipient: named.recipient as Address, amount: BigInt(named.amount) }
	try {
		const where = p.sent ? await locate(ctx, p, p.sent) : (legacy as ExitTicket)
		if (where === "waiting") return { ...shown, state: "proving" }
		if (where === "unknown" || where === "rejected") return { ...shown, state: "stuck", note: NOTE[where] }
		if (where !== "none") await pay(ctx, wallets, where, onRow)
		ctx.tickets.dropExit(p.id)
		return undefined
	} catch (e) {
		const text = e instanceof Error ? e.message : String(e)
		const proving = NOT_PROVEN.test(text)
		return { ...shown, state: proving ? "proving" : "stuck", note: proving ? undefined : text }
	}
}

/** Page-wide: two passes, from a poll and a run or from two mounts of live mode, would each send a payout. */
const onePass = oneAtATime()

/** Pays out every pending withdrawal that can be; returns the ones still to come. One already paid elsewhere is dropped. */
export function finishPayouts(
	ctx: LiveCtx,
	wallets: Record<"A_demo" | "B_demo", Address>,
	onRow: (row: FeedRow) => void,
): Promise<Payout[]> {
	return onePass(async () => {
		const left: Payout[] = []
		for (const p of ctx.tickets.exits()) {
			const still = await payOne(ctx, wallets, p, onRow)
			if (still) left.push(still)
		}
		return left
	})
}
