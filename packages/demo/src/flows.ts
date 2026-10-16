import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type AztecNode, waitForTx } from "@aztec-labs/aztec.js/node"
import type { TxHash } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import {
	assertPublicRecipient,
	type BridgeManifest,
	type ClaimConsent,
	type ClaimTicket,
	type ClaimWait,
	claim,
	claimBinding,
	confirmDeposit,
	type DepositDraft,
	type DepositKind,
	type DepositStage,
	ensurePermit2Allowance,
	isClaimConsumed,
	type L1Ctx,
	L2_DONE,
	type L2Wait,
	prepareDeposit,
	reconcileDeposit,
	sponsoredPayment,
	submitDeposit,
	syncMerchantList,
	tipOf,
	transferPrivate,
	waitClaimable,
	withRebuiltTicket,
} from "@galactica-net/inference-money-core"
import {
	type Account,
	type Address,
	type Chain,
	createPublicClient,
	createWalletClient,
	defineChain,
	erc20Abi,
	http,
	maxUint256,
	type PublicClient,
	type WalletClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Actor } from "./actors"
import { DEMO_SEED } from "./amounts"
import { ethereumKey } from "./keys"

/** What a demo flow needs of a session: a wallet holding the cast's accounts, its node, and the deployment. */
export interface DemoSession {
	wallet: Wallet
	node: AztecNode
	m: BridgeManifest
	/** How far each L2 send waits before its flow returns; {@link L2_DONE} unless set. */
	wait?: L2Wait
}

/** One signing Ethereum account: each send awaits its receipt before the next. */
export interface DemoL1 {
	publicClient: PublicClient
	walletClient: WalletClient
	account: Account
	chain: Chain
}

/** A cast member's Ethereum account: A_demo (alice's), B_demo (bob's) or a merchant's treasury. Its key is public. */
export function demoL1(rpcUrl: string, m: BridgeManifest, actor: Actor): DemoL1 {
	const chain = defineChain({
		id: m.l1.chainId,
		name: `chain-${m.l1.chainId}`,
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: { default: { http: [rpcUrl] } },
	})
	const account = privateKeyToAccount(ethereumKey(m.l2.bridge.address, actor))
	const transport = http(rpcUrl)
	return {
		publicClient: createPublicClient({ chain, transport }) as PublicClient,
		walletClient: createWalletClient({ chain, transport, account }),
		account,
		chain,
	}
}

export const l1CtxOf = (s: DemoL1): L1Ctx => ({ publicClient: s.publicClient, walletClient: s.walletClient, account: s.account.address })

export const usdcOf = (l1: Pick<DemoL1, "publicClient">, m: BridgeManifest, who: Address): Promise<bigint> =>
	l1.publicClient.readContract({ address: m.l1.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] })

/** Lets Permit2 pull `signer`'s USDC: one unlimited approval, sent only while the allowance is below `needed`. */
export async function approvePermit2(signer: DemoL1, m: BridgeManifest, needed: bigint): Promise<void> {
	const owner = signer.account.address
	await ensurePermit2Allowance({
		allowance: () =>
			signer.publicClient.readContract({ address: m.l1.usdc, abi: erc20Abi, functionName: "allowance", args: [owner, m.l1.permit2] }),
		approveMax: () =>
			signer.walletClient.writeContract({
				address: m.l1.usdc,
				abi: erc20Abi,
				functionName: "approve",
				args: [m.l1.permit2, maxUint256],
				account: signer.account,
				chain: signer.chain,
			}),
		waitReceipt: (hash) => signer.publicClient.waitForTransactionReceipt({ hash }),
		needed,
	})
}

const tokenOf = (m: BridgeManifest): AztecAddress => AztecAddress.fromStringUnsafe(m.l2.token.address)

/** The sponsor pays every demo tx: the demo accounts hold no fee juice. */
export const sponsoredFee = (m: BridgeManifest) => ({ paymentMethod: sponsoredPayment(m) })

export interface DepositPlan {
	/** Whose Ethereum account pays ({@link demoL1}). */
	from: Actor
	to: AztecAddress
	kind: DepositKind
	amount: bigint
}

/** A stored draft from an earlier attempt, and how its owner keeps it once the L1 reader calls it never sent. */
export interface PriorDraft {
	draft: DepositDraft
	/** Stores the whole draft somewhere the next `persist` cannot overwrite, synchronously; throws if it cannot. */
	abandon(): void
}

