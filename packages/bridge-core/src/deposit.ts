import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"
import {
	type Address,
	getAbiItem,
	type Hex,
	hexToBigInt,
	hexToNumber,
	isAddressEqual,
	type Log,
	type PublicClient,
	pad,
	parseEventLogs,
	recoverTypedDataAddress,
	size,
	slice,
} from "viem"
import { PERMIT2_DEPOSIT_ROUTER_ABI, PERMIT2_NONCE_ABI } from "./abi"
import { deriveClaimSecret } from "./claim-secret"
import { isUserRejection } from "./errors"
import { type AwaitL1ReceiptOptions, awaitL1Receipt } from "./l1-receipt"
import type { BridgeManifest } from "./manifest"
import { type MerchantList, merchantStatus } from "./merchants"
import { assertReaderChain, assertSigningContext, NetworkMismatchError } from "./network"
import { assertBridgeLive, type PauseSource } from "./pause"
import { type DepositTypedData, type DepositWitness, depositPermitTypedData, PERMIT_DEADLINE_SECONDS, randomPermitNonce } from "./permit2"
import { randomSecret } from "./random"
import { type L1Ctx, MAX_L2_AMOUNT, type StageSink, sendChain, signerOf, withGasHeadroom } from "./types"

export type DepositKind = "public" | "private"

export interface DepositIntent {
	amount: bigint
	recipient: AztecAddress
	kind: DepositKind
}

/**
 * Created before any signature and the single owner of the claim secret; in memory only. `submission` is recorded
 * before the send request, so a draft that has one may have been broadcast and is only ever reconciled, never re-sent.
 */
export interface DepositDraft {
	intent: DepositIntent
	/** Public: the message secret. Private: the claim salt; `claim_private` derives the secret from it and the recipient. */
	secretOrSalt: Fr
	secretHash: Fr
	witness: DepositWitness
	typedData: DepositTypedData
	/**
	 * `fromBlock` is the finalized block before the signature (a reorg can re-mine the deposit below the tip seen then);
	 * its hash proves at recovery that the boundary was read from this chain.
	 */
	submission?: { account: Address; chainId: number; fromBlock: bigint; fromBlockHash: Hex }
	l1TxHash?: Hex
}

export interface ClaimTicket {
	draft: DepositDraft
	/** The Inbox message key. */
	messageHash: Hex
	leafIndex: bigint
	/** The L1 address the message names as depositor (the Permit2 signer); a claim must present it. */
	depositor: Address
}

/**
 * `not-deposited` only after an error-free scan through a finalized block past the permit deadline, at which Permit2
 * still holds the permit's nonce unused. It is still one reader's word: keep the draft, never delete it on this.
 */
export type Reconciled = ClaimTicket | "pending" | "not-deposited"

export type DepositStage = "signing" | "depositing" | "confirming"

const DEPOSIT_EVENT = getAbiItem({ abi: PERMIT2_DEPOSIT_ROUTER_ABI, name: "Deposit" })
const ZERO_WORD = pad("0x0")
/** Blocks per `eth_getLogs` call; providers cap the range. */
export const LOG_SCAN_CHUNK = 5_000n

/** A public deposit funds merchants only; one to anyone else could never be claimed, only returned. */
export class PublicDepositToUserError extends Error {
	constructor(readonly recipient: AztecAddress) {
		super(`Public deposits fund merchants only, and ${recipient} is not one. Deposit privately instead.`)
		this.name = "PublicDepositToUserError"
	}
}

/** The router accepts a private deposit only under its caller's own ECDSA signature, never a contract's approval. */
export class KeyHolderRequiredError extends Error {
	constructor(readonly account: Address) {
		super(
			`${account} did not sign as its own key holder (the wallet signed as a contract, or in a form the router refuses). ` +
				"Private deposits need the key holder's own signature; a smart-contract wallet uses the portal's signed path.",
		)
		this.name = "KeyHolderRequiredError"
	}
}

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

