/**
 * Payment requests on the merchant token: open one, find its stamp, and pay it at most once from one client.
 *
 * A request is a partial note's commitment. The token takes one payment into it, refusing a second only once it reaches
 * the chain, after its proof (and, publicly, its fee). `payRequest` therefore refuses a request completed on chain, or
 * one this client has paid or is paying, through one {@link PaymentRecord} per request in an injected
 * {@link PaymentStore}:
 * - `reserved`, under the store's lock before anything is simulated; a failure before the send releases it;
 * - `sent`, written by the {@link PaymentGate}, whose node the payer's wallet must be built on, between proving and the
 *   node receiving the tx, with the tx's hash and expiry. Only finalized chain state moves it on: to `paid` with the
 *   tx, or released once the tx's revert, or the chain passing its expiry without it, is final. So an uncertain send
 *   never allows a second one;
 * - `paid`;
 * - `replaced`, by the request opened in place of a stale one ({@link payReplacingStale}); every later attempt on
 *   the stale one is refused as `replaced`, and only {@link payReplacingStale} follows it.
 * Clients that share no store (two devices) can still both prove a payment; the token lands one.
 *
 * A private payment through a stamp caps the tx's expiry at the stamp's deadline. While the stamp is fresh that cap is
 * above the expiry every tx commits; later, the shorter expiry would tell an observer the request's age. So a user's
 * private payment through a stamp no longer fresh is refused as `stale`: before proving, and at the gate on the proven
 * tx's committed expiry, which is the guarantee.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type AztecNode, waitForTx } from "@aztec-labs/aztec.js/node"
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/sync"
import { FunctionSelector } from "@aztec-labs/stdlib/abi"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import { SiloedTag, Tag } from "@aztec-labs/stdlib/logs"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import type { OffchainEffect, Tx } from "@aztec-labs/stdlib/tx"
import { tokenArtifact } from "./artifacts"
import { type FeeChoice, L2_DONE, type L2Wait } from "./claim"
import {
	ListRefusal,
	MERCHANT_MAX_DELAY,
	type MerchantList,
	merchantSide,
	merchantStatus,
	paymentSide,
	Side,
	sideCapsule,
	withFreshList,
} from "./merchants"
import { TOKEN_REFUSALS } from "./rules"
import { bucketCapsule, liveBuckets, REQUEST_OPENED_EFFECT, type RequestStamp, requestStampAt, STANDARD_TX_LIFETIME, stamp } from "./stamp"

/** aztec-nr's DOM_SEP__NOTE_COMPLETION_LOG_TAG (`note/partial_note.nr`): tags the log every completion emits. */
const DOM_SEP__NOTE_COMPLETION_LOG_TAG = 3372669888
/** The kernel's cap on a tx's lifetime (MAX_TX_LIFETIME): no tx outlives its anchor by more. */
const MAX_TX_LIFETIME = 86_400n
/** How long a reservation blocks other clients before it counts as abandoned; the gate refuses a superseded one. */
export const RESERVATION_TTL_MS = 10 * 60_000

export type PaymentRecord =
	| { state: "reserved"; owner: string; since: number }
	| { state: "sent"; owner: string; txHash: string; expiresAt: string }
	| { state: "paid"; txHash: string }
	| { state: "replaced"; by: string }

/** One record per request, shared by every tab or process that pays from this client. */
export interface PaymentStore {
	/** Runs `fn` holding the exclusive lock for `key`; every read-modify-write of a record runs inside one. */
	locked<T>(key: string, fn: () => Promise<T>): Promise<T>
	get(key: string): Promise<PaymentRecord | undefined>
	put(key: string, record: PaymentRecord | undefined): Promise<void>
}

/** A store for one process (a CLI run, tests): records in memory, one promise-chain lock per key. */
export function memoryPaymentStore(): PaymentStore {
	const records = new Map<string, PaymentRecord>()
	const tails = new Map<string, Promise<unknown>>()
	return {
		locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
			const run = (tails.get(key) ?? Promise.resolve()).then(fn)
			tails.set(
				key,
				run.catch(() => undefined),
			)
			return run
		},
		get: async (key) => records.get(key),
		put: async (key, record) => {
			if (record) records.set(key, record)
			else records.delete(key)
		},
	}
}

