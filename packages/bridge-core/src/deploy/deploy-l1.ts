import type { Address, Hex } from "viem"
import type { BridgeEvmArtifacts } from "./evm"
import { deployEvm, type L1Signer, writeEvm } from "./l1"

/** The portal's constructor records the deployer as its only initializer; `initializePortal` must come from the same account. */
export const deployPortal = (l1: L1Signer, evm: BridgeEvmArtifacts) => deployEvm(l1, "TokenPortal", evm.portal)

/**
 * Reverts unless the router names this portal and `binding.usdc` (the portal checks the router it is handed), and
 * unless the registry's canonical rollup has `binding.rollupVersion`, the one the L2 side was deployed on.
 */
export async function initializePortal(
	l1: L1Signer,
	evm: BridgeEvmArtifacts,
	portal: Address,
	binding: { registry: Address; usdc: Address; l2Bridge: Hex; router: Address; rollupVersion: bigint },
): Promise<void> {
	const { registry, usdc, l2Bridge, router, rollupVersion } = binding
	const args = [registry, usdc, l2Bridge, router, rollupVersion]
	await writeEvm(l1, "portal.initialize", portal, evm.portal.abi, "initialize", args)
}

/** Deployed before the portal is initialized; `initializePortal` then binds the portal to it. */
export const deployRouter = (l1: L1Signer, evm: BridgeEvmArtifacts, permit2: Address, portal: Address, usdc: Address) =>
	deployEvm(l1, "Permit2DepositRouter", evm.router, [permit2, portal, usdc])

/** Local only: a 6-decimal, freely mintable stand-in for Circle's USDC. */
export const deployMockUsdc = (l1: L1Signer, evm: BridgeEvmArtifacts) => deployEvm(l1, "MockUsdc", evm.mockUsdc)
