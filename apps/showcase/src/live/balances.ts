import { l2UsdcBalance } from "@galactica-net/inference-money-core"
import { DEMO_SEED, demoL1, resetAmount, usdcOf } from "@galactica-net/inference-money-demo"
import type { Address } from "viem"
import type { Holder } from "@/tour/player"
import type { LiveCtx } from "./actions"
import { LIVE_ACTORS, type ValidDraft } from "./draft"

const privateBalance = (ctx: LiveCtx, who: (typeof LIVE_ACTORS)[number]) =>
	l2UsdcBalance(ctx.demo.wallet, ctx.m, ctx.demo.cast[who].address, "private")

/** Every balance the stage shows: the four private ones this page's wallet decrypts, and three public ones on Ethereum. */
export async function readBalances(ctx: LiveCtx, wallets: Record<"A_demo" | "B_demo", Address>): Promise<Partial<Record<Holder, bigint>>> {
	const reader = demoL1(ctx.l1RpcUrl, ctx.m, "alice")
	const [l2, l1] = await Promise.all([
		Promise.all(LIVE_ACTORS.map((a) => privateBalance(ctx, a))),
		Promise.all([wallets.A_demo, wallets.B_demo, ctx.m.l1.portal].map((w) => usdcOf(reader, ctx.m, w))),
	])
	const out: Partial<Record<Holder, bigint>> = { A_demo: l1[0], B_demo: l1[1], portal: l1[2] }
	LIVE_ACTORS.forEach((a, i) => {
		out[a] = l2[i]
	})
	return out
}

/** The refund that tops alice back up to her starting balance from galactica's, or why there is none to make. */
export async function resetDraft(ctx: LiveCtx): Promise<ValidDraft | string> {
	const [alice, galactica] = await Promise.all([privateBalance(ctx, "alice"), privateBalance(ctx, "galactica")])
	const amount = resetAmount(alice, galactica)
	if (amount > 0n) return { actor: "galactica", action: "send", to: "alice", amount }
	return alice >= DEMO_SEED.alice ? "Alice already holds her starting balance." : "Galactica has nothing left to give back."
}
