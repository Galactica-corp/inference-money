import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import { type FeePaymentMethod, SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { computeFeeJuiceMessageNullifier } from "@aztec-labs/stdlib/messaging"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import { sponsoredFpcArtifact, tokenBridgeArtifact } from "./artifacts"
import { BindConsentRequiredError, claimBinding } from "./binding"
import { deriveClaimSecret } from "./claim-secret"
import { type ClaimTicket, reconcileDeposit } from "./deposit"
import type { BridgeManifest } from "./manifest"
import type { L1Ctx, StageSink } from "./types"

/**
 * "consumed-unknown": the message is already consumed, by an earlier claim or by a return; the nullifier alone cannot
 * tell which, so it is never reported as a mint. `depositFate` finds the consuming tx.
 */
export type ClaimResult = "claimed" | "consumed-unknown"

/**
 * Who pays a tx's fee, a public field of every tx. "sponsored": the network's sponsor, which keeps the account out of
 * it. "account-public": the sending account, from its own Fee Juice, named as the tx's fee payer beside what the tx
 * shows: a claim's amount, an exit's funding address, a return's depositor. Default: sponsored for private ops, the
 * account for public ones, which publish it anyway; an explicit choice overrides.
 */
export type FeeChoice = "sponsored" | "account-public"

export function feeFor(kind: "public" | "private", m: BridgeManifest, choice?: FeeChoice): { paymentMethod: FeePaymentMethod } | undefined {
	const chosen = choice ?? (kind === "private" ? "sponsored" : "account-public")
	if (chosen === "sponsored") return { paymentMethod: sponsoredPayment(m) }
	if (chosen === "account-public") return undefined
	throw new Error(`Unknown fee choice ${String(choice)}: name "sponsored" or "account-public".`)
}

/** The network's sponsor could not pay (exhausted, missing or refused); the ticket is untouched and can be retried. */
export class SponsorUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "SponsorUnavailableError"
	}
}

/**
 * How far an L2 tx must get before the bridge reads its outcome: published to L1 in a checkpoint. Wallets may return
 * at a proposed block, which is dropped if its proposer never publishes it, and wallet-sdk's transport strips
 * `waitForStatus`, so the bridge waits on the node itself. A checkpoint is still not permanent (an unproven epoch can
 * be pruned), so a claim's secret is kept until {@link waitClaimFinalized}.
 */
export const L2_DONE = { waitForStatus: TxStatus.CHECKPOINTED, timeout: 600 } as const

/**
 * A faster answer for a UI: the tx is in a proposed block. A PXE on its default `proposed` sync tip builds on it, and the
 * node refuses a double spend against it, but a prune undoes it: nothing irreversible may rest on it before finality.
 */
export const L2_PROPOSED = { waitForStatus: TxStatus.PROPOSED, timeout: 600 } as const

/** How far a flow waits for its tx before returning; {@link L2_DONE} unless the caller opts into {@link L2_PROPOSED}. */
export type L2Wait = typeof L2_DONE | typeof L2_PROPOSED

/** The chain tip a read must use to agree with what `wait` returned on. */
export const tipOf = (wait: L2Wait): "proposed" | "checkpointed" => (wait.waitForStatus === TxStatus.PROPOSED ? "proposed" : "checkpointed")

// aztec-nr's consume asserts (public, private) and the sequencer's duplicate-nullifier rejection.
const ALREADY_CONSUMED = /already nullified|No non-nullified L1 to L2 message|existing nullifier|duplicate nullifier/i
// The message is not yet in the tree the wallet's PXE anchors to.
const NOT_YET_CLAIMABLE = /Tried to consume nonexistent L1-to-L2 message|No L1 to L2 message found/i
const FEE_PAYER_FAILED = /fee payer|insufficient fee|not enough balance for fee/i

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A sponsored send that failed because the sponsor could not pay, as {@link SponsorUnavailableError}; else undefined. */
export function sponsorFailure(e: unknown, what: string): SponsorUnavailableError | undefined {
	if (!FEE_PAYER_FAILED.test(message(e))) return undefined
	return new SponsorUnavailableError(`The fee sponsor could not pay for this ${what}. It is kept; retry later.`, { cause: e })
}

