import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import type { Address, Hex } from "viem"
import { sponsoredFpcArtifact } from "../artifacts"
import { L2_DONE, sponsorInstance } from "../claim"
import { TESTNET_MANIFEST } from "../deployments"
import type { BridgeManifest } from "../manifest"
import { tokenOf } from "./admin"
import { deployBridge } from "./deploy"
import { deployMockUsdc } from "./deploy-l1"
import type { BridgeEvmArtifacts } from "./evm"
import { BRIDGE_EVM_ARTIFACTS } from "./evm-artifacts"
import type { L1Signer } from "./l1"

export interface TestBridgeOptions {
	network: BridgeManifest["network"]
	node: AztecNode
	nodeUrl: string
	/** Proves for real on testnet. Its key stores are files: open it in a directory of your own. */
	wallet: EmbeddedWallet
	/** Pays the L1 deploys; on Sepolia it needs ETH only when `usdc` is `"mock"`. */
	l1: L1Signer
	/** Rebuilds the Aztec account that deploys, and that stays bridge owner and merchant admin. */
	deployerSecret: Fr
	/** `"mock"` deploys a freely mintable 6-decimal stand-in; an address binds the bridge to that token. */
	usdc: Address | "mock"
	permit2: Address
	/** The network's L1 registry; absent, the node's own answer (trust the node only on a local network). */
	registry?: Address
	/** Seconds a merchant switch-off waits (3600–86400); the token starts at 86400. */
	merchantDelay?: bigint
	/** The compiled L1 contracts (default: the ones this package ships). */
	evm?: BridgeEvmArtifacts
	log?: (m: string) => void
}

export interface TestBridge {
	manifest: BridgeManifest
	/** The deployer account: bridge owner and merchant admin, so `addMerchants` and `setPaused` take it as `admin`. */
	admin: AztecAddress
}

/**
 * A bridge of your own for tests, paid through the canonical sponsor: the account `deployerSecret` rebuilds deploys
 * every contract and keeps both admin roles (no handover), so it lists merchants itself. The manifest names the code
 * of the shipped testnet deployment as its source, whose artifacts these are. Never for funds that matter: nothing
 * here is verified against a fresh build, and one key holds every role.
 */
export async function deployTestBridge(o: TestBridgeOptions): Promise<TestBridge> {
	const log = o.log ?? (() => {})
	const evm = o.evm ?? BRIDGE_EVM_ARTIFACTS
	const sponsor = await sponsorInstance()
	await o.wallet.registerContract(sponsor, sponsoredFpcArtifact)
	const sponsored = new SponsoredFeePaymentMethod(sponsor.address)
	const usdc = o.usdc === "mock" ? (await deployMockUsdc(o.l1, evm)).address : o.usdc
	if (o.usdc === "mock") log(`MockUsdc ${usdc}`)
	const deployed = await deployBridge({
		network: o.network,
		l1: o.l1,
		evm,
		node: o.node,
		nodeUrl: o.nodeUrl,
		wallet: o.wallet,
		usdc,
		permit2: o.permit2,
		...(o.registry ? { registry: o.registry } : {}),
		deployerSecret: o.deployerSecret,
		fees: { accountDeploy: async () => sponsored, tx: sponsored },
		sponsoredFpc: sponsor.address.toString() as Hex,
		sourceCommit: TESTNET_MANIFEST.sourceCommit,
		log,
	})
	const manifest: BridgeManifest = { ...deployed, l2: { ...deployed.l2, admin: deployed.l2.bridge.deployer } }
	const admin = AztecAddress.fromStringUnsafe(deployed.l2.bridge.deployer)
	if (o.merchantDelay !== undefined) {
		const fee = { paymentMethod: sponsored }
		await tokenOf(o.wallet, manifest).methods.set_merchant_delay!(o.merchantDelay).send({ from: admin, fee, wait: L2_DONE })
	}
	return { manifest, admin }
}