export type PaymentRefusal = "paid" | "in-flight" | "completed-on-chain" | "stale" | "replaced"

const REFUSAL_TEXT: Record<PaymentRefusal, string> = {
	paid: "This request is already paid.",
	"in-flight": "This request is already being paid; wait for that payment to settle.",
	"completed-on-chain": "This request was already paid on chain; it takes no second payment.",
	stale: "This request is too old to pay without marking the payment; ask for a new one.",
	replaced: "This request was replaced by a newer one; pay that one instead.",
}

/** `payRequest` refused before anything was sent. */
export class PaymentRefusedError extends Error {
	constructor(
		readonly reason: PaymentRefusal,
		readonly txHash?: string,
	) {
		super(txHash ? `${REFUSAL_TEXT[reason]} (tx ${txHash})` : REFUSAL_TEXT[reason])
		this.name = "PaymentRefusedError"
	}
}

export type PaymentNode = Pick<
	AztecNode,
	"sendTx" | "getTxReceipt" | "getBlockData" | "findLeavesIndexes" | "getPrivateLogsByTags" | "getPublicLogsByTags"
>

export const paymentKey = (token: AztecAddress, commitment: Fr) => `${token.toString()}:${commitment.toString()}`

const completionTag = (commitment: Fr) => new Tag(poseidon2HashWithSeparator([commitment], DOM_SEP__NOTE_COMPLETION_LOG_TAG))

/** The first field of the private log a private payment into `commitment` emits, as the node indexes it. */
export async function siloedCompletionTag(token: AztecAddress, commitment: Fr): Promise<Fr> {
	return (await SiloedTag.computeFromTagAndApp(completionTag(commitment), token)).value
}

/** How many times `commitment` was completed on chain, privately or publicly; its recipient discovers only the first. */
export async function completionCount(
	node: Pick<AztecNode, "getPrivateLogsByTags" | "getPublicLogsByTags">,
	token: AztecAddress,
	commitment: Fr,
): Promise<number> {
	const tag = completionTag(commitment)
	const [[privateLogs], [publicLogs]] = await Promise.all([
		node.getPrivateLogsByTags({ tags: [await SiloedTag.computeFromTagAndApp(tag, token)] }),
		node.getPublicLogsByTags({ contractAddress: token, tags: [tag] }),
	])
	return (privateLogs?.length ?? 0) + (publicLogs?.length ?? 0)
}

/**
 * The newest stamp of `commitment` live at the node's latest block, its candidates checked in one node call; undefined
 * when none is live (the request was not opened for a merchant, or more than a day ago).
 */
export async function requestStamp(
	node: Pick<AztecNode, "findLeavesIndexes" | "getBlockData">,
	token: AztecAddress,
	commitment: Fr,
): Promise<RequestStamp | undefined> {
	const at = await timestampAt(node, "latest")
	if (at === undefined) throw new Error("The node has no latest block.")
	const buckets = liveBuckets(at)
	const leaves = await Promise.all(buckets.map((b) => siloNullifier(token, stamp(commitment, b))))
	const found = await node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, leaves)
	const i = found.findIndex((f) => f !== undefined)
	return i < 0 ? undefined : requestStampAt(buckets[i]!, at)
}

/** The commitment an opening handed its sender as `[REQUEST_OPENED_EFFECT, c]`; throws unless the tx opened exactly one. */
export function openedCommitment(effects: readonly OffchainEffect[], token: AztecAddress): Fr {
	const opened = effects.filter((e) => e.contractAddress.equals(token) && e.data.length === 2 && e.data[0]!.equals(REQUEST_OPENED_EFFECT))
	if (opened.length !== 1) throw new Error(`Expected the tx to open one request, but it opened ${opened.length}.`)
	return opened[0]!.data[1]!
}