/** OpenZeppelin's ECDSA rules, stricter than viem's recovery: 65 bytes, `v` 27 or 28, low `s`, and the account's key. */
async function signedByKeyHolder(d: DepositDraft, signature: Hex, account: Address): Promise<boolean> {
	try {
		if (size(signature) !== 65) return false
		const v = hexToNumber(slice(signature, 64, 65))
		if ((v !== 27 && v !== 28) || hexToBigInt(slice(signature, 32, 64)) > SECP256K1_HALF_N) return false
		return isAddressEqual(await recoverTypedDataAddress({ ...d.typedData, signature }), account)
	} catch {
		return false
	}
}

/**
 * Refuses a public deposit to anyone but a switched-on merchant in `list` (synced whole: `syncMerchantList`), before
 * any signature. A merchant switched off after the deposit lands can no longer claim it; the depositor can return it.
 */
export function assertPublicRecipient(list: MerchantList, recipient: AztecAddress): void {
	if (!merchantStatus(list, recipient).merchant) throw new PublicDepositToUserError(recipient)
}

/** The router's intent rules plus what makes an L2 claim impossible (a zero or off-curve recipient). */
export async function assertDepositIntent(i: DepositIntent): Promise<void> {
	if (i.amount <= 0n) throw new Error("The amount must be positive.")
	if (i.amount > MAX_L2_AMOUNT) throw new Error("The amount exceeds what the L2 token can hold.")
	if (i.recipient.isZero()) throw new Error("The Aztec recipient must not be the zero address.")
	if (!(await i.recipient.isValid())) throw new Error("The Aztec recipient is not a valid Aztec address.")
}

export async function prepareDeposit(i: DepositIntent, m: BridgeManifest, now: () => bigint): Promise<DepositDraft> {
	await assertDepositIntent(i)
	const isPrivate = i.kind === "private"
	const secretOrSalt = randomSecret()
	const secretHash = await computeSecretHash(isPrivate ? deriveClaimSecret(secretOrSalt, i.recipient) : secretOrSalt)
	const witness: DepositWitness = {
		aztecRecipient: isPrivate ? ZERO_WORD : (i.recipient.toString() as Hex),
		secretHash: secretHash.toString() as Hex,
		isPrivate,
	}
	const permit = {
		token: m.l1.usdc,
		amount: i.amount,
		spender: m.l1.router,
		nonce: randomPermitNonce(),
		deadline: now() + PERMIT_DEADLINE_SECONDS,
	}
	return { intent: i, secretOrSalt, secretHash, witness, typedData: depositPermitTypedData(permit, witness, m.l1.permit2, m.l1.chainId) }
}

/** Drafts inside `submitDeposit`: a concurrent second call would sign again and could clear the first one's record. */
const inFlight = new WeakSet<DepositDraft>()

/**
 * Signs and sends the deposit; `d.l1TxHash` is set the moment the wallet returns it. The bridge's pause flag is read
 * before the signature and again before the send: a deposit into a paused bridge is claimable only after an unpause.
 */
export async function submitDeposit(
	d: DepositDraft,
	l1: L1Ctx,
	m: BridgeManifest,
	l2: PauseSource,
	on?: StageSink<DepositStage>,
): Promise<Hex> {
	if (d.submission) throw new Error("This deposit was already sent. Re-check it instead of sending it again.")
	if (inFlight.has(d)) throw new Error("This deposit is already being sent.")
	inFlight.add(d)
	try {
		return await signAndSend(d, l1, m, l2, on)
	} finally {
		inFlight.delete(d)
	}
}

