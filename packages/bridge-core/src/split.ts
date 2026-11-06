/**
 * Split deposits: one private deposit from L1 that pays a merchant a price and leaves the rest as change its buyer
 * collects later, from any wallet.
 *
 * The buyer prepares the deposit ({@link prepareSplitDeposit}) for a fixed amount ({@link DENOMINATIONS}), signs and
 * sends it like any deposit (`submitDeposit`, `confirmDeposit`), and hands the merchant its {@link SplitProof}. The
 * merchant checks it on L1 ({@link verifySplitDeposit}), can serve once it is confirmed, and later claims the price
 * ({@link claimSplit}). The buyer collects the change with {@link claimChange}, or sends it back to the depositor with
 * {@link returnChange}. A deposit that cannot pay its merchant goes back with {@link returnSplit}.
 *
 * Ethereum shows the depositor and the amount, never the merchant or the price; Aztec shows the amount's mint. A deposit
 * of exactly the price would show the price, so only the fixed amounts are prepared.
 */
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import type { TxHash } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { computeFeeJuiceMessageNullifier } from "@aztec-labs/stdlib/messaging"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import { type Address, type Hex, isAddressEqual, type PublicClient, parseEventLogs } from "viem"
import { TOKEN_PORTAL_ABI } from "./abi"
import { tokenBridgeArtifact } from "./artifacts"
import { BindConsentRequiredError, claimBinding } from "./binding"
import {
	ALREADY_CONSUMED,
	type ClaimableNode,
	type ClaimResult,
	type ClaimWait,
	type FeeChoice,
	feeFor,
	L2_DONE,
	type L2Wait,
	type NullifierNode,
	sponsorFailure,
	tipOf,
	type WaitClaimableOptions,
	waitConsumable,
} from "./claim"
import { assertDepositIntent, type ClaimTicket, type DepositDraft, draftWith } from "./deposit"
import { type ExitNode, type ExitTicket, locateWithdrawal } from "./exit"
import type { BridgeManifest } from "./manifest"
import { MERCHANT_MAX_DELAY, type MerchantList, merchantStatus } from "./merchants"
import { randomSecret } from "./random"
import { splitChangeCommitment, splitIou, splitIouSpent, splitSecret, splitSecretHash } from "./split-secret"
import type { StageSink } from "./types"

/** One US dollar of the bridged USDC (6 decimals). */
export const USDC_UNIT = 1_000_000n

/** The amounts a split deposit is prepared for: $1, 5, 10, 50, 100, 500, 1000 and 5000, so the price never shows on L1. */
export const DENOMINATIONS: readonly bigint[] = [1n, 5n, 10n, 50n, 100n, 500n, 1000n, 5000n].map((d) => d * USDC_UNIT)

/**
 * L1 blocks a merchant waits on a split deposit before serving: it risks the price of the one request, not the deposit,
 * and Ethereum has seen practically no reorg deeper than one block since the Merge.
 */
export const SPLIT_CONFIRMATIONS = 2

/** A split deposit's terms, as the buyer's draft keeps them. `buyer` and `changeSalt` never reach the merchant. */
export interface SplitPart {
	merchant: AztecAddress
	price: bigint
	paymentRef: Fr
	buyer: AztecAddress
	changeSalt: Fr
	changeCommitment: Fr
}

export interface SplitIntent {
	/** One of {@link DENOMINATIONS}. */
	amount: bigint
	merchant: AztecAddress
	/** At most `amount`. */
	price: bigint
	/** The reference the merchant handed out for this payment. */
	paymentRef: Fr
	/** The account that collects the change; its first collection binds it to the depositor. */
	buyer: AztecAddress
}

/** The amount is not one of {@link DENOMINATIONS}: a deposit of another amount can show the price on L1. */
export class DenominationError extends Error {
	constructor(readonly amount: bigint) {
		super(`A split deposit is one of ${DENOMINATIONS.map((d) => `$${d / USDC_UNIT}`).join(", ")}, not ${amount} base units.`)
		this.name = "DenominationError"
	}
}

/**
 * A split deposit's draft: sign and send it with `submitDeposit`, as any deposit. Refused before any signature unless
 * the amount is a denomination, `0 < price <= amount`, and `merchant` stays a merchant in `list` (synced whole) past any
 * switch-off it has scheduled. Keep the draft durably: it holds the only copy of the change's salt.
 */
