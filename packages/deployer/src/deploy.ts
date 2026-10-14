import { execFileSync } from "node:child_process"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { type BridgeManifest, L2_DONE, MERCHANT_MAX_DELAY, PROTOCOL_VERSION, parseManifest } from "@inference-money/bridge-core"
import { REPO_ROOT } from "@inference-money/local-network"
import { type Address, getAddress, type Hex } from "viem"
import { tokenOf } from "./admin"
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
	/** Set once after `initialize`, where it differs from the token's 86 400 s default; a second set would restart the guardian slot's decrease. */
	merchantDelay?: bigint
	sponsoredFpc: Hex | undefined
	log: (m: string) => void
}

/** The commit this checkout runs: a keyed run's is the pushed commit it was approved at. */
export const sourceCommit = (): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim()

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
	const fee = c.fees.tx ? { fee: { paymentMethod: c.fees.tx } } : {}
	await ensureStandardContracts(c.wallet, c.node, { from: deployer, ...fee }, c.log)
	const portal = await deployPortal(c.l1, c.evm)
	c.log(`portal ${portal.address}`)
	const router = await deployRouter(c.l1, c.evm, c.permit2, portal.address, c.usdc)
	c.log(`router ${router.address}`)
	const l2 = await deployBridgeL2(c.wallet, deployer, c.fees, portal.address, c.log)
	// The node's rollup is where the L2 side now lives; on testnet `probeNetwork` has already pinned it.
	const rollupVersion = BigInt(info.rollupVersion)
	const binding = { registry, usdc: c.usdc, l2Bridge: l2.bridge.address, router: router.address, rollupVersion }
	await initializePortal(c.l1, c.evm, portal.address, binding)
	c.log("portal initialized")
	const merchantDelay = c.merchantDelay ?? MERCHANT_MAX_DELAY
	const m = parseManifest({
		protocolVersion: PROTOCOL_VERSION,
		network: c.network,
		sourceCommit: sourceCommit(),
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
			portalTx: portal.tx,
			routerTx: router.tx,
		},
		l2: {
			nodeVersion: info.nodeVersion,
			rollupVersion: Number(info.rollupVersion),
			nodeUrl: c.nodeUrl,
			...(c.sponsoredFpc ? { sponsoredFpc: c.sponsoredFpc } : {}),
			merchantDelay: Number(merchantDelay),
			...l2,
		},
	})
	if (merchantDelay !== MERCHANT_MAX_DELAY) {
		await tokenOf(c.wallet, m).methods.set_merchant_delay!(merchantDelay).send({ from: deployer, ...fee, wait: L2_DONE })
		c.log(`merchant delay ${merchantDelay} s`)
	}
	return m
}