/**
 * Who pays a payment call's fee, a public field of every tx: a payment method, the sponsor's keeping the account out of
 * it, or "account-public", the sending account from its own Fee Juice, named as the payer of the opening, transfer or
 * payment. There is no default: the account's payment is a choice to publish it.
 */
export type PaymentFee = { paymentMethod: FeePaymentMethod } | Extract<FeeChoice, "account-public">

// An untyped caller can omit the fee, which the wallet would read as the account paying.
function sendFee(fee: PaymentFee): { paymentMethod: FeePaymentMethod } | undefined {
	if (fee === "account-public") return undefined
	if (!fee?.paymentMethod) throw new Error('Name the fee payer: a sponsor\'s payment method, or "account-public".')
	return fee
}

export interface ListOptions {
	/**
	 * Synced just before the call ({@link syncMerchantList}): sides are judged at its block, so a list kept for hours can
	 * prove a merchant whose read has since come to cap the tx early, naming it.
	 */
	list: MerchantList
	/** Re-syncs the list; a call refused on a merchant rule before its send is retried once on the fresh one. */
	resync?: () => Promise<MerchantList>
	fee: PaymentFee
	/** How far {@link openRequest} and {@link payRequest} wait for their tx; default {@link L2_DONE}. */
	wait?: L2Wait
}

export interface RequestIntent {
	/** The account sending the opening tx: the recipient itself, or a merchant opening one for another account. */
	from: AztecAddress
	/** The account the payment reaches. */
	to: AztecAddress
	/** The only account that can pay into it. */
	completer: AztecAddress
}

const OPENER_REFUSAL = "Only a merchant opens a request for another account: ask the merchant to open it."

/** A merchant at the list's block and after any change it has scheduled lands, which is never later than the delay's maximum. */
const staysMerchant = (list: MerchantList, account: AztecAddress) =>
	merchantStatus(list, account).merchant && merchantStatus(list, account, list.at + MERCHANT_MAX_DELAY).merchant

/**
 * Opens a request and returns once it reaches `opts.wait` (a checkpoint by default), when a payer's PXE, anchored at
 * the proposed tip, can prove its stamp. Refused before proving unless the recipient or the creator is a merchant, and
 * when anyone but a merchant opens one for another account; a merchant recipient's request is stamped. The opener's
 * status is read from `opts.list`: one kept over an hour can miss a switch-off scheduled since.
 */
export async function openRequest(
	wallet: Wallet,
	node: Pick<AztecNode, "getTxReceipt">,
	token: AztecAddress,
	r: RequestIntent,
	opts: ListOptions,
): Promise<{ commitment: Fr; txHash: TxHash }> {
	const fee = sendFee(opts.fee)
	const sent = await withFreshList(opts.list, opts.resync, async (list) => {
		// An opening for another account announces that account once per pair: a user opening for its merchant would
		// publish whom it pays, and the token proves the merchant recipient's side whoever opens.
		if (!r.from.equals(r.to) && !staysMerchant(list, r.from)) throw new Error(OPENER_REFUSAL)
		const side = merchantSide(list, r.to, r.from, true)
		if (side === Side.Neither) throw new ListRefusal(TOKEN_REFUSALS.request)
		const open = Contract.at(token, tokenArtifact, wallet).methods.initialize_transfer_commitment!(r.to, r.completer)
		return open.with({ capsules: [sideCapsule(token, side)] }).send({ from: r.from, fee, wait: NO_WAIT })
	})
	const commitment = openedCommitment(sent.offchainEffects, token)
	await waitForTx(node as AztecNode, sent.txHash, opts.wait ?? L2_DONE)
	return { commitment, txHash: sent.txHash }
}

/**
 * A private transfer, which the rules allow only to or from a merchant, or to the sender itself (a note merge, which
 * proves no side and so reads no entry); refused before proving otherwise. Returns once sent: the caller waits for the
 * status it needs.
 */