export async function prepareSplitDeposit(i: SplitIntent, m: BridgeManifest, now: () => bigint, list: MerchantList): Promise<DepositDraft> {
	if (!DENOMINATIONS.includes(i.amount)) throw new DenominationError(i.amount)
	if (i.price <= 0n || i.price > i.amount) throw new Error("The price must be positive and at most the deposit.")
	const staysMerchant =
		merchantStatus(list, i.merchant).merchant && merchantStatus(list, i.merchant, list.at + MERCHANT_MAX_DELAY).merchant
	if (!staysMerchant) throw new Error(`${i.merchant} is not a merchant for the next day, so it could not claim this deposit.`)
	if (i.buyer.isZero() || !(await i.buyer.isValid())) throw new Error("The buyer must be a valid Aztec address.")
	await assertDepositIntent({ amount: i.amount, recipient: i.merchant, kind: "private" })
	const changeSalt = randomSecret()
	const split: SplitPart = { ...i, changeSalt, changeCommitment: splitChangeCommitment(i.buyer, changeSalt) }
	const salt = randomSecret()
	const secretHash = await splitSecretHash({ ...split, salt })
	return { ...draftWith({ amount: i.amount, recipient: i.merchant, kind: "private" }, salt, secretHash, m, now), split }
}

/** What the buyer hands the merchant once its deposit is sent: the L1 tx and the terms, as JSON-safe strings. */
export interface SplitProof {
	l1TxHash: Hex
	price: string
	paymentRef: string
	changeCommitment: string
	salt: string
}

export function splitProofOf(d: DepositDraft): SplitProof {
	if (!d.split) throw new Error("This deposit is not a split deposit.")
	if (!d.l1TxHash) throw new Error("This deposit has no transaction hash yet.")
	return {
		l1TxHash: d.l1TxHash,
		price: d.split.price.toString(),
		paymentRef: d.split.paymentRef.toString(),
		changeCommitment: d.split.changeCommitment.toString(),
		salt: d.secretOrSalt.toString(),
	}
}

/** Everything a split deposit's claim or return needs; the merchant and the buyer each hold one. */
export interface SplitClaim {
	amount: bigint
	depositor: Address
	leafIndex: bigint
	messageHash: Hex
	merchant: AztecAddress
	price: bigint
	paymentRef: Fr
	changeCommitment: Fr
	salt: Fr
}

/** The buyer's {@link SplitClaim}, from its confirmed deposit's ticket. */
export function splitClaimOf(t: ClaimTicket): SplitClaim {
	const s = t.draft.split
	if (!s) throw new Error("This deposit is not a split deposit.")
	const { amount } = t.draft.intent
	return { amount, depositor: t.depositor, leafIndex: t.leafIndex, messageHash: t.messageHash, ...s, salt: t.draft.secretOrSalt }
}

/** Why a merchant refused a split deposit's proof. */
export type SplitRefusal = "malformed" | "not-found" | "unconfirmed" | "underpaid"

export class SplitProofRefusedError extends Error {
	constructor(
		readonly reason: SplitRefusal,
		detail: string,
	) {
		super(`Split deposit refused (${reason}): ${detail}`)
		this.name = "SplitProofRefusedError"
	}
}

/**
 * Checks a buyer's proof on L1 for `merchant`, at the reference and price it handed out: the tx emitted exactly one
 * private deposit from the manifest's portal whose secret hash commits to these terms, of at least `price`, at least
 * `confirmations` blocks deep. Once it holds, only `claimSplit` (paying `merchant` the price) or, should the merchant
 * stop being one, `returnSplit` can consume the deposit. Serving on it leaves the merchant exposed to an L1 reorg or a
 * bridge pause until its claim.
 */
export async function verifySplitDeposit(
	pub: Pick<PublicClient, "getTransactionReceipt" | "getBlockNumber">,
	m: BridgeManifest,
	merchant: AztecAddress,
	proof: SplitProof,
	expected: { paymentRef: Fr; price: bigint },
	opts: { confirmations?: number } = {},
): Promise<SplitClaim> {
	if (proof.paymentRef !== expected.paymentRef.toString() || BigInt(proof.price) !== expected.price) {
		throw new SplitProofRefusedError("malformed", "the proof names other terms than this payment's")
	}
	const terms = {
		merchant,
		price: expected.price,
		paymentRef: expected.paymentRef,
		changeCommitment: Fr.fromHexString(proof.changeCommitment),
		salt: Fr.fromHexString(proof.salt),
	}
	const secretHash = (await splitSecretHash(terms)).toString().toLowerCase()
	const receipt = await pub.getTransactionReceipt({ hash: proof.l1TxHash })
	if (receipt.status !== "success") throw new SplitProofRefusedError("not-found", `${proof.l1TxHash} reverted`)
	const portalLogs = receipt.logs.filter((l) => isAddressEqual(l.address, m.l1.portal))
	const deposits = parseEventLogs({ abi: TOKEN_PORTAL_ABI, eventName: "DepositToAztecPrivate", logs: portalLogs, strict: true }).filter(
		(e) => e.args.secretHashForL2MessageConsumption.toLowerCase() === secretHash,
	)
	if (deposits.length !== 1)
		throw new SplitProofRefusedError("not-found", `${proof.l1TxHash} holds ${deposits.length} deposits with these terms`)
	const { depositor, amount, key, index } = deposits[0]!.args
	if (amount < expected.price) throw new SplitProofRefusedError("underpaid", `deposited ${amount}, the price is ${expected.price}`)
	const depth = (await pub.getBlockNumber()) - receipt.blockNumber + 1n
	if (depth < BigInt(opts.confirmations ?? SPLIT_CONFIRMATIONS)) throw new SplitProofRefusedError("unconfirmed", `${depth} confirmations`)
	return { amount, depositor, leafIndex: index, messageHash: key, ...terms }
}

