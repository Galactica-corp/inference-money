import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { BatchCall, Contract, type ContractFunctionInteraction } from "@aztec-labs/aztec.js/contracts"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { tokenArtifact, tokenBridgeArtifact } from "../artifacts"
import { L2_DONE, sponsoredPayment } from "../claim"
import type { BridgeManifest } from "../manifest"
import { type MerchantNode, merchantStatus, syncMerchantList } from "../merchants"
import { ensureAccount } from "./deploy-l2"
import { entryDelay, readRoles } from "./token-reads"

/** What an admin call needs: a wallet holding the admin account, the deployment it acts on, and a node to read. */
export interface AdminSession {
	wallet: Wallet
	m: BridgeManifest
	node: MerchantNode
}

/** The account entrypoint takes five calls and the sponsor's payment is one of them. */
export const CALLS_PER_TX = 4

const at = (address: string) => AztecAddress.fromStringUnsafe(address)
export const bridgeOf = (wallet: Wallet, m: BridgeManifest) => Contract.at(at(m.l2.bridge.address), tokenBridgeArtifact, wallet)
export const tokenOf = (wallet: Wallet, m: BridgeManifest) => Contract.at(at(m.l2.token.address), tokenArtifact, wallet)
const sponsored = (m: BridgeManifest) => ({ paymentMethod: sponsoredPayment(m) })

/** Sends `calls` from `from` in as few txs as the entrypoint allows, in order; one tx's calls share its block. */
export async function sendChunked(
	wallet: Wallet,
	calls: ContractFunctionInteraction[],
	from: AztecAddress,
	fee: { paymentMethod: FeePaymentMethod } | undefined,
): Promise<number> {
	let txs = 0
	for (let i = 0; i < calls.length; i += CALLS_PER_TX) {
		await new BatchCall(wallet, calls.slice(i, i + CALLS_PER_TX)).send({ from, fee, wait: L2_DONE })
		txs++
	}
	return txs
}

/**
 * Proposes the bridge's ownership and the merchant admin role to `admin`, in one tx from their holder (the deploy
 * account, or an admin handing over). Neither moves until `admin` accepts both.
 */
export async function proposeAdmin(
	wallet: Wallet,
	m: BridgeManifest,
	from: AztecAddress,
	admin: AztecAddress,
	fee?: { paymentMethod: FeePaymentMethod },
): Promise<void> {
	const calls = [bridgeOf(wallet, m).methods.transfer_ownership!(admin), tokenOf(wallet, m).methods.propose_merchant_admin!(admin)]
	await new BatchCall(wallet, calls).send({ from, fee, wait: L2_DONE })
}

/**
 * Accepts both roles as the account `secret` rebuilds, deploying it through the sponsor first if needed, and returns
 * once both read back as its own at a checkpoint. A rerun after an accept that landed only reads them back, since a
 * second accept would revert.
 */
export async function acceptAdmin(
	wallet: EmbeddedWallet,
	node: Pick<AztecNode, "getPublicStorageAt">,
	m: BridgeManifest,
	secret: Fr,
	log: (m: string) => void,
): Promise<AztecAddress> {
	const fees = { accountDeploy: async () => sponsoredPayment(m), tx: sponsoredPayment(m) }
	const admin = await ensureAccount(wallet, secret, fees, log, "admin")
	const holdsBoth = async () => {
		const r = await readRoles(node, m)
		return r.owner.equals(admin.toField()) && r.admin.equals(admin.toField())
	}
	if (await holdsBoth()) {
		log(`admin ${admin}: already holds both roles`)
		return admin
	}
	const calls = [bridgeOf(wallet, m).methods.claim_ownership!(), tokenOf(wallet, m).methods.accept_merchant_admin!()]
	await new BatchCall(wallet, calls).send({ from: admin, fee: sponsored(m), wait: L2_DONE })
	if (!(await holdsBoth())) throw new Error(`The accept was checkpointed, but ${admin} does not hold both roles.`)
	return admin
}

export async function setPaused(s: AdminSession, admin: AztecAddress, paused: boolean): Promise<void> {
	await bridgeOf(s.wallet, s.m).methods.set_paused!(paused).send({ from: admin, fee: sponsored(s.m), wait: L2_DONE })
}

export async function addMerchants(s: AdminSession, admin: AztecAddress, accounts: AztecAddress[]): Promise<number> {
	const token = tokenOf(s.wallet, s.m)
	return sendChunked(
		s.wallet,
		accounts.map((a) => token.methods.add_merchant!(a)),
		admin,
		sponsored(s.m),
	)
}

/** Schedules a switch-off (`off`) or a switch back on, effective after the merchant's delay. */
export async function scheduleMerchant(s: AdminSession, admin: AztecAddress, account: AztecAddress, off: boolean): Promise<void> {
	await tokenOf(s.wallet, s.m).methods.schedule_merchant_off!(account, off).send({ from: admin, fee: sponsored(s.m), wait: L2_DONE })
}

/**
 * Sets the delay, then schedules it on every added merchant in the same txs, so up to {@link CALLS_PER_TX} entries share
 * one change time and the rest fall into a few cohorts, never one per merchant (each pending change marks its merchant's
 * txs). An increase applies at once; a decrease waits old − new. `synced` counts the merchants the node listed: one it
 * left out, by lag or otherwise, keeps its old delay until a rerun reaches it.
 */
export async function setMerchantDelay(s: AdminSession, admin: AztecAddress, delay: bigint): Promise<{ txs: number; synced: number }> {
	const token = tokenOf(s.wallet, s.m)
	const list = await syncMerchantList(s.node, at(s.m.l2.token.address))
	const syncs = [...list.entries.keys()].map((account) => token.methods.sync_merchant_delay!(at(account)))
	const txs = await sendChunked(s.wallet, [token.methods.set_merchant_delay!(delay), ...syncs], admin, sponsored(s.m))
	return { txs, synced: syncs.length }
}

/** Schedules the cancel-only guardian (zero removes it), effective after the guardian slot's delay. */
export async function scheduleGuardian(s: AdminSession, admin: AztecAddress, guardian: AztecAddress): Promise<void> {
	await tokenOf(s.wallet, s.m).methods.schedule_merchant_guardian!(guardian).send({ from: admin, fee: sponsored(s.m), wait: L2_DONE })
}

/** Cancels a merchant's pending change; the token refuses one with nothing pending. */
export async function cancelMerchantChange(s: AdminSession, admin: AztecAddress, account: AztecAddress): Promise<void> {
	await tokenOf(s.wallet, s.m).methods.cancel_merchant_change!(account).send({ from: admin, fee: sponsored(s.m), wait: L2_DONE })
}

/** One line per added merchant, from `MerchantAdded` events and each switch-off entry at the latest block. */
export async function describeMerchants(s: Pick<AdminSession, "node" | "m">): Promise<string[]> {
	const token = at(s.m.l2.token.address)
	const list = await syncMerchantList(s.node, token)
	return Promise.all(
		[...list.entries].map(async ([account, e]) => {
			const { merchant, pending } = merchantStatus(list, at(account))
			const delay = await entryDelay(s.node, token, at(account), list.block, list.at)
			const change = pending ? `; switches ${e.scheduledOff ? "off" : "on"} at ${e.changeAt}` : ""
			const delayChange = delay.changeAt > list.at ? `, ${delay.scheduled}s from ${delay.changeAt}` : ""
			return `${account} ${merchant ? "on" : "off"}${change}; delay ${delay.current}s${delayChange}`
		}),
	)
}
