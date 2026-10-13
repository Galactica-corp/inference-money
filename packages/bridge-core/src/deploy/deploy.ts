import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { type Address, getAddress, type Hex } from "viem"
import { type BridgeManifest, PROTOCOL_VERSION, parseManifest } from "../manifest"
import { deployPortal, deployRouter, initializePortal } from "./deploy-l1"
import { deployBridgeL2, ensureAccount, type L2Fees } from "./deploy-l2"
import type { BridgeEvmArtifacts } from "./evm"
import type { L1Signer } from "./l1"
import { ensureStandardContracts } from "./standard"

export interface DeployContext {
	network: BridgeManifest["network"]
	l1: L1Signer
	evm: BridgeEvmArtifacts
	node: AztecNode
	nodeUrl: string
	wallet: EmbeddedWallet
	usdc: Address
	permit2: Address
	/**
	 * The network's pinned L1 registry; absent (local), the node's own answer. The portal derives its outbox from it once
	 * and for good, and the outbox alone approves withdrawals, so on a pinned network the node is never asked.
	 */
	registry?: Address
	/** The L2 owner of proxy and bridge. */
	deployerSecret: Fr
	fees: L2Fees
	sponsoredFpc: Hex | undefined
	/** The commit whose code this deploys (40 hex): its CLI can still finish the deployment's tickets later. */
	sourceCommit: string
	log: (m: string) => void
}

/**
 * The one deploy order both networks run: the deployer account and the standard contracts the bridge calls in public
 * (no-ops where present), then the portal and the router that names it, the three deployer-bound L2 instances and
 * their wiring, then `portal.initialize`, which needs the bridge address and checks the router's binding. Returns the
 * manifest, with no admin until the caller's handover is accepted; verifying it before it is written is the caller's step.
 */
export async function deployBridge(c: DeployContext): Promise<BridgeManifest> {
	const info = await c.node.getNodeInfo()
	const l1c = info.l1ContractAddresses
	const registry = getAddress(c.registry ?? l1c.registryAddress.toString())
	const deployer = await ensureAccount(c.wallet, c.deployerSecret, c.fees, c.log, "deployer")
	await ensureStandardContracts(c.wallet, c.node, { from: deployer, ...(c.fees.tx ? { fee: { paymentMethod: c.fees.tx } } : {}) }, c.log)
	const portal = await deployPortal(c.l1, c.evm)
	c.log(`portal ${portal.address}`)
	const router = await deployRouter(c.l1, c.evm, c.permit2, portal.address, c.usdc)
	c.log(`router ${router.address}`)
	const l2 = await deployBridgeL2(c.wallet, deployer, c.fees, portal.address, c.log)
	const binding = { registry, usdc: c.usdc, l2Bridge: l2.bridge.address, router: router.address }
	await initializePortal(c.l1, c.evm, portal.address, binding)
	c.log("portal initialized")
	return parseManifest({
		protocolVersion: PROTOCOL_VERSION,
		network: c.network,
		sourceCommit: c.sourceCommit,
		l1: {
			chainId: info.l1ChainId,
			usdc: c.usdc,
			permit2: c.permit2,
			portal: portal.address,
			router: router.address,
			registry,
			inbox: getAddress(l1c.inboxAddress.toString()),
			outbox: getAddress(l1c.outboxAddress.toString()),
			deployBlock: Number(router.block),
			deployer: c.l1.account.address,
		},
		l2: {
			nodeVersion: info.nodeVersion,
			rollupVersion: Number(info.rollupVersion),
			nodeUrl: c.nodeUrl,
			...(c.sponsoredFpc ? { sponsoredFpc: c.sponsoredFpc } : {}),
			...l2,
		},
	})
}
