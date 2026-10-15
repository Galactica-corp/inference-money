import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import {
	type BridgeManifest,
	type ClaimConsent,
	type ClaimTicket,
	claimBinding,
	type DepositDraft,
	decodeClaimTicket,
	decodeDepositDraft,
	depositsOpen,
	ExitRevertedError,
	encodeTicket,
	exitToL1,
	finalFate,
	isClaimConsumed,
	L2_PROPOSED,
	type ListOptions,
	openRequest,
	payReplacingStale,
	payRequest,
	reconcileDeposit,
	syncMerchantList,
	TOKEN_REFUSALS,
} from "@galactica-net/inference-money-core"
import {
	aztecWorld,
	castClaim,
	castDeposit,
	type DemoL1,
	type DemoSession,
	demoL1,
	depositWorld,
	HIDDEN,
	l1CtxOf,
	MERCHANTS,
	type Merchant,
	type SentTx,
	sendPrivate,
	sponsoredFee,
	type Tour,
	type TourStepId,
	totalSupplySlot,
	type User,
	usdcOf,
} from "@galactica-net/inference-money-demo"
import type { PendingDeposit, PendingExit, Tickets } from "@/demo/tickets"
import type { DemoWallet } from "@/demo/wallet"
import { type Explorer, type FeedRow, PUBLIC_TEXT, rowOf } from "@/tour/player"
import { HOLDER_NAME } from "@/ui/cards"
import { usdc2 } from "@/ui/format"
import type { Stage } from "@/ui/Verdict"
import { DEPOSITS_CLOSED, type LiveAction, type ValidDraft } from "./draft"
import { classify, type Outcome } from "./outcome"

export interface LiveCtx {
	demo: DemoWallet
	m: BridgeManifest
	l1RpcUrl: string
	tickets: Tickets
	tour: Tour
	explorer: Explorer | undefined
	/** Requests opened and not paid yet, by `payee>payer`: a payment uses one before opening its own. */
	requests: Map<string, Fr>
	/** Asks the visitor a yes/no question; `window.confirm` by default. */
	confirm?: (question: string) => boolean
}

export type Report = (stage: Stage, detail?: string) => void

type TxKind = keyof typeof HIDDEN

/** About what a deposit and its approval cost on Ethereum in gas; below it, the lane replays. */
const MIN_GAS_WEI = 10n ** 15n
const DUPLICATE_NULLIFIER = /Existing nullifier|Duplicate nullifier/i

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
// The page answers at a proposed block, seconds after the send: its PXE anchors there and the node refuses a double
// spend against it. A claim or payment a prune would undo is never forgotten before finality; an exit's revert is
// believed at a checkpoint.
const session = (ctx: LiveCtx): DemoSession => ({ wallet: ctx.demo.wallet, node: ctx.demo.node, m: ctx.m, wait: L2_PROPOSED })
const token = (ctx: LiveCtx) => AztecAddress.fromStringUnsafe(ctx.m.l2.token.address)
const address = (ctx: LiveCtx, who: ValidDraft["to"]) => ctx.demo.cast[who as User | Merchant].address
const isMerchant = (who: string): boolean => (MERCHANTS as readonly string[]).includes(who)

async function listOptions(ctx: LiveCtx): Promise<ListOptions> {
	return { list: await syncMerchantList(ctx.demo.node, token(ctx)), fee: sponsoredFee(ctx.m), wait: L2_PROPOSED }
}

/** The public rows of the txs this page sent since `since` and the node holds, decoded as the recording was. */
async function aztecRows(ctx: LiveCtx, since: number, kinds: readonly TxKind[]): Promise<FeedRow[]> {
	const slot = await totalSupplySlot(ctx.m)
	const rows: FeedRow[] = []
	for (const [i, s] of ctx.demo.sent.slice(since).entries()) {
		const kind = kinds[Math.min(i, kinds.length - 1)] as TxKind
		const effect = await ctx.demo.node.getTxEffect(TxHash.fromString(s.hash))
		if (!effect) continue
		const items = aztecWorld(effect.data, { feePayer: s.feePayer, expiresAt: s.expiresAt }, [slot], HIDDEN[kind])
		const href = ctx.explorer && `${ctx.explorer.l2Tx}${s.hash}`
		rows.push({ key: s.hash, source: "live", chain: "aztec", text: PUBLIC_TEXT[kind], items, href })
	}
	return rows
}