async function signAndSend(d: DepositDraft, l1: L1Ctx, m: BridgeManifest, l2: PauseSource, on?: StageSink<DepositStage>): Promise<Hex> {
	const expected = { l1Account: l1.account }
	await assertSigningContext(l1, null, m, expected)
	await assertBridgeLive(l2, m)
	await assertReaderChain(l1.publicClient, m.l1.chainId)
	const finalized = await l1.publicClient.getBlock({ blockTag: "finalized" })
	on?.("signing")
	const signature = await l1.walletClient.signTypedData({ account: signerOf(l1), ...d.typedData })
	if (d.witness.isPrivate && !(await signedByKeyHolder(d, signature, l1.account))) throw new KeyHolderRequiredError(l1.account)
	await Promise.all([assertSigningContext(l1, null, m, expected), assertBridgeLive(l2, m)])
	const { message } = d.typedData
	const call = {
		address: m.l1.router,
		abi: PERMIT2_DEPOSIT_ROUTER_ABI,
		functionName: "deposit",
		args: [
			message.permitted.amount,
			d.witness.aztecRecipient,
			d.witness.secretHash,
			d.witness.isPrivate,
			message.nonce,
			message.deadline,
			signature,
		],
		account: signerOf(l1),
	} as const
	// Estimated before the draft counts as sent: a deposit that would revert fails here, with nothing broadcast.
	const gas = withGasHeadroom(await l1.publicClient.estimateContractGas(call))
	d.submission = { account: l1.account, chainId: m.l1.chainId, fromBlock: finalized.number, fromBlockHash: finalized.hash }
	on?.("depositing")
	try {
		d.l1TxHash = await l1.walletClient.writeContract({ ...call, gas, chain: sendChain(l1, m.l1.chainId) })
	} catch (e) {
		// A wallet's explicit refusal means nothing was broadcast; any other failure may have been, so the draft stays
		// submitted. A local key's raw send has no user to refuse it: a refusal there is the RPC's word.
		if (asksItsUser(l1) && isUserRejection(e)) d.submission = undefined
		throw e
	}
	return d.l1TxHash
}

/** A JSON-RPC wallet sends on its user's say-so; a local account signs in process and hands the RPC a raw tx. */
function asksItsUser(l1: L1Ctx): boolean {
	const signer = signerOf(l1)
	return typeof signer === "string" || signer.type === "json-rpc"
}

type DepositArgs = { depositor: Address; aztecRecipient: Hex; key: Hex; index: bigint; amount: bigint; secretHash: Hex; isPrivate: boolean }

function isThisDeposit(a: DepositArgs, d: DepositDraft): boolean {
	const s = d.submission
	return (
		s !== undefined &&
		isAddressEqual(a.depositor, s.account) &&
		a.secretHash.toLowerCase() === d.witness.secretHash.toLowerCase() &&
		a.aztecRecipient.toLowerCase() === d.witness.aztecRecipient.toLowerCase() &&
		a.amount === d.intent.amount &&
		a.isPrivate === d.witness.isPrivate
	)
}

/**
 * The claim ticket from a mined deposit's receipt. Only a log emitted by the manifest router counts, and there must be
 * exactly one: the token runs arbitrary code during the Permit2 pull and can emit a same-signature event.
 */
export function ticketFromReceiptLogs(d: DepositDraft, logs: Log[], m: BridgeManifest): ClaimTicket {
	const router = logs.filter((l) => isAddressEqual(l.address, m.l1.router))
	const events = parseEventLogs({ abi: PERMIT2_DEPOSIT_ROUTER_ABI, eventName: "Deposit", logs: router, strict: true })
	if (events.length !== 1) throw new Error(`Expected exactly one router Deposit event in the receipt, found ${events.length}.`)
	const [event] = events
	if (!event || !isThisDeposit(event.args, d)) throw new Error("The mined Deposit event does not match this deposit.")
	return { draft: d, messageHash: event.args.key, leafIndex: event.args.index, depositor: event.args.depositor }
}

/** Waits for the sent deposit to mine. A revert or timeout throws with the draft untouched, so it can be re-checked. */
export async function confirmDeposit(
	d: DepositDraft,
	l1: L1Ctx,
	m: BridgeManifest,
	on?: StageSink<DepositStage>,
	opts?: AwaitL1ReceiptOptions,
): Promise<ClaimTicket> {
	if (!d.l1TxHash) throw new Error("This deposit has no transaction hash yet. Re-check it instead.")
	on?.("confirming")
	const receipt = await awaitL1Receipt(l1.publicClient, d.l1TxHash, opts)
	return ticketFromReceiptLogs(d, receipt.logs, m)
}

async function ticketByHash(d: DepositDraft, pub: PublicClient, m: BridgeManifest): Promise<ClaimTicket | undefined> {
	if (!d.l1TxHash) return undefined
	try {
		const receipt = await pub.getTransactionReceipt({ hash: d.l1TxHash })
		return receipt.status === "success" ? ticketFromReceiptLogs(d, receipt.logs, m) : undefined
	} catch {
		return undefined
	}
}

