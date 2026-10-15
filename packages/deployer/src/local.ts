import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type BridgeManifest, L2_DONE, sponsoredFpcArtifact, sponsorInstance } from "@galactica-net/inference-money-core"
import {
	acceptAdmin,
	deployBridge,
	deployMockUsdc,
	installCanonicalPermit2,
	l1Signer,
	proposeAdmin,
	tokenOf,
} from "@galactica-net/inference-money-core/deploy"
import { ANVIL_ACCOUNTS, L1_CHAIN_ID, resolveEndpoints } from "@galactica-net/inference-money-local-network"
import type { Hex } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { buildBridgeContracts } from "./evm"
import { localManifestPath, writeManifest } from "./manifest"
import { scrubbedEnv } from "./secrets"
import { accountFor, LOCAL_ADMIN_SECRET } from "./session"
import { sourceCommit } from "./source-commit"
import { assertAllPass, verifyDeployment } from "./verify"
import { withBridgeWallet } from "./wallet"

/** Anvil's public test mnemonic: the local network's own keys, not a credential. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"
/**
 * The local L1 deployer signs from anvil's last funded index: index 0 is the node's block publisher, and sharing it
 * would race every write on one nonce.
 */
export const localL1Account = () => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: ANVIL_ACCOUNTS - 1 })
/** A fixed local-only secret (like anvil's keys), so every process of a run can rebuild the deploy account. */
export const LOCAL_DEPLOYER_SECRET = new Fr(0x1a7e0de9107e5n)

export interface DeployOptions {
	/** Applied before the handover; the token starts at 86400 s. */
	merchantDelay?: bigint
	log: (m: string) => void
}

/**
 * Deploys the bridge onto this run's local network, hands both admin roles to the fixed local admin and accepts them in
 * the same run (so the handover path runs every time), verifies every read-back, and only then writes the manifest.
 */
export async function deployLocal(runId: string, opts: DeployOptions): Promise<{ manifest: BridgeManifest; path: string }> {
	const { log } = opts
	const net = resolveEndpoints(runId)
	const evm = buildBridgeContracts(runId, false, scrubbedEnv())
	const l1 = l1Signer(net.anvilUrl, L1_CHAIN_ID, localL1Account())
	const permit2 = await installCanonicalPermit2(l1)
	const usdc = (await deployMockUsdc(l1, evm)).address
	log(`L1 deployer ${l1.account.address}; Permit2 ${permit2}; MockUsdc ${usdc}`)
	const manifest = await withBridgeWallet(net.nodeUrl, { prove: false }, async (wallet, node) => {
		const sponsor = await sponsorInstance()
		await wallet.registerContract(sponsor, sponsoredFpcArtifact)
		const sponsored = new SponsoredFeePaymentMethod(sponsor.address)
		const fee = { paymentMethod: sponsored }
		const fees = { accountDeploy: async () => sponsored, tx: sponsored }
		const deployed = await deployBridge({
			network: "local",
			l1,
			evm,
			node,
			nodeUrl: net.nodeUrl,
			wallet,
			usdc,
			permit2,
			deployerSecret: LOCAL_DEPLOYER_SECRET,
			sourceCommit: sourceCommit(),
			fees,
			sponsoredFpc: sponsor.address.toString() as Hex,
			log,
		})
		const deployer = await accountFor(wallet, LOCAL_DEPLOYER_SECRET)
		if (opts.merchantDelay !== undefined) {
			await tokenOf(wallet, deployed).methods.set_merchant_delay!(opts.merchantDelay).send({ from: deployer, fee, wait: L2_DONE })
		}
		await proposeAdmin(wallet, deployed, deployer, await accountFor(wallet, LOCAL_ADMIN_SECRET), fee)
		const admin = await acceptAdmin(wallet, node, deployed, LOCAL_ADMIN_SECRET, log)
		const m: BridgeManifest = { ...deployed, l2: { ...deployed.l2, admin: admin.toString() as Hex } }
		assertAllPass(await verifyDeployment(m, evm, l1.publicClient, node), log)
		return m
	})
	const path = localManifestPath(runId)
	writeManifest(path, manifest)
	return { manifest, path }
}
