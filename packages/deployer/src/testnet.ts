import { rmSync } from "node:fs"
import { join } from "node:path"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { FeeJuicePaymentMethodWithClaim } from "@aztec-labs/aztec.js/fee"
import type { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { type BridgeManifest, readBack, sponsoredFpcArtifact, sponsorInstance } from "@inference-money/bridge-core"
import { REPO_ROOT } from "@inference-money/local-network"
import type { Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { proposeAdmin } from "./admin"
import { deployBridge } from "./deploy"
import type { L2Fees } from "./deploy-l2"
import { type BridgeEvmArtifacts, buildBridgeContracts, forgeRunDir } from "./evm"
import { bridgeFeeJuice } from "./fee-juice"
import { type L1Signer, l1Signer } from "./l1"
import type { DeployOptions } from "./local"
import { writeManifest } from "./manifest"
import { TESTNET } from "./networks"
import { probeNetwork } from "./preflight"
import { aztecSecretFrom, KEYED, keyedEnv, l1PrivateKeyFrom, scrubbedEnv } from "./secrets"
import { accountFor } from "./session"
import { assertAllPass, verifyDeployment } from "./verify"
import { withBridgeWallet } from "./wallet"

export const TESTNET_MANIFEST = join(REPO_ROOT, "deployments", "testnet.json")

/**
 * Always `--force` into a forge dir of this invocation's own, removed once the artifacts are in memory: no stale cache
 * or concurrent command can reach a live deploy.
 */
export function buildFresh(): BridgeEvmArtifacts {
	const run = `fresh-${process.pid}`
	try {
		return buildBridgeContracts(run, true, scrubbedEnv())
	} finally {
		rmSync(forgeRunDir(run), { recursive: true, force: true })
	}
}

/** The L1 side of a keyed testnet run: its key and RPC, from the run's environment alone. */
export function testnetL1(env: NodeJS.ProcessEnv = keyedEnv()): { l1: L1Signer; l1RpcUrl: string; l1PrivateKey: Hex } {
	const l1PrivateKey = l1PrivateKeyFrom(env)
	const l1RpcUrl = env[KEYED.rpcUrl] || TESTNET.defaultL1RpcUrl
	return { l1: l1Signer(l1RpcUrl, TESTNET.l1ChainId, privateKeyToAccount(l1PrivateKey)), l1RpcUrl, l1PrivateKey }
}

/** The plain admin address the deploy template carries once the `admin address` run has printed it. */
export function adminAddressFrom(env: NodeJS.ProcessEnv = process.env): AztecAddress {
	const value = env.TESTNET_ADMIN_ADDRESS ?? ""
	if (!/^0x[0-9a-f]{64}$/.test(value)) {
		throw new Error("TESTNET_ADMIN_ADDRESS is not an Aztec address: commit the `bridge admin address` run's output first")
	}
	return AztecAddress.fromStringUnsafe(value)
}

/**
 * The deployer account's first tx claims Fee Juice minted from the testnet faucet and bridged to it; every later tx
 * pays from that balance.
 */
function selfFundedFees(
	l1: ReturnType<typeof testnetL1>,
	node: ReturnType<typeof createAztecNodeClient>,
	log: (m: string) => void,
): L2Fees {
	return {
		accountDeploy: async (account: AztecAddress) => {
			const claim = await bridgeFeeJuice({
				node,
				pins: TESTNET,
				l1RpcUrl: l1.l1RpcUrl,
				l1PrivateKey: l1.l1PrivateKey,
				to: account,
				log,
			})
			return new FeeJuicePaymentMethodWithClaim(account, claim)
		},
		tx: undefined,
	}
}

/**
 * Probes the pins (nothing is spent unless every one holds), deploys with real client proofs, proposes both admin roles
 * to TESTNET_ADMIN_ADDRESS, verifies every read-back with that handover pending, and only then writes
 * `deployments/testnet.json`. The deploy keys hold no role once the admin accepts (`bridge admin accept`).
 */
export async function deployTestnet(opts: DeployOptions): Promise<BridgeManifest> {
	const { log } = opts
	const keys = testnetL1()
	const deployerSecret = aztecSecretFrom(KEYED.deployerSecret)
	const admin = adminAddressFrom()
	assertAllPass(await probeNetwork(TESTNET, keys.l1RpcUrl), log)
	const evm = buildFresh()
	const manifest = await withBridgeWallet(TESTNET.nodeUrl, { prove: true }, async (wallet, node) => {
		const sponsor = await sponsorInstance()
		if (sponsor.address.toString() !== TESTNET.sponsoredFpc) throw new Error(`the pinned sponsor derives to ${sponsor.address}`)
		await wallet.registerContract(sponsor, sponsoredFpcArtifact)
		const m = await deployBridge({
			network: "testnet",
			l1: keys.l1,
			evm,
			node,
			nodeUrl: TESTNET.nodeUrl,
			wallet,
			usdc: TESTNET.usdc,
			permit2: TESTNET.permit2,
			registry: TESTNET.registry,
			deployerSecret,
			fees: selfFundedFees(keys, node, log),
			merchantDelay: opts.merchantDelay,
			sponsoredFpc: TESTNET.sponsoredFpc,
			log,
		})
		const deployer = await accountFor(wallet, deployerSecret)
		await proposeAdmin(wallet, m, deployer, admin)
		log(`handover proposed to ${admin}: accept it with \`bridge admin accept\``)
		const verify = () => verifyDeployment(m, evm, keys.l1.publicClient, node, { pendingTo: admin.toString() })
		assertAllPass(await readBack(verify, (checks) => checks.every((c) => c.ok)), log)
		return m
	})
	writeManifest(TESTNET_MANIFEST, manifest)
	return manifest
}