export async function transferPrivate(
	wallet: Wallet,
	token: AztecAddress,
	t: { from: AztecAddress; to: AztecAddress; amount: bigint },
	opts: ListOptions,
): Promise<TxHash> {
	const fee = sendFee(opts.fee)
	const toSelf = t.from.equals(t.to)
	const sent = await withFreshList(opts.list, opts.resync, async (list) => {
		const side = toSelf ? Side.Neither : merchantSide(list, t.to, t.from, false)
		if (side === Side.Neither && !toSelf) throw new ListRefusal(TOKEN_REFUSALS.transfer)
		const call = Contract.at(token, tokenArtifact, wallet).methods.transfer_private_to_private!(t.from, t.to, t.amount, 0)
		return call.with({ capsules: [sideCapsule(token, side)] }).send({ from: t.from, fee, wait: NO_WAIT })
	})
	return sent.txHash
}

interface Expected {
	owner: string
	token: AztecAddress
	commitment: Fr
	siloedTag: Fr
	/** A private payment into a stamped request: refused unless it commits the standard expiry. */
	unmarked: boolean
}

let publicPaySelector: Promise<Fr> | undefined

/** The selector the token's `transfer_public_to_commitment` calldata starts with. */
function publicPay(): Promise<Fr> {
	publicPaySelector ??= (async () => {
		const fn = tokenArtifact.nonDispatchPublicFunctions.find((f) => f.name === "transfer_public_to_commitment")
		if (!fn) throw new Error("the token artifact has no transfer_public_to_commitment")
		return (await FunctionSelector.fromNameAndParameters(fn.name, fn.parameters)).toField()
	})()
	return publicPaySelector
}

/**
 * Whether `tx` pays into `e`'s request: privately, its completion log carries the request's siloed tag, which only the
 * token can emit; publicly, it calls the token's `transfer_public_to_commitment(from, commitment, amount, nonce)`.
 */
async function pays(tx: Tx, e: Expected): Promise<boolean> {
	if (tx.data.getNonEmptyPrivateLogs().some((log) => log.fields[0].equals(e.siloedTag))) return true
	const selector = await publicPay()
	return tx
		.getPublicCallRequestsWithCalldata()
		.some(
			({ request, calldata }) =>
				request.contractAddress.equals(e.token) && !!calldata[0]?.equals(selector) && !!calldata[2]?.equals(e.commitment),
		)
}

async function timestampAt(node: Pick<AztecNode, "getBlockData">, tag: "latest" | "finalized"): Promise<bigint | undefined> {
	return (await node.getBlockData(tag))?.header.globalVariables.timestamp
}

/** Whether `tx` commits an expiry under the standard one, which only state it read can cause. */
const shortLived = (tx: Tx): boolean =>
	tx.data.expirationTimestamp < tx.data.constants.anchorBlockHeader.globalVariables.timestamp + STANDARD_TX_LIFETIME

/**
 * What the chain proves about a sent tx expiring at `expiresAt`: "gone" once it reverted in a finalized block or a
 * finalized block passed its expiry without it, "landed" once finalized without a revert. A prune can undo any block
 * short of finalized, and a node's "dropped" says nothing of other nodes' mempools, so anything else is "unsettled".
 * The finalized boundary is read before the receipt: a tx included meanwhile then shows in the receipt, never as an
 * absence past expiry. That holds for one node's view, not across nodes behind a balancer.
 */
export async function finalFate(
	node: Pick<AztecNode, "getTxReceipt" | "getBlockData">,
	txHash: string,
	expiresAt: bigint,
): Promise<"landed" | "gone" | "unsettled"> {
	const finalizedAt = (await timestampAt(node, "finalized")) ?? 0n
	const receipt = await node.getTxReceipt(TxHash.fromString(txHash))
	if (receipt.isMined() && receipt.status === TxStatus.FINALIZED) return receipt.hasExecutionReverted() ? "gone" : "landed"
	if (receipt.isMined() || receipt.isPending()) return "unsettled"
	return finalizedAt > expiresAt ? "gone" : "unsettled"
}

