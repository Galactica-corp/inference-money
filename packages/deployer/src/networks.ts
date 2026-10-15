import type { Address } from "viem"

/** Everything a live network must match before anything is spent on it. */
export interface NetworkPins {
	name: "testnet"
	nodeUrl: string
	defaultL1RpcUrl: string
	nodeVersion: string
	l1ChainId: number
	rollupVersion: number
	registry: Address
	inbox: Address
	outbox: Address
	usdc: Address
	usdcDecimals: number
	usdcEip712Version: string
	permit2: Address
	feeJuicePortal: Address
	feeAssetHandler: Address
	sponsoredFpc: `0x${string}`
	/** Where a tx hash is looked up, by appending it. */
	explorer: { l1Tx: string; l2Tx: string }
}

export const TESTNET: NetworkPins = {
	name: "testnet",
	nodeUrl: "https://lb.drpc.live/aztec-testnet/Ak0qdxVWbkqUmLb-dN5IplyTiGDyyJwR8Yfybj3Fs6u0",
	defaultL1RpcUrl: "https://lb.drpc.live/sepolia/Ak0qdxVWbkqUmLb-dN5IplyTiGDyyJwR8Yfybj3Fs6u0",
	nodeVersion: "6.0.0-rc.3",
	l1ChainId: 11155111,
	rollupVersion: 3409706519,
	registry: "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba",
	inbox: "0xb3b95295823ad313edc9e498eff7b672b3c6b209",
	outbox: "0x25519d3c79e39143accf358ba07d200b534fa400",
	usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
	usdcDecimals: 6,
	usdcEip712Version: "2",
	permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
	feeJuicePortal: "0x6974bde62c47a0041f5b4a2e61c5506c2b59ce59",
	// Permissionless testnet faucet for the fee asset: the self-funded fee path mints here, then bridges.
	feeAssetHandler: "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9",
	// Canonical SponsoredFPC (salt 0); its address commits to the contract class.
	sponsoredFpc: "0x2adfb70e860909f0db8268b3fec80bce52a94559963444f5c0341816b8412130",
	// Aztecscan is the explorer Aztec's testnet guide names; its tx page is /tx-effects/<hash>.
	explorer: { l1Tx: "https://sepolia.etherscan.io/tx/", l2Tx: "https://testnet.aztecscan.xyz/tx-effects/" },
}

export function networkByName(name: string): NetworkPins {
	if (name === "testnet") return TESTNET
	throw new Error(`unknown network "${name}" (expected: testnet)`)
}