/** The recorded step instead of a live one the demo cannot afford right now, said so in the verdict and the feed. */
export function replay(ctx: LiveCtx, step: TourStepId, why: string): Outcome {
	const recorded = ctx.tour.steps.find((s) => s.id === step)
	if (!recorded) return { kind: "failed", detail: why }
	return {
		kind: "settled",
		detail: `${why} This replays the recorded run instead, so nothing moved now.`,
		rows: [rowOf(recorded, ctx.explorer)],
	}
}

/** Why `signer` cannot pay for a deposit of `amount` now, or nothing when it can. */
async function shortfall(signer: DemoL1, m: BridgeManifest, amount: bigint): Promise<string | undefined> {
	const who = signer.account.address
	const [eth, usdc] = await Promise.all([signer.publicClient.getBalance({ address: who }), usdcOf(signer, m, who)])
	if (usdc < amount) return `This Ethereum wallet holds ${usdc2(usdc)} demo USDC, less than that.`
	if (eth < MIN_GAS_WEI) return "This Ethereum wallet has no gas money left."
	return undefined
}

async function deposit(ctx: LiveCtx, d: ValidDraft, report: Report): Promise<Outcome> {
	const user = d.actor as User
	const amount = d.amount as bigint
	const signer = demoL1(ctx.l1RpcUrl, ctx.m, user)
	// The page's notice is opening-time state: a rollup switch since then must stop the deposit before it signs.
	if (!(await depositsOpen(signer.publicClient, ctx.m))) return { kind: "failed", detail: DEPOSITS_CLOSED }
	const short = await shortfall(signer, ctx.m, amount)
	if (short) return user === "alice" ? replay(ctx, "deposit", short) : { kind: "failed", detail: short }
	const pending = { id: crypto.randomUUID(), user, since: Date.now() }
	const plan = { from: user, to: address(ctx, user), kind: "private", amount } as const
	const t = await castDeposit(
		session(ctx),
		signer,
		plan,
		undefined,
		(draft) => ctx.tickets.putDeposit({ ...pending, draft: encodeTicket("draft", draft) }),
		(stage) => report(stage === "confirming" ? "settle" : "send"),
	)
	ctx.tickets.putDeposit({ ...pending, claim: encodeTicket("claim", t) })
	const href = ctx.explorer && t.draft.l1TxHash && `${ctx.explorer.l1Tx}${t.draft.l1TxHash}`
	const row: FeedRow = { key: t.messageHash, source: "live", chain: "ethereum", text: PUBLIC_TEXT.deposit, items: depositWorld(t), href }
	return { kind: "settled", detail: `Deposited. ${HOLDER_NAME[user]} can claim it once the message reaches Aztec.`, rows: [row] }
}

const NOTHING_TO_CLAIM = "There is nothing to claim: deposit first."
/** A consumed message cannot tell a claim from a return, so it is never reported as a mint. */
const ALREADY_CONSUMED = "That deposit was already taken on Aztec, by an earlier claim or a return, so nothing was minted now."

/**
 * Whether `p`'s claim still holds at the proposed tip, where this page claims. One no longer there was pruned, which
 * makes the deposit claimable again; one the node calls finalized is marked final, and kept.
 */
async function stillClaimed(ctx: LiveCtx, p: PendingDeposit, t: ClaimTicket): Promise<boolean> {
	if (await isClaimConsumed(t, ctx.demo.node, ctx.m, "finalized")) {
		ctx.tickets.putDeposit({ ...p, final: true })
		return true
	}
	return isClaimConsumed(t, ctx.demo.node, ctx.m, "proposed")
}

type Claimable = { p: PendingDeposit; ticket: ClaimTicket } | string