/** What a `sent` record becomes on the node's current view; undefined releases it. */
async function settle(r: Extract<PaymentRecord, { state: "sent" }>, node: PaymentNode): Promise<PaymentRecord | undefined> {
	const fate = await finalFate(node, r.txHash, BigInt(r.expiresAt))
	if (fate === "unsettled") return r
	return fate === "landed" ? { state: "paid", txHash: r.txHash } : undefined
}

async function refreshed(r: PaymentRecord | undefined, node: PaymentNode, now: number): Promise<PaymentRecord | undefined> {
	if (r?.state === "sent") return settle(r, node)
	if (r?.state === "reserved" && now - r.since > RESERVATION_TTL_MS) return undefined
	return r
}

function refusalFor(r: PaymentRecord | undefined): PaymentRefusedError {
	if (r?.state === "paid") return new PaymentRefusedError("paid", r.txHash)
	if (r?.state === "replaced") return new PaymentRefusedError("replaced")
	return new PaymentRefusedError("in-flight", r?.state === "sent" ? r.txHash : undefined)
}

/**
 * The payment records plus the node a payer's wallet sends through ({@link PaymentGate.bindWallet}): every payment tx
 * is recorded as `sent` (hash and expiry) after proving and before the node receives it, and an attempt whose
 * reservation was superseded never reaches the node.
 */
export class PaymentGate {
	readonly node: AztecNode
	private readonly expected = new Map<string, Expected>()
	private readonly bound = new WeakSet<object>()
	/** The attempts whose payment tx this gate recorded as `sent`; the chain, not their send's response, settles them. */
	private readonly recorded = new Set<string>()

	constructor(
		node: AztecNode,
		readonly store: PaymentStore,
		private readonly now: () => number = Date.now,
	) {
		this.node = new Proxy(node, {
			get: (target, key, receiver) =>
				key === "sendTx" ? (tx: Tx) => this.recordThenSend(target, tx) : Reflect.get(target, key, receiver),
		})
	}

	/** Builds a payer's wallet on this gate's node; `payRequest` refuses a wallet built any other way. */
	async bindWallet<W extends object>(create: (node: AztecNode) => Promise<W>): Promise<W> {
		const wallet = await create(this.node)
		this.bound.add(wallet)
		return wallet
	}

	isBound(wallet: object): boolean {
		return this.bound.has(wallet)
	}

	/** The request's record as the chain now settles it (`paid`, released, or unchanged). */
	status(key: string): Promise<PaymentRecord | undefined> {
		return this.store.locked(key, async () => {
			const current = await this.store.get(key)
			const next = await refreshed(current, this.node, this.now())
			if (next !== current) await this.store.put(key, next)
			return next
		})
	}

	/** Claims `key` for one payment attempt, or throws {@link PaymentRefusedError}; returns the attempt's owner id. */
	reserve(key: string): Promise<string> {
		return this.store.locked(key, async () => {
			const current = await refreshed(await this.store.get(key), this.node, this.now())
			if (current) {
				await this.store.put(key, current)
				throw refusalFor(current)
			}
			const owner = crypto.randomUUID()
			await this.store.put(key, { state: "reserved", owner, since: this.now() })
			return owner
		})
	}

	/** Releases `owner`'s reservation if nothing was sent under it. */
	releaseUnsent(key: string, owner: string): Promise<void> {
		return this.store.locked(key, async () => {
			const r = await this.store.get(key)
			if (r?.state === "reserved" && r.owner === owner) await this.store.put(key, undefined)
		})
	}

	/**
	 * Refuses `owner`'s attempt as `stale` while it still holds the request's reservation, so nothing is in flight or
	 * paid for the request from this client; otherwise as whatever holds the request now.
	 */
	refuseStale(key: string, owner: string): Promise<never> {
		return this.store.locked(key, async () => {
			const r = await this.store.get(key)
			throw r?.state === "reserved" && r.owner === owner ? new PaymentRefusedError("stale") : refusalFor(r)
		})
	}