export function sponsoredPayment(m: BridgeManifest): FeePaymentMethod {
	if (!m.l2.sponsoredFpc) throw new SponsorUnavailableError("This network has no fee sponsor for private transactions.")
	return new SponsoredFeePaymentMethod(AztecAddress.fromStringUnsafe(m.l2.sponsoredFpc))
}

/** The one sponsor this code can vouch for: the pinned SponsoredFPC class at salt 0. */
export const sponsorInstance = () => getContractInstanceFromInstantiationParams(sponsoredFpcArtifact, { salt: Fr.ZERO })

/**
 * Registers the network's sponsor in `wallet`, which must know its class to pay through it. Refuses a manifest whose
 * sponsor is not {@link sponsorInstance}.
 */
export async function registerSponsor(wallet: Pick<Wallet, "registerContract">, m: BridgeManifest): Promise<AztecAddress> {
	if (!m.l2.sponsoredFpc) throw new SponsorUnavailableError("This network has no fee sponsor for private transactions.")
	const instance = await sponsorInstance()
	if (!instance.address.equals(AztecAddress.fromStringUnsafe(m.l2.sponsoredFpc))) {
		throw new SponsorUnavailableError(
			`The manifest's fee sponsor ${m.l2.sponsoredFpc} is not the known SponsoredFPC ${instance.address}.`,
		)
	}
	await wallet.registerContract(instance, sponsoredFpcArtifact)
	return instance.address
}

/**
 * Whether a private claim of `t` binds its recipient: its first does, to the deposit's depositor, for good, so it
 * needs `allowBind`. A deposit from any other address than a bound account's is refused here, before any proving.
 */
async function consentedBind(t: ClaimTicket, wallet: Wallet, m: BridgeManifest, allowBind: boolean | undefined): Promise<boolean> {
	const { recipient } = t.draft.intent
	const bind = (await claimBinding(wallet, m, recipient, t.depositor)) === "binds"
	if (bind && allowBind !== true) throw new BindConsentRequiredError(recipient, t.depositor)
	return bind
}

async function claimCall(t: ClaimTicket, wallet: Wallet, m: BridgeManifest, allowBind: boolean | undefined) {
	const bridge = Contract.at(AztecAddress.fromStringUnsafe(m.l2.bridge.address), tokenBridgeArtifact, wallet)
	const { amount, recipient, kind } = t.draft.intent
	const leaf = new Fr(t.leafIndex)
	const depositor = EthAddress.fromString(t.depositor)
	if (kind === "public") return bridge.methods.claim_public!(recipient, amount, t.draft.secretOrSalt, leaf, depositor)
	const bind = await consentedBind(t, wallet, m, allowBind)
	return bridge.methods.claim_private!(recipient, amount, t.draft.secretOrSalt, leaf, depositor, bind)
}

export interface ClaimConsent {
	/** Consent to the binding an unbound recipient's first private claim makes; without it that claim throws {@link BindConsentRequiredError}. */
	allowBind?: boolean
}

export interface WaitClaimableOptions {
	/** Default 120 polls, 5 s apart (~10 min). */
	attempts?: number
	pollMs?: number
	sleep?: (ms: number) => Promise<void>
}

/** The witness exists once a block (proposed is enough) holds the message in its L1-to-L2 tree, not at L1 ingestion. */
export type ClaimableNode = { getL1ToL2MessageMembershipWitness(block: "latest", message: Fr): Promise<unknown> }
export type ClaimWait = "waiting-for-inclusion" | "waiting-for-wallet-sync"