const secretOf = (c: SplitClaim): Fr => splitSecret(c)

function splitArgs(c: SplitClaim) {
	const leaf = new Fr(c.leafIndex)
	return [c.amount, EthAddress.fromString(c.depositor), leaf, c.merchant, c.price, c.paymentRef, c.changeCommitment, c.salt] as const
}

const bridgeOf = (wallet: Wallet, m: BridgeManifest) =>
	Contract.at(AztecAddress.fromStringUnsafe(m.l2.bridge.address), tokenBridgeArtifact, wallet)

/** The nullifier a claim or a return of this split deposit emits, siloed by the bridge. */
export async function splitMessageNullifier(c: SplitClaim, m: BridgeManifest): Promise<Fr> {
	const inner = await computeFeeJuiceMessageNullifier(Fr.fromHexString(c.messageHash), secretOf(c))
	return siloNullifier(AztecAddress.fromStringUnsafe(m.l2.bridge.address), inner)
}

/** Whether this split deposit was claimed or returned at the node's `at` tip. */
export async function isSplitConsumed(
	c: SplitClaim,
	node: NullifierNode,
	m: BridgeManifest,
	at: "proposed" | "checkpointed" | "finalized" = "checkpointed",
): Promise<boolean> {
	const [hit] = await node.findLeavesIndexes(at, MerkleTreeId.NULLIFIER_TREE, [await splitMessageNullifier(c, m)])
	return hit !== undefined
}

/** Resolves once the split deposit can be claimed from `from`'s wallet (or is already consumed). */
export function waitSplitClaimable(
	c: SplitClaim,
	node: ClaimableNode,
	wallet: Wallet,
	m: BridgeManifest,
	from: AztecAddress,
	on?: StageSink<ClaimWait>,
	opts: WaitClaimableOptions = {},
): Promise<void> {
	return waitConsumable(c, node, () => bridgeOf(wallet, m).methods.claim_split!(...splitArgs(c)).simulate({ from }), on, opts)
}

/**
 * Pays the merchant the price and leaves the change, from `from` (the merchant, or anyone holding the terms: the price
 * still goes to the merchant, and a note the merchant does not send itself is delivered on chain, announcing it). Paid
 * per {@link FeeChoice}, sponsored by default. "consumed-unknown": already claimed or returned.
 */
export async function claimSplit(
	c: SplitClaim,
	node: NullifierNode & Pick<AztecNode, "getTxReceipt">,
	wallet: Wallet,
	m: BridgeManifest,
	opts: { from: AztecAddress; fee?: FeeChoice; wait?: L2Wait },
): Promise<ClaimResult> {
	const fee = feeFor("private", m, opts.fee)
	const wait = opts.wait ?? L2_DONE
	try {
		const { txHash } = await bridgeOf(wallet, m).methods.claim_split!(...splitArgs(c)).send({ from: opts.from, fee, wait: NO_WAIT })
		await waitForTx(node as AztecNode, txHash, wait)
		return "claimed"
	} catch (e) {
		const consumed = () => isSplitConsumed(c, node, m, tipOf(wait)).catch(() => false)
		if (ALREADY_CONSUMED.test(e instanceof Error ? e.message : String(e)) && (await consumed())) return "consumed-unknown"
		throw (fee && sponsorFailure(e, "claim")) || e
	}
}

async function withdrawalOf(
	send: () => Promise<{ txHash: TxHash }>,
	recipient: Address,
	amount: bigint,
	node: ExitNode,
	m: BridgeManifest,
	sponsored: boolean,
): Promise<ExitTicket> {
	let txHash: TxHash
	try {
		txHash = (await send()).txHash
	} catch (e) {
		throw (sponsored && sponsorFailure(e, "return")) || e
	}
	const located = await locateWithdrawal(recipient, amount, txHash, node, m)
	if (typeof located === "string") throw new Error(`The return ${txHash} reverted (${located}); nothing was paid out.`)
	return located
}

