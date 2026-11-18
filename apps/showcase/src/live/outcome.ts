import { BRIDGE_REFUSALS, bridgeRefusalOf, TOKEN_REFUSALS, tokenRefusalOf } from "@galactica-net/inference-money-core/rules"
import type { FeedRow } from "@/tour/player"
import { HOLDER_NAME } from "@/ui/cards"
import type { ValidDraft } from "./draft"

/** How a live action ended. A refusal is a contract rule's, quoted verbatim; anything else that stopped it failed. */
export type Outcome =
	| { kind: "settled"; detail: string; rows: FeedRow[] }
	| { kind: "refused"; rule: string; detail: string }
	| { kind: "failed"; detail: string }

export const NOTHING_SENT = "Nothing was proven or sent."

/** Why each rule refuses, by role; the rule's own text sits above it, verbatim. */
const WHY: Partial<Record<string, (d: ValidDraft) => string>> = {
	transfer: (d) => `${HOLDER_NAME[d.actor]} and ${HOLDER_NAME[d.to]} are both users, and a user can only pay a merchant.`,
	request: () => "A payment request needs a merchant on one side, and both of these are users.",
	payment: () => "A user pays only into requests a merchant opened through the merchant list.",
	exitDestination: (d) => `${HOLDER_NAME[d.actor]} withdraws only to the address the account was funded from.`,
	paused: () => "The operator has paused the bridge.",
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** bridge-core's check of a user's exit destination: it runs before the contract's, and words the rule for its CLI. */
const isExitDestination = (e: unknown): boolean => e instanceof Error && e.name === "ExitDestinationError"

/** The plain sentence for a failure that is no rule: what the visitor can do about it, never a stack trace. */
function failure(e: unknown): string {
	const text = message(e)
	if (/Balance too low/.test(text))
		return "There is not enough private balance for that. Try a smaller amount, or reset the demo balances."
	if (e instanceof Error && e.name === "PaymentRefusedError") return text
	if (e instanceof Error && e.name === "ExitUnconfirmedError")
		return "Sent, but Aztec has not confirmed it yet. This page pays it out once it lands, so don't withdraw it again."
	if (/Existing nullifier|Duplicate nullifier/i.test(text))
		return "Another visitor spent the same demo funds at the same moment. Try again."
	if (/fetch|network|timed? ?out|ECONN/i.test(text)) return `The network did not answer: ${text}. Try again.`
	return text
}

export function classify(e: unknown, d: ValidDraft): Outcome {
	const token = tokenRefusalOf(e)
	const bridge = token ? undefined : (bridgeRefusalOf(e) ?? (isExitDestination(e) ? "exitDestination" : undefined))
	const rule = token ?? bridge
	if (rule) {
		const text = token ? TOKEN_REFUSALS[token] : BRIDGE_REFUSALS[bridge as keyof typeof BRIDGE_REFUSALS]
		const why = WHY[rule]?.(d)
		return { kind: "refused", rule: text, detail: why ? `${why} ${NOTHING_SENT}` : NOTHING_SENT }
	}
	return { kind: "failed", detail: failure(e) }
}