async function scanForDeposit(
	d: DepositDraft,
	pub: PublicClient,
	m: BridgeManifest,
	from: bigint,
	to: bigint,
): Promise<ClaimTicket | undefined> {
	const account = d.submission?.account
	for (let start = from; start <= to; start += LOG_SCAN_CHUNK) {
		const end = start + LOG_SCAN_CHUNK - 1n < to ? start + LOG_SCAN_CHUNK - 1n : to
		const logs = await pub.getLogs({
			address: m.l1.router,
			event: DEPOSIT_EVENT,
			args: { depositor: account },
			fromBlock: start,
			toBlock: end,
			strict: true,
		})
		const hit = logs.find((l) => isAddressEqual(l.address, m.l1.router) && isThisDeposit(l.args, d))
		if (hit) return { draft: d, messageHash: hit.args.key, leafIndex: hit.args.index, depositor: hit.args.depositor }
	}
	return undefined
}

type Submission = NonNullable<DepositDraft["submission"]>

async function locateDeposit(d: DepositDraft, pub: PublicClient, m: BridgeManifest, s: Submission): Promise<Reconciled> {
	const byHash = await ticketByHash(d, pub, m)
	if (byHash) return byHash
	// A boundary read from another chain could sit above this chain's blocks and make an empty scan look complete.
	const anchor = await pub.getBlock({ blockNumber: s.fromBlock })
	if (anchor.hash !== s.fromBlockHash) throw new NetworkMismatchError(["the recorded scan boundary is not a block of this chain"])
	const fromBlock = s.fromBlock
	// viem caches the tip for seconds; a stale tip below `finalized` would skip blocks the verdict below vouches for.
	const [latest, finalized] = await Promise.all([pub.getBlockNumber({ cacheTime: 0 }), pub.getBlock({ blockTag: "finalized" })])
	const to = latest > finalized.number ? latest : finalized.number
	const found = await scanForDeposit(d, pub, m, fromBlock, to)
	if (found) return found
	// Timestamps only grow, so once a finalized block is past the deadline Permit2 rejects any later inclusion: a deposit
	// that mined at all used its nonce at or below that block, whatever the log index says.
	if (finalized.timestamp <= d.typedData.message.deadline) return "pending"
	return (await permitNonceUsed(d, pub, s.account, finalized.number)) ? "pending" : "not-deposited"
}

/** Set once the permit was used, or its owner cancelled the nonce; the router names its caller as the owner. */
async function permitNonceUsed(d: DepositDraft, pub: PublicClient, owner: Address, blockNumber: bigint): Promise<boolean> {
	const { nonce } = d.typedData.message
	const word = await pub.readContract({
		address: d.typedData.domain.verifyingContract,
		abi: PERMIT2_NONCE_ABI,
		functionName: "nonceBitmap",
		args: [owner, nonce >> 8n],
		blockNumber,
	})
	return ((word >> (nonce & 0xffn)) & 1n) === 1n
}

/**
 * Finds a sent deposit without ever re-sending it: by tx hash first, and whenever that does not establish it (unknown,
 * dropped or replaced hash, lost wallet response) by scanning the router's `Deposit` logs for this draft's depositor
 * and secret hash, from the pre-send finalized block. Any RPC failure reads as "pending"; a manifest for another
 * deployment, or a reader on another chain before or after the scan, throws {@link NetworkMismatchError}.
 */
export async function reconcileDeposit(d: DepositDraft, l1: L1Ctx, m: BridgeManifest): Promise<Reconciled> {
	const s = d.submission
	if (!s) return "not-deposited"
	if (s.chainId !== m.l1.chainId || !isAddressEqual(d.typedData.message.spender, m.l1.router)) {
		throw new NetworkMismatchError([`the manifest is not the deployment this deposit was sent to (chain ${s.chainId})`])
	}
	const pub = l1.publicClient
	try {
		await assertReaderChain(pub, s.chainId)
		const verdict = await locateDeposit(d, pub, m, s)
		await assertReaderChain(pub, s.chainId)
		return verdict
	} catch (e) {
		if (e instanceof NetworkMismatchError) throw e
		return "pending"
	}
}