const NOT_ON_ETHEREUM =
	"Ethereum shows no sign of that deposit, and its signature has expired, so it can no longer go through. This page keeps its record below: check it again later, or deposit again."

const readerOf = (ctx: LiveCtx, p: PendingDeposit) => l1CtxOf(demoL1(ctx.l1RpcUrl, ctx.m, p.user))

async function fromDraft(ctx: LiveCtx, p: PendingDeposit, draft: DepositDraft): Promise<Claimable> {
	const found = await reconcileDeposit(draft, readerOf(ctx, p), ctx.m)
	if (found === "pending") return "That deposit is still confirming on Ethereum; try again in a minute."
	if (found === "not-deposited") {
		ctx.tickets.putDeposit({ ...p, archived: true })
		return NOT_ON_ETHEREUM
	}
	const next = { ...p, draft: undefined, claim: encodeTicket("claim", found) }
	ctx.tickets.putDeposit(next)
	return { p: next, ticket: found }
}

/** `p`'s records, decoded; nothing when they no longer decode, since such an entry can neither claim nor be shown. */
function decodedDeposit(p: PendingDeposit): { draft?: DepositDraft; ticket?: ClaimTicket } | undefined {
	try {
		const ticket = p.claim ? decodeClaimTicket(p.claim) : undefined
		if (ticket && !claimReadable(ticket)) return undefined
		return { draft: p.draft ? decodeDepositDraft(p.draft) : undefined, ticket }
	} catch {
		return undefined
	}
}

/** The codec revives whatever JSON it holds, so a tampered ticket decodes too: it must hold what a claim reads. */
const claimReadable = (t: ClaimTicket): boolean =>
	typeof t.messageHash === "string" &&
	typeof t.leafIndex === "bigint" &&
	typeof t.depositor === "string" &&
	t.draft?.secretOrSalt instanceof Fr &&
	t.draft.intent?.recipient instanceof AztecAddress &&
	typeof t.draft.intent.amount === "bigint"

/**
 * `p` as a claim, a reason it cannot claim yet, or nothing to try: an archived or final entry is never offered, and one
 * that no longer decodes is dropped.
 */
async function claimableEntry(ctx: LiveCtx, p: PendingDeposit): Promise<Claimable | undefined> {
	if (p.archived || p.final) return undefined
	const d = decodedDeposit(p)
	if (!d) {
		ctx.tickets.dropDeposit(p.id)
		return undefined
	}
	if (d.draft) return fromDraft(ctx, p, d.draft)
	if (!d.ticket) return undefined
	return p.claimed && (await stillClaimed(ctx, p, d.ticket)) ? undefined : { p, ticket: d.ticket }
}

/**
 * The oldest of `user`'s deposits that can claim now. One still confirming, or that cannot be read right now, never
 * holds up those after it: its reason shows only when none can claim.
 */
async function claimable(ctx: LiveCtx, user: User): Promise<Claimable> {
	let waiting: string | undefined
	let failure: unknown
	for (const p of ctx.tickets.deposits()) {
		if (p.user !== user) continue
		try {
			const found = await claimableEntry(ctx, p)
			if (typeof found === "string") waiting ??= found
			else if (found !== undefined) return found
		} catch (e) {
			failure ??= e
		}
	}
	if (waiting !== undefined) return waiting
	if (failure !== undefined) throw failure
	return NOTHING_TO_CLAIM
}

/** A deposit the L1 reader called never sent, kept for the visitor to check again. */
export interface ArchivedDeposit {
	id: string
	user: User
	amount: bigint | undefined
}

export function archivedDeposits(ctx: LiveCtx): ArchivedDeposit[] {
	return ctx.tickets
		.deposits()
		.filter((p) => p.archived)
		.map((p) => {
			const amount = decodedDeposit(p)?.draft?.intent?.amount
			return { id: p.id, user: p.user, amount: typeof amount === "bigint" ? amount : undefined }
		})
}

/**
 * Reads an archived deposit's fate again, one at a time with the page's runs: found, it can claim (its ticket carries
 * the same salt); possibly still landing, it waits with the others; neither, it stays archived. Says what it found.
 */