async function probeConsumable(t: ClaimTicket, node: ClaimableNode, simulate: () => Promise<unknown>): Promise<"ready" | ClaimWait> {
	if ((await node.getL1ToL2MessageMembershipWitness("latest", Fr.fromHexString(t.messageHash))) === undefined)
		return "waiting-for-inclusion"
	try {
		await simulate()
		return "ready"
	} catch (e) {
		if (ALREADY_CONSUMED.test(message(e))) return "ready"
		if (NOT_YET_CLAIMABLE.test(message(e))) return "waiting-for-wallet-sync"
		throw e
	}
}

/** {@link waitConsumable} gave up: the ticket's message never reached the tree the wallet's PXE anchors to. */
export class MessageNotConsumableError extends Error {
	constructor() {
		super("The deposit has not reached your wallet yet. It is kept; try again in a few minutes.")
		this.name = "MessageNotConsumableError"
	}
}

/**
 * Resolves once `simulate` (a claim or a return of `t`, which consume the same message) succeeds: the message must be
 * in the L1-to-L2 tree the wallet's PXE anchors to, which only a successful simulation proves. A consumed message
 * resolves too, so the claim or return that follows reports it. Any other simulation failure is thrown.
 */
export async function waitConsumable(
	t: ClaimTicket,
	node: ClaimableNode,
	simulate: () => Promise<unknown>,
	on?: StageSink<ClaimWait>,
	opts: WaitClaimableOptions = {},
): Promise<void> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	for (let attempt = 0; attempt < (opts.attempts ?? 120); attempt++) {
		const state = await probeConsumable(t, node, simulate)
		if (state === "ready") return
		on?.(state)
		await sleep(opts.pollMs ?? 5_000)
	}
	throw new MessageNotConsumableError()
}

/**
 * Runs `use` on `t`. When it fails on a missing Inbox message ({@link MessageNotConsumableError}, or a simulation that
 * finds none), rebuilds the ticket from the deposit as `l1` shows it now; if that names another leaf or key, a reorg
 * re-mined the deposit behind other messages, so the rebuilt ticket goes to `keep`, then to `use` once more. Any other
 * outcome throws the first failure.
 */
export async function withRebuiltTicket<T>(
	t: ClaimTicket,
	l1: L1Ctx,
	m: BridgeManifest,
	keep: (t: ClaimTicket) => void,
	use: (t: ClaimTicket) => Promise<T>,
): Promise<T> {
	let rebuilt: ClaimTicket | undefined
	try {
		return await use(t)
	} catch (e) {
		if (!(e instanceof MessageNotConsumableError) && !NOT_YET_CLAIMABLE.test(message(e))) throw e
		const found = await reconcileDeposit(t.draft, l1, m)
		const moved = typeof found !== "string" && (found.leafIndex !== t.leafIndex || found.messageHash !== t.messageHash)
		if (!moved) throw e
		rebuilt = found
	}
	keep(rebuilt)
	return use(rebuilt)
}

/**
 * {@link waitConsumable} for the claim of `t` from `from`'s wallet. A claim that would bind without consent is refused
 * at once, before the message is even waited for.
 */
export async function waitClaimable(
	t: ClaimTicket,
	node: ClaimableNode,
	wallet: Wallet,
	m: BridgeManifest,
	from: AztecAddress,
	on?: StageSink<ClaimWait>,
	opts: WaitClaimableOptions & ClaimConsent = {},
): Promise<void> {
	if (t.draft.intent.kind === "private") await consentedBind(t, wallet, m, opts.allowBind)
	return waitConsumable(t, node, async () => (await claimCall(t, wallet, m, opts.allowBind)).simulate({ from }), on, opts)
}

export type NullifierNode = Pick<AztecNode, "findLeavesIndexes">
export type ClaimNode = NullifierNode & Pick<AztecNode, "getTxReceipt">

/**
 * The nullifier the bridge emits when a claim or a return consumes this ticket's message: aztec-nr's
 * `compute_l1_to_l2_message_nullifier` (stdlib names it after the fee-juice contract), siloed by the bridge.
 */