/**
 * Sends a split deposit that cannot pay its merchant back to its depositor: the price exceeds it, or the merchant is no
 * longer one (unlisted or switched off) at the proving anchor. The withdraw is finished on L1 like an exit's.
 */
export function returnSplit(
	c: SplitClaim,
	wallet: Wallet,
	node: ExitNode,
	m: BridgeManifest,
	opts: { from: AztecAddress; fee?: FeeChoice },
): Promise<ExitTicket> {
	const fee = feeFor("private", m, opts.fee)
	const send = () => bridgeOf(wallet, m).methods.return_split!(...splitArgs(c)).send({ from: opts.from, fee, wait: NO_WAIT })
	return withdrawalOf(send, c.depositor, c.amount, node, m, fee !== undefined)
}

/** The buyer's change: what it collects, and the IOU behind it. */
export interface SplitChange {
	amount: bigint
	buyer: AztecAddress
	changeSalt: Fr
	claim: SplitClaim
}

/** The change a confirmed split deposit owes its buyer; undefined when the price takes the whole deposit. */
export function changeOf(t: ClaimTicket): SplitChange | undefined {
	const s = t.draft.split
	if (!s) throw new Error("This deposit is not a split deposit.")
	const amount = t.draft.intent.amount - s.price
	return amount > 0n ? { amount, buyer: s.buyer, changeSalt: s.changeSalt, claim: splitClaimOf(t) } : undefined
}

async function iouOf(ch: SplitChange, m: BridgeManifest): Promise<{ iou: Fr; spent: Fr }> {
	const c = ch.claim
	const inner = splitIou(c.changeCommitment, ch.amount, EthAddress.fromString(c.depositor), secretOf(c), c.leafIndex)
	const bridge = AztecAddress.fromStringUnsafe(m.l2.bridge.address)
	return { iou: await siloNullifier(bridge, inner), spent: await siloNullifier(bridge, splitIouSpent(inner, ch.changeSalt)) }
}

/** "unclaimed" until the merchant's (or anyone's) split claim lands, then "owed" until the change is collected or returned. */
export async function changeState(
	ch: SplitChange,
	node: NullifierNode,
	m: BridgeManifest,
	at: "proposed" | "checkpointed" | "finalized" = "checkpointed",
): Promise<"unclaimed" | "owed" | "settled"> {
	const { iou, spent } = await iouOf(ch, m)
	const [owed, settled] = await node.findLeavesIndexes(at, MerkleTreeId.NULLIFIER_TREE, [iou, spent])
	if (settled !== undefined) return "settled"
	return owed === undefined ? "unclaimed" : "owed"
}

function changeArgs(ch: SplitChange) {
	const c = ch.claim
	return [ch.amount, EthAddress.fromString(c.depositor), new Fr(c.leafIndex), secretOf(c), ch.changeSalt] as const
}

/**
 * Collects the change into the buyer's private balance, from the buyer's own wallet, once the split claim has settled.
 * The buyer's funding-address rules apply: a first collection binds it to the depositor (needs `allowBind`), a later one
 * must come from it ({@link NotFundingAddressError}: use {@link returnChange}).
 */
export async function claimChange(
	ch: SplitChange,
	node: Pick<AztecNode, "getTxReceipt">,
	wallet: Wallet,
	m: BridgeManifest,
	opts: { fee?: FeeChoice; wait?: L2Wait; allowBind?: boolean } = {},
): Promise<TxHash> {
	const bind = (await claimBinding(wallet, m, ch.buyer, ch.claim.depositor)) === "binds"
	if (bind && opts.allowBind !== true) throw new BindConsentRequiredError(ch.buyer, ch.claim.depositor)
	const fee = feeFor("private", m, opts.fee)
	try {
		const { txHash } = await bridgeOf(wallet, m).methods.claim_change!(...changeArgs(ch), bind).send({
			from: ch.buyer,
			fee,
			wait: NO_WAIT,
		})
		await waitForTx(node as AztecNode, txHash, opts.wait ?? L2_DONE)
		return txHash
	} catch (e) {
		throw (fee && sponsorFailure(e, "change collection")) || e
	}
}

/** Sends the change back to the depositor on L1 instead, publishing its amount (and so, with the deposit, the price). */
export function returnChange(
	ch: SplitChange,
	wallet: Wallet,
	node: ExitNode,
	m: BridgeManifest,
	opts: { from: AztecAddress; fee?: FeeChoice },
): Promise<ExitTicket> {
	const fee = feeFor("private", m, opts.fee)
	const send = () => bridgeOf(wallet, m).methods.return_change!(ch.buyer, ...changeArgs(ch)).send({ from: opts.from, fee, wait: NO_WAIT })
	return withdrawalOf(send, ch.claim.depositor, ch.amount, node, m, fee !== undefined)
}