export function recheckDeposit(ctx: LiveCtx, id: string): Promise<string> {
	return ctx.demo.exclusive(async () => {
		const p = ctx.tickets.deposits().find((d) => d.id === id)
		const draft = p?.archived ? decodedDeposit(p)?.draft : undefined
		if (!p || !draft) return "There is nothing to check there any more."
		const found = await reconcileDeposit(draft, readerOf(ctx, p), ctx.m)
		if (found === "not-deposited") return "Still no sign of it on Ethereum. Its record stays here."
		if (found === "pending") {
			ctx.tickets.putDeposit({ ...p, archived: undefined })
			return "Ethereum may still take it: it is back with the deposits waiting to be claimed."
		}
		ctx.tickets.putDeposit({ ...p, archived: undefined, draft: undefined, claim: encodeTicket("claim", found) })
		return `Found it on Ethereum: ${HOLDER_NAME[p.user]} can claim it now.`
	})
}

/** Asks before a first private claim binds `user`'s account for good; undefined when the visitor declines. */
async function bindConsent(ctx: LiveCtx, user: User, t: ClaimTicket): Promise<ClaimConsent | undefined> {
	const { kind, recipient } = t.draft.intent
	if (kind !== "private" || (await claimBinding(ctx.demo.wallet, ctx.m, recipient, t.depositor)) !== "binds") return {}
	const question =
		`Claiming this deposit binds ${HOLDER_NAME[user]}'s account ${recipient}, for good, to ${t.depositor} (the address ` +
		"it came from). Later private deposits must come from there, and withdrawals go only there. Claim and bind?"
	return (ctx.confirm ?? ((q: string) => window.confirm(q)))(question) ? { allowBind: true } : undefined
}

async function claimDeposit(ctx: LiveCtx, d: ValidDraft, report: Report): Promise<Outcome> {
	const user = d.actor as User
	const found = await claimable(ctx, user)
	// The recording has alice's claim only; a deposit of this page's still on its way is waited for, never replayed over.
	if (found === NOTHING_TO_CLAIM && user === "alice") return replay(ctx, "claim", found)
	if (typeof found === "string") return { kind: "failed", detail: found }
	const consent = await bindConsent(ctx, user, found.ticket)
	if (!consent) return { kind: "failed", detail: "Nothing claimed: the binding was declined." }
	const since = ctx.demo.sent.length
	const result = await castClaim(
		session(ctx),
		found.ticket,
		() => report("simulate", "Waiting for the deposit's message to reach Aztec."),
		consent,
	)
	ctx.tickets.putDeposit({ ...found.p, claimed: true })
	if (result === "already") return { kind: "settled", detail: ALREADY_CONSUMED, rows: [] }
	const amount = usdc2(found.ticket.draft.intent.amount)
	return { kind: "settled", detail: `${HOLDER_NAME[user]} claimed ${amount} USDC.`, rows: await aztecRows(ctx, since, ["claim"]) }
}

async function request(ctx: LiveCtx, d: ValidDraft): Promise<Outcome> {
	const since = ctx.demo.sent.length
	const from = address(ctx, d.actor)
	const opened = await openRequest(
		ctx.demo.wallet,
		ctx.demo.node,
		token(ctx),
		{ from, to: from, completer: address(ctx, d.to) },
		await listOptions(ctx),
	)
	ctx.requests.set(`${d.actor}>${d.to}`, opened.commitment)
	const detail = `${HOLDER_NAME[d.actor]} opened a request only ${HOLDER_NAME[d.to]} can pay.`
	return { kind: "settled", detail, rows: await aztecRows(ctx, since, ["request"]) }
}

/**
 * The request a merchant `d.to` opens for the payer, as its server would, kept until paid. A user cannot open a stamped
 * request, so paying a user pays into one made without the merchant list, which the rules refuse.
 */
