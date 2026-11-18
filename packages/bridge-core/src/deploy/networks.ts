import type { Address } from "viem"

/** Everything a live network must match before anything is spent on it. */
export interface NetworkPins {
	name: "testnet" | "mainnet"
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
	/** The fee asset's L1 faucet; testnet only. */
	feeAssetHandler?: Address
	/** The canonical SponsoredFPC; testnet only. */
	sponsoredFpc?: `0x${string}`
	/** Where a tx hash is looked up, by appending it. */
	explorer: { l1Tx: string; l2Tx: string }
}

export const TESTNET = {
	name: "testnet",
	nodeUrl: "https://aztec-testnet.drpc.org",
	defaultL1RpcUrl: "https://lb.drpc.live/sepolia/Ak0qdxVWbkqUmLb-dN5IplyTiGDyyJwR8Yfybj3Fs6u0",
	nodeVersion: "6.0.0",
	l1ChainId: 11155111,
	rollupVersion: 679261766,
	registry: "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba",
	inbox: "0x7cdc32dd7d008870a95f1837ffd7229ef676ef8a",
	outbox: "0xa5a0f7a7bdaf280964a1922a68c83462e5f6e15b",
	usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
	usdcDecimals: 6,
	usdcEip712Version: "2",
	permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
	feeJuicePortal: "0xe59acba462a0324b1d619a7a1b219419f156f505",
	// Permissionless testnet faucet for the fee asset: the self-funded fee path mints here, then bridges.
	feeAssetHandler: "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9",
	// Canonical SponsoredFPC (salt 0); its address commits to the contract class.
	sponsoredFpc: "0x2d8fff82a3b0c15d0a89169e7d8d043e079ab94d52031f1de1e4972ebad169d3",
	// Aztecscan is the explorer Aztec's testnet guide names; its tx page is /tx-effects/<hash>.
	explorer: { l1Tx: "https://sepolia.etherscan.io/tx/", l2Tx: "https://testnet.aztecscan.xyz/tx-effects/" },
} satisfies NetworkPins

/** Pinned for the probe only: mainnet has neither a SponsoredFPC nor a fee faucet, so nothing deploys here yet. */
export const MAINNET = {
	name: "mainnet",
	nodeUrl: "https://aztec-mainnet.drpc.org",
	defaultL1RpcUrl: "https://eth.drpc.org",
	nodeVersion: "6.0.0",
	l1ChainId: 1,
	rollupVersion: 2070860440,
	registry: "0x35b22e09ee0390539439e24f06da43d83f90e298",
	inbox: "0x603b06cecc1d537aad83f1d46651e32014c5b6ad",
	outbox: "0xfd2a12658a82d7156da56c7a8d49a69fc966c8d1",
	usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	usdcDecimals: 6,
	usdcEip712Version: "2",
	permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
	feeJuicePortal: "0x534361be805ca30bdb6404ec5e6cdaffb3e9f3b3",
	explorer: { l1Tx: "https://etherscan.io/tx/", l2Tx: "https://aztecscan.xyz/tx-effects/" },
} satisfies NetworkPins

export function networkByName(name: string): NetworkPins {
	if (name === "testnet") return TESTNET
	if (name === "mainnet") return MAINNET
	throw new Error(`unknown network "${name}" (expected: testnet or mainnet)`)
}