	/**
	 * The request that replaces `key`'s stale one: the one already recorded, else the one `reopen` opens now, recorded
	 * under the lock it held throughout, so attempts that meet the same stale request pay one replacement. Refused, as
	 * {@link PaymentGate.reserve} would, while another attempt holds the stale request.
	 */
	replacing(key: string, reopen: () => Promise<Fr>): Promise<Fr> {
		return this.store.locked(key, async () => {
			const r = await refreshed(await this.store.get(key), this.node, this.now())
			if (r?.state === "replaced") return Fr.fromHexString(r.by)
			if (r) throw refusalFor(r)
			const by = await reopen()
			await this.store.put(key, { state: "replaced", by: by.toString() })
			return by
		})
	}

	/**
	 * Runs `send` with `owner`'s payment into `commitment` expected at the node. One attempt per request at a time: a
	 * second one, possible once the first's reservation lapsed, is refused rather than sharing the expectation. An
	 * `unmarked` payment is refused as {@link PaymentGate.refuseStale} unless it commits the standard expiry.
	 */
	async sending(
		key: string,
		owner: string,
		token: AztecAddress,
		commitment: Fr,
		send: () => Promise<TxHash>,
		unmarked = false,
	): Promise<TxHash> {
		const siloedTag = await siloedCompletionTag(token, commitment)
		if (this.expected.has(key)) throw new PaymentRefusedError("in-flight")
		this.expected.set(key, { owner, token, commitment, siloedTag, unmarked })
		try {
			const txHash = await send()
			if (!this.recorded.has(owner)) await this.recordMissed(key, owner, txHash)
			return txHash
		} finally {
			this.recorded.delete(owner)
			if (this.expected.get(key)?.owner === owner) this.expected.delete(key)
		}
	}

	private async recordThenSend(target: AztecNode, tx: Tx): Promise<void> {
		for (const [key, e] of this.expected) {
			if (!(await pays(tx, e))) continue
			if (e.unmarked && shortLived(tx)) await this.refuseStale(key, e.owner)
			await this.recordSent(key, e.owner, tx.getTxHash().toString(), tx.data.expirationTimestamp)
		}
		return target.sendTx(tx)
	}

	private recordSent(key: string, owner: string, txHash: string, expiresAt: bigint): Promise<void> {
		return this.store.locked(key, async () => {
			const r = await this.store.get(key)
			if (r?.state !== "reserved" || r.owner !== owner) throw refusalFor(r)
			await this.store.put(key, { state: "sent", owner, txHash, expiresAt: expiresAt.toString() })
			this.recorded.add(owner)
		})
	}

	/**
	 * A send the gate never saw is out all the same. It is recorded, with the longest expiry it can have, only over the
	 * attempt's own reservation: by the time a late response arrives the record may belong to a successor, which it must
	 * never overwrite.
	 */
	private async recordMissed(key: string, owner: string, txHash: TxHash): Promise<void> {
		const recorded = await this.store.locked(key, async () => {
			const r = await this.store.get(key)
			if (r?.state !== "reserved" || r.owner !== owner) return false
			const expiresAt = ((await timestampAt(this.node, "latest")) ?? 0n) + MAX_TX_LIFETIME
			await this.store.put(key, { state: "sent", owner, txHash: txHash.toString(), expiresAt: expiresAt.toString() })
			return true
		})
		const outcome = recorded ? "it is recorded as sent" : "a newer record holds the request, so it could not be recorded"
		throw new Error(`Payment ${txHash} was sent without passing the payment gate; ${outcome}.`)
	}
}

export interface PaymentIntent {
	from: AztecAddress
	commitment: Fr
	amount: bigint
	/** From the payer's private balance, or its public one. */
	kind: "private" | "public"
}

