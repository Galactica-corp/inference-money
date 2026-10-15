import { type BridgeManifest, parseManifest } from "@inference-money/bridge-core/manifest"
import { ethereumKey } from "@inference-money/demo/keys"
import { parseTour, type Tour } from "@inference-money/demo/tour"
import { type NetworkPins, TESTNET } from "@inference-money/deployer/networks"
import { type Address, type Chain, defineChain } from "viem"
import { privateKeyToAddress } from "viem/accounts"

/** Re-validated at startup: a bundle whose embedded manifest does not parse must not render a bridge. */
export const MANIFEST: BridgeManifest = parseManifest(__BRIDGE_MANIFEST__)

/** The recorded acceptance run the page replays at `#recorded`; the build checked it against the manifest on testnet. */
export const TOUR: Tour = parseTour(__SHOWCASE_TOUR__)

/** Public explorers exist for testnet only; a local network's txs link nowhere. */
export const EXPLORER: NetworkPins["explorer"] | undefined = MANIFEST.network === "testnet" ? TESTNET.explorer : undefined

/** The users' Ethereum wallets: A_demo funds alice's account, B_demo bob's. Their keys are public, like every demo key. */
export const WALLETS: Record<"A_demo" | "B_demo", Address> = {
	A_demo: privateKeyToAddress(ethereumKey(MANIFEST.l2.bridge.address, "alice")),
	B_demo: privateKeyToAddress(ethereumKey(MANIFEST.l2.bridge.address, "bob")),
}

export const USERS_TAG: string = __SHOWCASE_USERS_TAG__
export const MERCHANTS_SALT: string = __SHOWCASE_MERCHANTS_SALT__
export const L1_RPC_URL: string = __SHOWCASE_L1_RPC__
/** Whether the embedded wallet proves for real: always on testnet, on local only in the proving harness. */
export const PROVES: boolean = __SHOWCASE_PROOFS__ === "real"

export const L1_CHAIN: Chain = defineChain({
	id: MANIFEST.l1.chainId,
	name: MANIFEST.l1.chainId === 11155111 ? "Sepolia" : `Chain ${MANIFEST.l1.chainId}`,
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: [L1_RPC_URL] } },
})
