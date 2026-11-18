import type { TOUR_ACTORS, TourStepId } from "@galactica-net/inference-money-demo/tour"

/** A balance the stage shows: a cast member's, A_demo's or B_demo's, or the portal's escrow. */
export type Holder = (typeof TOUR_ACTORS)[number] | "portal"

export type SceneId = "deposit" | "claim" | "pay" | "refund" | "pay-a-friend" | "cash-out" | "withdraw"

/** One chip of the showcase: the tour entries it plays, in order, and what it shows in plain words. */
export interface Scene {
	id: SceneId
	label: string
	steps: readonly TourStepId[]
	/** The rules refuse it: it sits among the cheats. */
	cheat: boolean
	/** An Aztec transaction is proven; an Ethereum-only one has nothing to prove. */
	proves: boolean
	/** Who does what, in the composer's words. */
	actorLabel: string
	actionLabel: string
	toLabel: string
	/** What is about to happen, given the amount as the stage shows it. */
	intro: (usdc: string) => string
	/** Why it settles, or why the rules refuse it, by role. */
	why: string
	/** The coin's trip on the stage. */
	from: Holder
	to: Holder
}

/** In the recording's order. */
export const SCENES: readonly Scene[] = [
	{
		id: "deposit",
		label: "Deposit",
		steps: ["deposit"],
		cheat: false,
		proves: false,
		actorLabel: "Alice's Ethereum wallet",
		actionLabel: "Deposit from Ethereum",
		toLabel: "Alice",
		intro: (u) => `Alice's Ethereum wallet puts ${u} USDC into the portal, for Alice's private account.`,
		why: "Anyone can deposit. The portal writes the depositing address into the message.",
		from: "A_demo",
		to: "portal",
	},
	{
		id: "claim",
		label: "Claim",
		steps: ["claim"],
		cheat: false,
		proves: true,
		actorLabel: "Alice",
		actionLabel: "Claim the deposit",
		toLabel: "Alice",
		intro: (u) => `Alice claims the ${u} USDC on Aztec.`,
		why: "The deposit came from Alice's funding address, the one her account is bound to, so she can claim it.",
		from: "portal",
		to: "alice",
	},
	{
		id: "pay",
		label: "Pay a session",
		steps: ["request", "pay"],
		cheat: false,
		proves: true,
		actorLabel: "Alice",
		actionLabel: "Pay a request",
		toLabel: "Galactica",
		intro: (u) => `Galactica opens a payment request, and Alice pays ${u} USDC into it.`,
		why: "Galactica, a merchant, opened a payment request; a user may pay into it.",
		from: "alice",
		to: "galactica",
	},
	{
		id: "refund",
		label: "Refund",
		steps: ["refund"],
		cheat: false,
		proves: true,
		actorLabel: "Galactica",
		actionLabel: "Send privately",
		toLabel: "Alice",
		intro: (u) => `Galactica sends Alice ${u} USDC back.`,
		why: "A merchant can pay anyone: this is the unused session credit.",
		from: "galactica",
		to: "alice",
	},
	{
		id: "pay-a-friend",
		label: "Pay a friend",
		steps: ["transfer-refused"],
		cheat: true,
		proves: true,
		actorLabel: "Alice",
		actionLabel: "Send privately",
		toLabel: "Bob",
		intro: (u) => `Alice tries to send Bob ${u} USDC.`,
		why: "Alice and Bob are both users, and a user can only pay a merchant.",
		from: "alice",
		to: "bob",
	},
	{
		id: "cash-out",
		label: "Cash out elsewhere",
		steps: ["exit-refused"],
		cheat: true,
		proves: true,
		actorLabel: "Alice",
		actionLabel: "Withdraw to Ethereum",
		toLabel: "Bob's Ethereum wallet",
		intro: (u) => `Alice tries to withdraw ${u} USDC to Bob's Ethereum wallet.`,
		why: "A user withdraws only to the address it funded the account from.",
		from: "alice",
		to: "B_demo",
	},
	{
		id: "withdraw",
		label: "Withdraw home",
		steps: ["exit", "withdraw"],
		cheat: false,
		proves: true,
		actorLabel: "Alice",
		actionLabel: "Withdraw to Ethereum",
		toLabel: "Alice's Ethereum wallet",
		intro: (u) => `Alice withdraws ${u} USDC to her own Ethereum wallet.`,
		why: "That is the address Alice funded her account from.",
		from: "alice",
		to: "A_demo",
	},
]
