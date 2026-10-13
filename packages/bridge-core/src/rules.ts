/**
 * The merchant token's refusals: the exact text each rule check fails with, so a client can tell which rule a
 * simulation hit. `rules.test.ts` finds every string verbatim in the Noir source, so a reworded assert fails there.
 */
export const TOKEN_REFUSALS = {
	transfer: "Transfer refused: neither sender nor recipient is a merchant",
	request: "Request refused: neither creator nor recipient is a merchant",
	payment: "Payment refused: users may only pay into requests opened for a merchant",
	expired: "Payment refused: the request's stamp has expired",
	alreadyPaid: "Payment refused: the request is already paid",
	zeroPayment: "Payment refused: the amount is zero",
	notAdmin: "Only the merchant admin",
	notAdminOrGuardian: "Only the merchant admin or guardian",
	notAdminLowersDelay: "Only the merchant admin lowers a delay",
	notPendingAdmin: "Only the pending merchant admin",
	noPendingChange: "No pending change",
	alreadyAdded: "Merchant already added",
	zeroMerchant: "Merchant is the zero address",
	notRegistered: "Not a registered merchant",
	delayOutOfRange: "Delay out of range",
	switchedOff: "Merchant is switched off",
} as const

export type TokenRule = keyof typeof TOKEN_REFUSALS

/** The bridge's refusals, found verbatim in its Noir source (or the withdraw encoder's) by `rules.test.ts`. */
export const BRIDGE_REFUSALS = {
	paused: "Bridge is paused",
	publicClaimToUser: "Public claims are for merchants only",
	relayedPrivateClaim: "Only the recipient can claim privately",
	notFundingAddress: "Deposit is not from this account's funding address",
	merchantDepositReturn: "A merchant's public deposit is claimed, not returned",
	publicExitByUser: "Public exits are for merchants only",
	exitDestination: "Withdrawals from a user account go only to its funding address",
	exitToPortal: "Recipient cannot be the portal",
	withdrawAddressWidth: "A withdraw names only 20-byte Ethereum addresses",
} as const

export type BridgeRule = keyof typeof BRIDGE_REFUSALS

/** The bridge rule an error's message carries (a simulation failure or a revert), or undefined. */
export function bridgeRefusalOf(error: unknown): BridgeRule | undefined {
	const message = error instanceof Error ? error.message : String(error)
	return (Object.entries(BRIDGE_REFUSALS) as [BridgeRule, string][]).find(([, text]) => message.includes(text))?.[0]
}

// Longest first: "Only the merchant admin" begins two longer refusals.
const BY_LENGTH = (Object.entries(TOKEN_REFUSALS) as [TokenRule, string][]).sort(([, a], [, b]) => b.length - a.length)

/** The token rule an error's message carries (a simulation failure or a revert), or undefined. */
export function tokenRefusalOf(error: unknown): TokenRule | undefined {
	const message = error instanceof Error ? error.message : String(error)
	return BY_LENGTH.find(([, text]) => message.includes(text))?.[0]
}