/**
 * Deposits from a demo Ethereum account, handing the draft to `persist` once it may be broadcast and again once its tx
 * hash is known, so a crash after that point recovers it (`prior`) instead of depositing twice. A prior the L1 reader
 * calls never sent is abandoned, never overwritten (the reader may lie, and only its salt claims it), then deposited
 * anew. Refused before any approval, since either could only be returned: a public deposit to anyone but a switched-on
 * merchant, and a private one to an account bound to another funding address (the session's wallet holds the cast).
 */
export async function castDeposit(
	s: DemoSession,
	signer: DemoL1,
	p: DepositPlan,
	prior: PriorDraft | undefined,
	persist: (d: DepositDraft) => void,
	on?: (stage: DepositStage) => void,
): Promise<ClaimTicket> {
	const l1 = l1CtxOf(signer)
	if (prior) {
		const found = await reconcileDeposit(prior.draft, l1, s.m)
		if (found === "pending") throw new Error("A stored deposit is not readable on Ethereum yet; try again in a few minutes.")
		if (found !== "not-deposited") return found
		prior.abandon()
	}
	if (p.kind === "public") assertPublicRecipient(await syncMerchantList(s.node, tokenOf(s.m)), p.to)
	else await claimBinding(s.wallet, s.m, p.to, signer.account.address)
	await approvePermit2(signer, s.m, p.amount)
	const tip = (await l1.publicClient.getBlock()).timestamp
	const d = await prepareDeposit({ amount: p.amount, recipient: p.to, kind: p.kind }, s.m, () => tip)
	await submitDeposit(d, l1, s.m, s.node, (stage) => {
		if (stage === "depositing") persist(d)
		on?.(stage)
	})
	persist(d)
	return confirmDeposit(d, l1, s.m, on)
}

const CLAIMABLE = { pollMs: 5_000, attempts: 720 }

/** How a claim rebuilds its ticket when a reorg moved the deposit's Inbox message: an L1 reader, and where it stores. */
export interface TicketRebuild {
	l1: L1Ctx
	/** Stores the rebuilt ticket in place of the old one; throws if it cannot, and then nothing is claimed with it. */
	keep(t: ClaimTicket): void
}

/**
 * Claims `t` once its message is consumable, as its recipient (a private claim must be; a public one goes through the
 * sponsor). "already" when its message was consumed before, by this claim or anyone's. A first private claim binds its
 * recipient only with `consent.allowBind`. With `rebuild`, a message that never arrives is looked for again on L1
 * ({@link withRebuiltTicket}).
 */
export async function castClaim(
	s: DemoSession,
	t: ClaimTicket,
	onWait?: (w: ClaimWait) => void,
	consent: ClaimConsent = {},
	rebuild?: TicketRebuild,
): Promise<"claimed" | "already"> {
	const wait = s.wait ?? L2_DONE
	const once = async (t: ClaimTicket): Promise<"claimed" | "already"> => {
		if (await isClaimConsumed(t, s.node, s.m, tipOf(wait))) return "already"
		const from = t.draft.intent.recipient
		await waitClaimable(t, s.node, s.wallet, s.m, from, onWait, { ...CLAIMABLE, ...consent })
		const result = await claim(t, s.node, s.wallet, s.m, { from, fee: "sponsored", wait, ...consent })
		return result === "claimed" ? "claimed" : "already"
	}
	return rebuild ? withRebuiltTicket(t, rebuild.l1, s.m, rebuild.keep, once) : once(t)
}

/**
 * A private transfer with the side capsule the merchant list implies. User to user is refused before anything is
 * proven, with the token's own refusal text.
 */
export async function sendPrivate(s: DemoSession, from: AztecAddress, to: AztecAddress, amount: bigint): Promise<TxHash> {
	const token = tokenOf(s.m)
	const list = await syncMerchantList(s.node, token)
	const txHash = await transferPrivate(s.wallet, token, { from, to, amount }, { list, fee: sponsoredFee(s.m) })
	await waitForTx(s.node, txHash, s.wait ?? L2_DONE)
	return txHash
}

/** What `demo reset` refunds alice: back up to her seed, as far as galactica's private balance goes; 0 when nothing. */
export function resetAmount(alice: bigint, galactica: bigint): bigint {
	const short = DEMO_SEED.alice - alice
	if (short <= 0n) return 0n
	return short < galactica ? short : galactica
}
