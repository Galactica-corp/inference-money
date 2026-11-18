/**
 * Payments under a reference (`pay_private`): a private transfer to a merchant whose note and `PaymentReceived` event
 * the merchant receives offchain, from the payer, so nothing published carries the amount or names the merchant.
 *
 * The merchant hands out a fresh reference per payment ({@link newPaymentRef}); the payer pays it once
 * ({@link payPrivate}, through the same {@link PaymentGate} as requests) and passes the tx's {@link PaymentProof} on;
 * the merchant feeds it to its wallet and checks the event ({@link receivePayment}). The token refuses a second payment
 * of one reference to one merchant (`paid_ref`).
 *
 * Offchain messages are the only copy of the merchant's note: a payer keeps its proof until the merchant has
 * acknowledged it, and a merchant persists every proof it accepts and merges its notes regularly ({@link consolidate}).
 * aztec-nr drops a message not processed within its originating tx's lifetime plus two hours of its anchor (26 h).
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type AztecNode, waitForTx } from "@aztec-labs/aztec.js/node"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import type { Tx } from "@aztec-labs/stdlib/tx"
import { tokenArtifact } from "./artifacts"
import { L2_DONE } from "./claim"
import { ListRefusal, merchantSide, Side, sideCapsule, tokenEvent, withFreshList } from "./merchants"
import { type ListOptions, type PaymentGate, PaymentRefusedError, sendFee } from "./payments"
import { randomSecret } from "./random"
import { TOKEN_REFUSALS } from "./rules"
import { paidRef } from "./stamp"

/** Offchain messages a payment's proof may carry: the note and the event, each one ciphertext. */
const MAX_PROOF_MESSAGES = 16

/** A fresh payment reference, from the platform CSPRNG: whoever knows it can tell whether it was paid. */
export const newPaymentRef = (): Fr => randomSecret()

/** The {@link PaymentGate} key of one reference's payment to one merchant. */
export const refPaymentKey = (token: AztecAddress, merchant: AztecAddress, paymentRef: Fr) =>
	`${token.toString()}:${merchant.toString()}:ref:${paymentRef.toString()}`

/** The marker a payment of `paymentRef` to `merchant` leaves in the nullifier tree. */
export const siloedPaidRef = (token: AztecAddress, merchant: AztecAddress, paymentRef: Fr): Promise<Fr> =>
	siloNullifier(token, paidRef(merchant, paymentRef))

/** Whether `paymentRef` was paid to `merchant` on chain, at the node's `at` tip. */
export async function refPaidOnChain(
	node: Pick<AztecNode, "findLeavesIndexes">,
	token: AztecAddress,
	merchant: AztecAddress,
	paymentRef: Fr,
	at: "latest" | "proposed" | "checkpointed" | "finalized" = "latest",
): Promise<boolean> {
	const [hit] = await node.findLeavesIndexes(at, MerkleTreeId.NULLIFIER_TREE, [await siloedPaidRef(token, merchant, paymentRef)])
	return hit !== undefined
}

export interface RefPaymentIntent {
	from: AztecAddress
	/** A merchant, unless `from` is one. */
	to: AztecAddress
	amount: bigint
	/** The reference the recipient handed out. */
	paymentRef: Fr
}

/** One offchain message of a payment, as JSON-safe strings: what the payer hands the merchant. */
export interface ProofMessage {
	recipient: string
	contractAddress: string
	ciphertext: string[]
	anchorBlockTimestamp: string
}

/** What a payer hands the merchant after paying: the tx and its offchain messages for the merchant. */
export interface PaymentProof {
	txHash: string
	paymentRef: string
	messages: ProofMessage[]
}

type SentMessage = { recipient: AztecAddress; payload: Fr[]; contractAddress: AztecAddress; anchorBlockTimestamp: bigint }