export async function messageNullifier(t: ClaimTicket, m: BridgeManifest): Promise<Fr> {
	const { kind, recipient } = t.draft.intent
	const secret = kind === "private" ? deriveClaimSecret(t.draft.secretOrSalt, recipient) : t.draft.secretOrSalt
	const inner = await computeFeeJuiceMessageNullifier(Fr.fromHexString(t.messageHash), secret)
	return siloNullifier(AztecAddress.fromStringUnsafe(m.l2.bridge.address), inner)
}

/** Whether the bridge has nullified this ticket's message on L2, by a claim or a return. */
export async function isClaimConsumed(
	t: ClaimTicket,
	node: NullifierNode,
	m: BridgeManifest,
	at: "proposed" | "checkpointed" | "finalized" = "checkpointed",
): Promise<boolean> {
	const [hit] = await node.findLeavesIndexes(at, MerkleTreeId.NULLIFIER_TREE, [await messageNullifier(t, m)])
	return hit !== undefined
}

export interface WaitClaimFinalizedOptions {
	/** Default 15 s. There is no attempt cap: until the claim is final, forgetting the secret can lose the deposit. */
	pollMs?: number
	sleep?: (ms: number) => Promise<void>
}

/**
 * Waits until this ticket's claim is in a finalized block: before that, an epoch that misses its proof window is
 * pruned, and an L1 reorg can remove a proof that landed near its deadline. "dropped" once the nullifier is not even
 * proposed any more, so the caller claims again; a failed read counts as not final yet. "finalized" is the node's
 * unproven word: mark the ticket final and keep it, never delete the only copy of its secret on this answer.
 */
export async function waitClaimFinalized(
	t: ClaimTicket,
	node: NullifierNode,
	m: BridgeManifest,
	opts: WaitClaimFinalizedOptions = {},
): Promise<"finalized" | "dropped"> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	for (;;) {
		const state = await claimFinality(t, node, m).catch(() => "pending" as const)
		if (state !== "pending") return state
		await sleep(opts.pollMs ?? 15_000)
	}
}

// A claim returned at either tip shows at "proposed", which holds every checkpointed block too.
async function claimFinality(t: ClaimTicket, node: NullifierNode, m: BridgeManifest): Promise<"finalized" | "pending" | "dropped"> {
	if (await isClaimConsumed(t, node, m, "finalized")) return "finalized"
	return (await isClaimConsumed(t, node, m, "proposed")) ? "pending" : "dropped"
}

/**
 * Mints the deposit on L2 from `from`: a private claim only from its recipient, a public one from anyone (the mint
 * goes to the merchant the message names), paid per {@link FeeChoice}. Both outcomes hold only at `opts.wait`'s tip, a
 * checkpoint by default: keep the secret, also past {@link waitClaimFinalized}'s "finalized". "consumed-unknown" needs
 * this ticket's nullifier on L2 at that tip: a nullifier error can come from any part of the tx. A first private claim
 * needs `allowBind` ({@link ClaimConsent}).
 */
export async function claim(
	t: ClaimTicket,
	node: ClaimNode,
	wallet: Wallet,
	m: BridgeManifest,
	opts: { from: AztecAddress; fee?: FeeChoice; wait?: L2Wait } & ClaimConsent,
): Promise<ClaimResult> {
	const call = await claimCall(t, wallet, m, opts.allowBind)
	const fee = feeFor(t.draft.intent.kind, m, opts.fee)
	const sponsored = fee !== undefined
	const wait = opts.wait ?? L2_DONE
	try {
		const { txHash } = await call.send({ from: opts.from, fee, wait: NO_WAIT })
		await waitForTx(node as AztecNode, txHash, wait)
		return "claimed"
	} catch (e) {
		const consumed = () => isClaimConsumed(t, node, m, tipOf(wait)).catch(() => false)
		if (ALREADY_CONSUMED.test(message(e)) && (await consumed())) return "consumed-unknown"
		throw (sponsored && sponsorFailure(e, "claim")) || e
	}
}
