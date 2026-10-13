import type { Actor } from "@inference-money/demo"
import { parseUsdc } from "@/demo/amount"
import type { Holder } from "@/tour/player"
import type { SceneId } from "@/tour/scenes"

export const LIVE_ACTORS: readonly Actor[] = ["alice", "bob", "galactica", "supplier"]
const USERS: readonly Actor[] = ["alice", "bob"]
export const isUserActor = (a: Actor): boolean => USERS.includes(a)

export const LIVE_ACTIONS = ["deposit", "claim", "request", "pay", "send", "withdraw"] as const
export type LiveAction = (typeof LIVE_ACTIONS)[number]

export const ACTION_LABEL: Record<LiveAction, string> = {
	deposit: "Deposit from Ethereum",
	claim: "Claim a deposit",
	request: "Open a payment request",
	pay: "Pay a request",
	send: "Send privately",
	withdraw: "Withdraw to Ethereum",
}

export const DEPOSITS_CLOSED =
	"Deposits are closed. Aztec has moved to a new rollup, and this bridge stays on the one it was deployed on. Claims, payments, transfers and withdrawals still work while that rollup runs."

/** What the composer holds: the amount as typed, so validation can say what is wrong with it. */
export interface Draft {
	actor: Actor
	action: LiveAction
	to: Holder
	amount: string
}

/** A draft that passed {@link validate}: `amount` is set exactly when the action moves a chosen amount. */
export interface ValidDraft extends Omit<Draft, "amount"> {
	amount?: bigint
}

/** Only alice and bob have Ethereum wallets with demo funds, so only they deposit and claim. */
export const actionsFor = (actor: Actor): readonly LiveAction[] =>
	isUserActor(actor) ? LIVE_ACTIONS : LIVE_ACTIONS.filter((a) => a !== "deposit" && a !== "claim")

/** Who an action can name: the actor's own account for a deposit or claim, an Ethereum wallet for a withdrawal. */
export function targetsOf(actor: Actor, action: LiveAction): readonly Holder[] {
	if (action === "deposit" || action === "claim") return [actor]
	if (action === "withdraw") return ["A_demo", "B_demo"]
	return LIVE_ACTORS.filter((a) => a !== actor)
}

/** A claim takes its deposit's amount, and a request carries none. */
export const needsAmount = (action: LiveAction): boolean => action !== "claim" && action !== "request"

/** Keeps a draft consistent after one of its fields changes: an action the actor lacks, or a target it cannot name, resets. */
export function settle(d: Draft): Draft {
	const actions = actionsFor(d.actor)
	const action = actions.includes(d.action) ? d.action : (actions[0] as LiveAction)
	const targets = targetsOf(d.actor, action)
	return { ...d, action, to: targets.includes(d.to) ? d.to : (targets[0] as Holder) }
}

export function validate(d: Draft): { ok: true; draft: ValidDraft } | { ok: false; error: string } {
	if (!actionsFor(d.actor).includes(d.action)) return { ok: false, error: "Only Alice and Bob have funded Ethereum wallets here." }
	if (!targetsOf(d.actor, d.action).includes(d.to)) return { ok: false, error: "Pick who this goes to." }
	if (!needsAmount(d.action)) return { ok: true, draft: { actor: d.actor, action: d.action, to: d.to } }
	const amount = parseUsdc(d.amount)
	if (!amount.ok) return { ok: false, error: amount.error }
	return { ok: true, draft: { actor: d.actor, action: d.action, to: d.to, amount: amount.value } }
}

/**
 * Each scene's live version, at a hundredth of the recorded amounts: every visitor shares the demo float. "Pay a
 * session" pays a request galactica opens for it, as the merchant's server would.
 */
export const PRESETS: Record<SceneId, Draft> = {
	deposit: { actor: "alice", action: "deposit", to: "alice", amount: "0.10" },
	claim: { actor: "alice", action: "claim", to: "alice", amount: "" },
	pay: { actor: "alice", action: "pay", to: "galactica", amount: "0.10" },
	refund: { actor: "galactica", action: "send", to: "alice", amount: "0.03" },
	"pay-a-friend": { actor: "alice", action: "send", to: "bob", amount: "0.01" },
	"cash-out": { actor: "alice", action: "withdraw", to: "B_demo", amount: "0.01" },
	withdraw: { actor: "alice", action: "withdraw", to: "A_demo", amount: "0.03" },
}

/** The users' Ethereum wallets: A_demo is alice's, B_demo bob's. */
export const walletOf = (user: Actor): Holder => (user === "alice" ? "A_demo" : "B_demo")

/** The coin's trip for a draft. A request moves no money, so its coin carries the word instead. */
export function tripOf(d: ValidDraft): { from: Holder; to: Holder } {
	if (d.action === "deposit") return { from: walletOf(d.actor), to: "portal" }
	if (d.action === "claim") return { from: "portal", to: d.actor }
	return { from: d.actor, to: d.to }
}