/** The messages `sent` carries for `to` from `token`; throws unless there is at least one (the note and the event). */
export function proofOf(txHash: TxHash, paymentRef: Fr, token: AztecAddress, to: AztecAddress, sent: SentMessage[]): PaymentProof {
	const messages = sent
		.filter((m) => m.recipient.equals(to) && m.contractAddress.equals(token))
		.map((m) => ({
			recipient: m.recipient.toString(),
			contractAddress: m.contractAddress.toString(),
			ciphertext: m.payload.map((f) => f.toString()),
			anchorBlockTimestamp: m.anchorBlockTimestamp.toString(),
		}))
	if (messages.length < 2)
		throw new Error(`The payment ${txHash} returned ${messages.length} messages for ${to}; expected its note and event.`)
	return { txHash: txHash.toString(), paymentRef: paymentRef.toString(), messages }
}

function refusePaymentIntent(p: RefPaymentIntent): void {
	if (p.amount <= 0n) throw new Error("The amount must be positive.")
	if (p.from.equals(p.to)) throw new Error("A payment goes to another account; merge notes with consolidate().")
}

/**
 * Pays `amount` to `to` under `paymentRef` with a wallet built by `gate.bindWallet`, and returns the proof to hand to
 * `to`. Refused before proving when the reference was paid to `to` on chain or is being paid from this client, and when
 * neither side is a merchant. Returns once the payment reaches `opts.wait` (a checkpoint by default). The proof is the
 * only copy of the merchant's note: persist it before anything else, and keep it until the merchant acknowledges it.
 */
export async function payPrivate(
	gate: PaymentGate,
	wallet: Wallet,
	token: AztecAddress,
	p: RefPaymentIntent,
	opts: ListOptions,
): Promise<PaymentProof> {
	if (!gate.isBound(wallet)) throw new Error("payPrivate needs a wallet built on its gate's node, by PaymentGate.bindWallet.")
	refusePaymentIntent(p)
	const fee = sendFee(opts.fee)
	const key = refPaymentKey(token, p.to, p.paymentRef)
	const owner = await gate.reserve(key)
	try {
		if (await refPaidOnChain(gate.node, token, p.to, p.paymentRef)) throw new PaymentRefusedError("completed-on-chain")
		const marker = await siloedPaidRef(token, p.to, p.paymentRef)
		const matches = async (tx: Tx) => tx.data.getNonEmptyNullifiers().some((n) => n.equals(marker))
		const sent = await withFreshList(opts.list, opts.resync, async (list) => {
			const side = merchantSide(list, p.to, p.from, false)
			if (side === Side.Neither) throw new ListRefusal(TOKEN_REFUSALS.transfer)
			const call = Contract.at(token, tokenArtifact, wallet).methods.pay_private!(p.from, p.to, p.amount, p.paymentRef, 0)
			const send = () => call.with({ capsules: [sideCapsule(token, side)] }).send({ from: p.from, fee, wait: NO_WAIT })
			return gate.sendingMatching(key, owner, matches, send)
		})
		const proof = proofOf(sent.txHash, p.paymentRef, token, p.to, sent.offchainMessages)
		const receipt = await waitForTx(gate.node, sent.txHash, { ...(opts.wait ?? L2_DONE), dontThrowOnRevert: true })
		if (receipt.hasExecutionReverted()) {
			throw new Error(
				`The payment ${sent.txHash} was rejected on Aztec, so nothing was paid; the reference takes a new payment once that is final.`,
			)
		}
		return proof
	} finally {
		await gate.releaseUnsent(key, owner)
	}
}

/** Why a merchant refused a payment proof; nothing about the payment was taken in, except where said. */
export type ProofRefusal = "malformed" | "foreign" | "not-mined" | "reverted" | "no-payment" | "underpaid"

export class PaymentProofRefusedError extends Error {
	constructor(
		readonly reason: ProofRefusal,
		detail: string,
	) {
		super(`Payment proof refused (${reason}): ${detail}`)
		this.name = "PaymentProofRefusedError"
	}
}

export interface ReceivedPayment {
	txHash: TxHash
	paymentRef: Fr
	amount: bigint
}