async function openFor(ctx: LiveCtx, d: ValidDraft, key: string, opts: ListOptions): Promise<Fr> {
	if (!isMerchant(d.to)) return Fr.random()
	const merchant = address(ctx, d.to)
	const intent = { from: merchant, to: merchant, completer: address(ctx, d.actor) }
	const { commitment } = await openRequest(ctx.demo.wallet, ctx.demo.node, token(ctx), intent, opts)
	ctx.requests.set(key, commitment)
	return commitment
}

/** Pays a merchant through a request it opened for the payer, reusing one already open unless it is too old. */
async function pay(ctx: LiveCtx, d: ValidDraft): Promise<Outcome> {
	const since = ctx.demo.sent.length
	const key = `${d.to}>${d.actor}`
	const amount = d.amount as bigint
	const payInto = async (commitment: Fr) => {
		const payment = { from: address(ctx, d.actor), commitment, amount, kind: "private" } as const
		try {
			await payRequest(ctx.demo.gate, ctx.demo.wallet, token(ctx), payment, await listOptions(ctx))
		} catch (e) {
			// Refused before any send: a request opened at a proposed block that a prune removed holds no stamp any more.
			if (message(e) === TOKEN_REFUSALS.payment) ctx.requests.delete(key)
			throw e
		}
	}
	const reopen = async () => openFor(ctx, d, key, await listOptions(ctx))
	const stored = ctx.requests.get(key)
	await (stored ? payReplacingStale(ctx.demo.gate, token(ctx), stored, payInto, reopen) : payInto(await reopen()))
	ctx.requests.delete(key)
	const kinds: TxKind[] = ctx.demo.sent.length - since > 1 ? ["request", "pay"] : ["pay"]
	const detail = `${HOLDER_NAME[d.actor]} paid ${usdc2(amount)} USDC into ${HOLDER_NAME[d.to]}'s request.`
	return { kind: "settled", detail, rows: await aztecRows(ctx, since, kinds) }
}

async function send(ctx: LiveCtx, d: ValidDraft): Promise<Outcome> {
	const since = ctx.demo.sent.length
	const amount = d.amount as bigint
	await sendPrivate(session(ctx), address(ctx, d.actor), address(ctx, d.to), amount)
	const detail = `${HOLDER_NAME[d.actor]} sent ${HOLDER_NAME[d.to]} ${usdc2(amount)} USDC.`
	return { kind: "settled", detail, rows: await aztecRows(ctx, since, ["transfer"]) }
}

/**
 * A merchant's exit may go anywhere, its merchant status proven at the anchor block; a user's goes only to its funding
 * address, which bridge-core checks before any witness or burn.
 */
async function withdraw(ctx: LiveCtx, d: ValidDraft, wallets: Record<"A_demo" | "B_demo", `0x${string}`>): Promise<Outcome> {
	const since = ctx.demo.sent.length
	const amount = d.amount as bigint
	const recipientL1 = wallets[d.to as "A_demo" | "B_demo"]
	const exit = { kind: "private", from: address(ctx, d.actor), recipientL1, amount, asMerchant: isMerchant(d.actor) } as const
	const entry: PendingExit = { id: crypto.randomUUID(), actor: d.actor, since: Date.now() }
	// The burn is stored as it leaves for the node: neither a lost response nor a reload can lose it.
	const journal = (tx: SentTx) => {
		entry.sent = { l2TxHash: tx.hash, recipient: recipientL1, amount: amount.toString(), expiresAt: tx.expiresAt.toString() }
		ctx.tickets.putExit(entry)
	}
	ctx.demo.onNextSend.fn = journal
	try {
		const ticket = await exitToL1(exit, ctx.demo.wallet, ctx.demo.sends, ctx.m, { wait: L2_PROPOSED })
		ctx.tickets.putExit({ ...entry, ticket: encodeTicket("exit", ticket) })
	} catch (e) {
		if (e instanceof ExitRevertedError && e.final) ctx.tickets.dropExit(entry.id)
		throw e
	} finally {
		if (ctx.demo.onNextSend.fn === journal) ctx.demo.onNextSend.fn = undefined
	}
	const detail = `Burned on Aztec. The ${usdc2(amount)} USDC pays out to ${HOLDER_NAME[d.to]} once Ethereum accepts this block's proof; this page sends it then.`
	return { kind: "settled", detail, rows: await aztecRows(ctx, since, ["exit"]) }
}

