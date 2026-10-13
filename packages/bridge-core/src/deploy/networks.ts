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
	nodeUrl: "https://lb.drpc.live/aztec-testnet/Ak_eT5HA2kbyqamqGTF702daoH37vEsR8YYxjmVXwXgc",
	defaultL1RpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
	nodeVersion: "6.0.0-rc.1",
	l1ChainId: 11155111,
	rollupVersion: 2914217885,
	registry: "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba",
	inbox: "0x816ce1861ec258f99279e75a3ee6b5dfc9571e30",
	outbox: "0xb9dae0f8c5dd6524c1015ffe6494d9fd0623df0d",
	usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
	usdcDecimals: 6,
	usdcEip712Version: "2",
	permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
	feeJuicePortal: "0x5bb7523a95c1fdf1d2a3dd9fb7d497e7f5142d7f",
	// Permissionless testnet faucet for the fee asset: the self-funded fee path mints here, then bridges.
	feeAssetHandler: "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9",
	// Canonical SponsoredFPC (salt 0); its address commits to the contract class.
	sponsoredFpc: "0x06a9fa0208c78509921b0487a6b5cd5c2e93baf17de1a18d310f65a3cc1d924b",
	// Aztecscan is the explorer Aztec's testnet guide names; its tx page is /tx-effects/<hash>.
	explorer: { l1Tx: "https://sepolia.etherscan.io/tx/", l2Tx: "https://testnet.aztecscan.xyz/tx-effects/" },
}

export function networkByName(name: string): NetworkPins {
	if (name === "testnet") return TESTNET
	throw new Error(`unknown network "${name}" (expected: testnet)`)
}
