import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { computePublicDataTreeLeafSlot } from "@aztec-labs/stdlib/hash"
import { type BridgeManifest, type ClaimTicket, tokenArtifact } from "@inference-money/bridge-core"
import type { WorldItem } from "./tour"

/** The parts of a mined tx effect anyone can read from a node. */
export interface EffectView {
	transactionFee: Fr
	noteHashes: readonly unknown[]
	nullifiers: readonly unknown[]
	l2ToL1Msgs: readonly unknown[]
	privateLogs: readonly { fields: readonly Fr[]; emittedLength: number }[]
	publicLogs: readonly unknown[]
	publicDataWrites: readonly { leafSlot: Fr; value: Fr }[]
}

/** What the sender's kernel committed to that the effect does not carry: the fee payer and the expiry. */
export interface Commitments {
	feePayer: string
	expiresAt: bigint
}

/** A public storage leaf the view names, such as the token's total supply. */
export interface KnownSlot {
	leafSlot: Fr
	label: string
}

const readable = (chain: WorldItem["chain"], label: string, value: string): WorldItem => ({ chain, label, value, visibility: "readable" })

/** The token's total supply leaf: claims and exits write it, so their amounts are public. */
export async function totalSupplySlot(m: BridgeManifest): Promise<KnownSlot> {
	const slot = tokenArtifact.storageLayout.total_supply?.slot
	if (!slot) throw new Error("the token artifact has no total_supply storage")
	return {
		leafSlot: await computePublicDataTreeLeafSlot(AztecAddress.fromStringUnsafe(m.l2.token.address), slot),
		label: "USDC total supply",
	}
}

const BALANCES_SLOT = tokenArtifact.storageLayout.private_balances?.slot

/**
 * The amounts of partial notes the token completed from private, which is how a payment into a request lands: the
 * token emits each one unencrypted, as a private log of three fields (the tag, the balances slot and the amount).
 */
function completedAmounts(logs: EffectView["privateLogs"]): bigint[] {
	return logs.flatMap((l) =>
		l.emittedLength === 3 && BALANCES_SLOT && l.fields[1]?.equals(BALANCES_SLOT) ? [(l.fields[2] as Fr).toBigInt()] : [],
	)
}

/**
 * An Aztec tx as the world sees it: counts of what it created, every public write (named when the slot is known), the
 * amount of any partial note completed from private, the fee payer and the expiry, all read from the chain. `hidden`
 * names what the demo knows the tx carried but nobody else can read (sender, recipient, amount); those items never
 * carry a value.
 */
export function aztecWorld(effect: EffectView, sent: Commitments, known: readonly KnownSlot[], hidden: readonly string[]): WorldItem[] {
	const completed = completedAmounts(effect.privateLogs)
	const items = [
		readable("aztec", "fee payer", sent.feePayer),
		readable("aztec", "expires at", sent.expiresAt.toString()),
		readable("aztec", "fee", effect.transactionFee.toBigInt().toString()),
		readable("aztec", "nullifiers", String(effect.nullifiers.length)),
		readable("aztec", "new notes", String(effect.noteHashes.length)),
		readable("aztec", "encrypted logs", String(effect.privateLogs.length - completed.length)),
		...completed.map((amount) => readable("aztec", "amount", amount.toString())),
	]
	let unnamed = 0
	for (const w of effect.publicDataWrites) {
		const k = known.find((s) => s.leafSlot.equals(w.leafSlot))
		if (k) items.push(readable("aztec", k.label, w.value.toBigInt().toString()))
		else unnamed++
	}
	if (unnamed > 0) items.push(readable("aztec", "other public writes", String(unnamed)))
	if (effect.publicLogs.length > 0) items.push(readable("aztec", "public logs", String(effect.publicLogs.length)))
	if (effect.l2ToL1Msgs.length > 0) items.push(readable("aztec", "messages to Ethereum", String(effect.l2ToL1Msgs.length)))
	return [...items, ...hidden.map((label): WorldItem => ({ chain: "aztec", label, visibility: "hidden" }))]
}

/** An L1 call's public fields, as its calldata and events show them. */
export const ethereumWorld = (fields: readonly [label: string, value: string][]): WorldItem[] =>
	fields.map(([label, value]) => readable("ethereum", label, value))

/** A private deposit as the router's call and its `Deposit` event show it. */
export const depositWorld = (t: ClaimTicket): WorldItem[] =>
	ethereumWorld([
		["depositor", t.depositor],
		["amount", t.draft.intent.amount.toString()],
		["kind", t.draft.intent.kind],
		["secret hash", t.draft.secretHash.toString()],
		["message index", t.leafIndex.toString()],
	])

/** A withdrawal's payout as the portal's call shows it. */
export const withdrawWorld = (recipient: string, amount: bigint): WorldItem[] =>
	ethereumWorld([
		["recipient", recipient],
		["amount", amount.toString()],
	])

/**
 * What each kind of Aztec tx keeps from everyone but its parties, neither readable nor inferable: a payment's public
 * amount usually names its merchant, whose x402 prices are public.
 */
export const HIDDEN: Record<"claim" | "request" | "pay" | "transfer" | "exit", readonly string[]> = {
	claim: ["recipient"],
	request: ["recipient", "payer"],
	pay: ["payer"],
	transfer: ["sender", "recipient", "amount"],
	exit: ["sender"],
}