const MAY_STILL_LAND =
	"The network may still take the first try, so this page won't send it again. Check the balances in a few minutes, and try again if nothing moved."

/**
 * A sent tx's fate, waited for while the node holds it. A copy the node refused outright never entered its pool, and
 * its nullifier is already in the chain's state, which no pending copy gets past: gone. Any other drop proves nothing
 * (a lost response, another node behind the same URL), and a prune can undo a revert, so those wait for finality.
 */
async function fateOf(ctx: LiveCtx, tx: SentTx): Promise<"landed" | "gone" | "unsettled"> {
	const hash = TxHash.fromString(tx.hash)
	if ((await ctx.demo.node.getTxReceipt(hash)).status === TxStatus.DROPPED) {
		return tx.refused ? "gone" : finalFate(ctx.demo.node, tx.hash, tx.expiresAt)
	}
	const receipt = await waitForTx(ctx.demo.node, hash, { ...L2_PROPOSED, dontThrowOnRevert: true })
	return receipt.hasExecutionSucceeded() ? "landed" : finalFate(ctx.demo.node, tx.hash, tx.expiresAt)
}

/**
 * On a duplicate nullifier, a one-send action whose tx left for the node is decided by that tx's fate, and sent again
 * only once it provably cannot land. Anything else runs once more, after the wallet's sync: a conflict found before
 * anything was sent, or a payment, whose refused send may be the request it opened (the payment gate refuses paying a
 * request twice).
 */
export async function withConflictRetry(ctx: LiveCtx, attempt: () => Promise<Outcome>, kinds: readonly TxKind[]): Promise<Outcome> {
	const since = ctx.demo.sent.length
	try {
		return await attempt()
	} catch (e) {
		if (!DUPLICATE_NULLIFIER.test(message(e))) throw e
		const last = ctx.demo.sent.length > since ? ctx.demo.sent.at(-1) : undefined
		const fate = kinds.length === 1 && last ? await fateOf(ctx, last) : "gone"
		if (fate === "landed") {
			return { kind: "settled", detail: "It went through: the network had it already.", rows: await aztecRows(ctx, since, kinds) }
		}
		return fate === "unsettled" ? { kind: "failed", detail: MAY_STILL_LAND } : attempt()
	}
}

const KINDS: Record<LiveAction, readonly TxKind[]> = {
	deposit: [],
	claim: ["claim"],
	request: ["request"],
	pay: ["request", "pay"],
	send: ["transfer"],
	withdraw: ["exit"],
}

/**
 * Runs a draft live: refusals come back with the contract's rule text before anything is proven or sent; an Ethereum
 * step the demo wallet cannot afford, or a claim with nothing to claim, replays the recording and says so.
 */
/** One at a time through the page's wallet: a remount resets live mode's own guard, not the wallet's. */
export function runDraft(
	ctx: LiveCtx,
	d: ValidDraft,
	wallets: Record<"A_demo" | "B_demo", `0x${string}`>,
	report: Report,
): Promise<Outcome> {
	return ctx.demo.exclusive(() => runOne(ctx, d, wallets, report))
}

async function runOne(ctx: LiveCtx, d: ValidDraft, wallets: Record<"A_demo" | "B_demo", `0x${string}`>, report: Report): Promise<Outcome> {
	report("simulate")
	const run: Record<LiveAction, () => Promise<Outcome>> = {
		deposit: () => deposit(ctx, d, report),
		claim: () => claimDeposit(ctx, d, report),
		request: () => request(ctx, d),
		pay: () => pay(ctx, d),
		send: () => send(ctx, d),
		withdraw: () => withdraw(ctx, d, wallets),
	}
	try {
		return await withConflictRetry(ctx, run[d.action], KINDS[d.action])
	} catch (e) {
		return classify(e, d)
	}
}