function decodeMessages(proof: PaymentProof, token: AztecAddress, merchant: AztecAddress) {
	const { messages } = proof
	if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_PROOF_MESSAGES) {
		throw new PaymentProofRefusedError("malformed", `expected 1 to ${MAX_PROOF_MESSAGES} messages`)
	}
	const txHash = Fr.fromHexString(proof.txHash)
	return messages.map((m) => {
		if (
			!AztecAddress.fromStringUnsafe(m.recipient).equals(merchant) ||
			!AztecAddress.fromStringUnsafe(m.contractAddress).equals(token)
		) {
			throw new PaymentProofRefusedError("foreign", "a message is for another account or contract")
		}
		return {
			ciphertext: m.ciphertext.map((f) => Fr.fromHexString(f)),
			recipient: merchant,
			tx_hash: txHash,
			anchor_block_timestamp: BigInt(m.anchorBlockTimestamp),
		}
	})
}

async function minedPayment(node: Pick<AztecNode, "getTxReceipt">, txHash: TxHash): Promise<void> {
	const receipt = await node.getTxReceipt(txHash)
	if (!receipt.isMined()) throw new PaymentProofRefusedError("not-mined", `tx ${txHash} is ${receipt.status}`)
	if (receipt.hasExecutionReverted()) throw new PaymentProofRefusedError("reverted", `tx ${txHash} reverted`)
}

/**
 * Takes a payer's proof into `merchant`'s wallet and checks it pays at least `price` under `paymentRef`: the tx is mined
 * and succeeded, its messages are for `merchant` and this token, and the wallet, once it has them, holds a
 * `PaymentReceived` event from that tx for this reference. The PXE accepts a note or event only against the tx's own
 * note hashes and event commitments, so neither can be forged. Persist the proof before calling this, and call it
 * within a day of the payment. Whether this client already served the reference is the caller's to track.
 */
export async function receivePayment(
	wallet: Wallet,
	node: Pick<AztecNode, "getTxReceipt">,
	token: AztecAddress,
	merchant: AztecAddress,
	proof: PaymentProof,
	expected: { paymentRef: Fr; price: bigint },
): Promise<ReceivedPayment> {
	if (proof.paymentRef !== expected.paymentRef.toString())
		throw new PaymentProofRefusedError("malformed", "the proof names another reference")
	const messages = decodeMessages(proof, token, merchant)
	const txHash = TxHash.fromString(proof.txHash)
	await minedPayment(node, txHash)
	await Contract.at(token, tokenArtifact, wallet).methods.offchain_receive!(messages).simulate({ from: merchant })
	const events = await wallet.getPrivateEvents<{ payment_ref: bigint; amount: bigint }>(await tokenEvent("PaymentReceived"), {
		contractAddress: token,
		scopes: [merchant],
		txHash,
	})
	const paid = events.filter((e) => new Fr(e.event.payment_ref).equals(expected.paymentRef))
	if (paid.length !== 1) throw new PaymentProofRefusedError("no-payment", `tx ${txHash} holds ${paid.length} payments of this reference`)
	const amount = BigInt(paid[0]!.event.amount)
	if (amount < expected.price) throw new PaymentProofRefusedError("underpaid", `paid ${amount}, the price is ${expected.price}`)
	return { txHash, paymentRef: expected.paymentRef, amount }
}

/**
 * Merges `merchant`'s private notes into one it sends itself, delivered on chain under a tag only its own keys find, so
 * the funds no longer depend on stored offchain messages. A send to oneself proves no merchant side and announces
 * nothing. `amount` defaults to the whole private balance; a balance spread over very many notes may need smaller
 * steps. Returns undefined when there is nothing to merge.
 */
export async function consolidate(
	wallet: Wallet,
	node: Pick<AztecNode, "getTxReceipt">,
	token: AztecAddress,
	merchant: AztecAddress,
	opts: Pick<ListOptions, "fee" | "wait"> & { amount?: bigint },
): Promise<TxHash | undefined> {
	const methods = Contract.at(token, tokenArtifact, wallet).methods
	const amount = opts.amount ?? BigInt((await methods.balance_of_private!(merchant).simulate({ from: merchant })).result)
	if (amount <= 0n) return undefined
	const call = methods.transfer_private_to_private!(merchant, merchant, amount, 0)
	const { txHash } = await call
		.with({ capsules: [sideCapsule(token, Side.Neither)] })
		.send({ from: merchant, fee: sendFee(opts.fee), wait: NO_WAIT })
	await waitForTx(node as AztecNode, txHash, opts.wait ?? L2_DONE)
	return txHash
}