/** A private payment through the stamp names its bucket, sparing the token's search. */
function paymentCall(wallet: Wallet, token: AztecAddress, p: PaymentIntent, side: Side, bucket: bigint | undefined) {
	const methods = Contract.at(token, tokenArtifact, wallet).methods
	if (p.kind === "public") return methods.transfer_public_to_commitment!(p.from, p.commitment, p.amount, 0)
	const capsules = [sideCapsule(token, side), ...(bucket === undefined ? [] : [bucketCapsule(token, bucket)])]
	return methods.transfer_private_to_commitment!(p.from, p.commitment, p.amount, 0).with({ capsules })
}

/**
 * Pays `amount` into a request with a wallet built by `gate.bindWallet`. Refused before anything is proven when the
 * request is completed on chain, paid or being paid from this client (see {@link PaymentGate}), has no live stamp and
 * a user pays it, or a private payment would prove a stamp no longer fresh (`stale`: open a new request); a private
 * payment into a stamped request is refused as `stale` too if its proof commits a shortened expiry. Returns
 * once the payment reaches `opts.wait` (a checkpoint by default); its record turns `paid` when finalized
 * ({@link PaymentGate.status}).
 */
export async function payRequest(
	gate: PaymentGate,
	wallet: Wallet,
	token: AztecAddress,
	p: PaymentIntent,
	opts: ListOptions,
): Promise<TxHash> {
	if (!gate.isBound(wallet)) throw new Error("payRequest needs a wallet built on its gate's node, by PaymentGate.bindWallet.")
	const fee = sendFee(opts.fee)
	const key = paymentKey(token, p.commitment)
	const owner = await gate.reserve(key)
	try {
		if ((await completionCount(gate.node, token, p.commitment)) > 0) throw new PaymentRefusedError("completed-on-chain")
		const found = await requestStamp(gate.node, token, p.commitment)
		const txHash = await withFreshList(opts.list, opts.resync, async (list) => {
			const side = paymentSide(list, found, p.from)
			if (side === Side.Neither) throw new ListRefusal(TOKEN_REFUSALS.payment)
			const throughStamp = p.kind === "private" && side === Side.First
			if (throughStamp && found?.state === "live") await gate.refuseStale(key, owner)
			const call = paymentCall(wallet, token, p, side, throughStamp ? found?.bucket : undefined)
			const send = async () => (await call.send({ from: p.from, fee, wait: NO_WAIT })).txHash
			// A merchant payer's read can shorten between `found.at` and the proving anchor; a stamp it could have used would not name it.
			return gate.sending(key, owner, token, p.commitment, send, p.kind === "private" && found !== undefined)
		})
		const receipt = await waitForTx(gate.node, txHash, { ...(opts.wait ?? L2_DONE), dontThrowOnRevert: true })
		if (receipt.hasExecutionReverted()) {
			throw new Error(
				`The payment ${txHash} was rejected on Aztec, so nothing was paid; the request takes a new payment once that is final.`,
			)
		}
		return txHash
	} finally {
		await gate.releaseUnsent(key, owner)
	}
}

/**
 * Pays into `stored`, or, when and only when {@link payRequest} refuses it as `stale` or `replaced`, into its
 * replacement: the one another attempt already opened, else the one `reopen` opens ({@link PaymentGate.replacing}),
 * following replacements that went stale in turn and opening at most one. `stale` means nothing is in flight or paid for a request from this
 * client, and every attempt shares one replacement, so it is not a second payment; any other refusal is thrown as is.
 */
export async function payReplacingStale<T>(
	gate: PaymentGate,
	token: AztecAddress,
	stored: Fr,
	pay: (commitment: Fr) => Promise<T>,
	reopen: () => Promise<Fr>,
): Promise<T> {
	let commitment = stored
	let opened = false
	const open = () => {
		opened = true
		return reopen()
	}
	for (;;) {
		try {
			return await pay(commitment)
		} catch (e) {
			const replaceable = e instanceof PaymentRefusedError && (e.reason === "stale" || e.reason === "replaced")
			if (!replaceable || opened) throw e
			commitment = await gate.replacing(paymentKey(token, commitment), open)
		}
	}
}
