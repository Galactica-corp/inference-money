import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { assertNetworkIdentity } from "@inference-money/bridge-core"
import { createPublicClient, http } from "viem"
import { L1_CHAIN, L1_RPC_URL, MANIFEST, PROVES, USERS_TAG } from "@/config/network"
import { browserPaymentStore, localKeyValue } from "./store"
import { type DemoWallet, openDemoWallet } from "./wallet"

/** This deployment's corner of `localStorage`: a redeploy starts with no records of the last one. */
export const deploymentStore = () => localKeyValue(`inference-money/${MANIFEST.l2.bridge.address}/`)

/**
 * Checks both chains against the embedded manifest, then opens the page's wallet. A real-proof page proves through
 * Presto's prover on every route, kept in the page until "Try it yourself" asks the visitor.
 */
export async function startDemo(): Promise<DemoWallet> {
	const node = createAztecNodeClient(MANIFEST.l2.nodeUrl)
	const l1 = createPublicClient({ chain: L1_CHAIN, transport: http(L1_RPC_URL) })
	const { depositsOpen } = await assertNetworkIdentity(node, l1, MANIFEST)
	const presto = PROVES ? (await import("@/presto")).pagePresto(__SHOWCASE_PRESTO__) : undefined
	return openDemoWallet(node, MANIFEST, {
		usersTag: USERS_TAG,
		proves: PROVES,
		payments: browserPaymentStore(deploymentStore()),
		presto,
		depositsOpen,
	})
}
