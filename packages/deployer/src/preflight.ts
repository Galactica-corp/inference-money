import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import { ManaUsageEstimate } from "@aztec-labs/stdlib/gas"
import { type Address, createPublicClient, getAddress, http, isAddressEqual, type PublicClient, parseAbi } from "viem"
import { ESTIMATED_GAS_PER_TX, feeBudget, TESTNET_DEPLOY_TXS, TESTNET_SPONSORED_TXS } from "./budget"
import type { NetworkPins } from "./networks"

export interface Check {
	name: string
	ok: boolean
	/** Passes, but an operator should act on it. */
	warn?: boolean
	detail: string
}

/** The node-info subset a network's identity is pinned by. */
export interface NodeIdentity {
	nodeVersion: string
	l1ChainId: number
	rollupVersion: number
	l1ContractAddresses: {
		registryAddress: { toString(): string }
		inboxAddress: { toString(): string }
		outboxAddress: { toString(): string }
		feeJuicePortalAddress: { toString(): string }
		feeAssetHandlerAddress?: { toString(): string }
	}
}

const eq = (a: string, b: string) => isAddressEqual(getAddress(a), getAddress(b))
const check = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail })

export function checkNodeIdentity(info: NodeIdentity, pins: NetworkPins): Check[] {
	const l1 = info.l1ContractAddresses
	return [
		check("node version", info.nodeVersion === pins.nodeVersion, `${info.nodeVersion} (want ${pins.nodeVersion})`),
		check("L1 chain id", info.l1ChainId === pins.l1ChainId, `${info.l1ChainId} (want ${pins.l1ChainId})`),
		check("rollup version", info.rollupVersion === pins.rollupVersion, `${info.rollupVersion} (want ${pins.rollupVersion})`),
		check("registry", eq(l1.registryAddress.toString(), pins.registry), l1.registryAddress.toString()),
		check("inbox", eq(l1.inboxAddress.toString(), pins.inbox), l1.inboxAddress.toString()),
		check("outbox", eq(l1.outboxAddress.toString(), pins.outbox), l1.outboxAddress.toString()),
		check("fee juice portal", eq(l1.feeJuicePortalAddress.toString(), pins.feeJuicePortal), l1.feeJuicePortalAddress.toString()),
		check(
			"fee asset handler",
			l1.feeAssetHandlerAddress !== undefined && eq(l1.feeAssetHandlerAddress.toString(), pins.feeAssetHandler),
			String(l1.feeAssetHandlerAddress),
		),
	]
}

/** What Ethereum itself says the registry's canonical rollup is wired to. */
export interface L1Wiring {
	chainId: number
	inbox: Address
	outbox: Address
	feeJuicePortal: Address
	version: bigint
}

export function checkL1Wiring(w: L1Wiring, pins: NetworkPins): Check[] {
	return [
		check("L1 RPC chain id", w.chainId === pins.l1ChainId, `${w.chainId}`),
		check("registry → rollup → inbox", eq(w.inbox, pins.inbox), w.inbox),
		check("registry → rollup → outbox", eq(w.outbox, pins.outbox), w.outbox),
		check("registry → rollup → fee juice portal", eq(w.feeJuicePortal, pins.feeJuicePortal), w.feeJuicePortal),
		check("registry → rollup → version", w.version === BigInt(pins.rollupVersion), `${w.version}`),
	]
}

export function checkAssets(a: { usdcDecimals: number; usdcVersion: string; permit2CodeBytes: number }, pins: NetworkPins): Check[] {
	return [
		check("USDC decimals", a.usdcDecimals === pins.usdcDecimals, `${a.usdcDecimals}`),
		check("USDC EIP-712 version", a.usdcVersion === pins.usdcEip712Version, JSON.stringify(a.usdcVersion)),
		check("Permit2 code", a.permit2CodeBytes > 0, `${a.permit2CodeBytes} bytes`),
	]
}

/**
 * The deploy + smoke pay with Fee Juice minted from the L1 faucet; the SponsoredFPC only pays for the
 * private smoke legs and is topped up right before them, so its balance here is informational.
 */
export function checkFeePath(f: {
	faucetMint: bigint
	deployBudget: bigint
	sponsoredBudget: bigint
	sponsorPublished: boolean
	sponsorBalance: bigint
}): Check[] {
	const fj = (v: bigint) => `${(Number(v / 10n ** 14n) / 1e4).toFixed(2)} FJ`
	const enough = f.sponsorBalance >= f.sponsoredBudget
	return [
		check("fee faucet mint ≥ deploy budget", f.faucetMint >= f.deployBudget, `${fj(f.faucetMint)} per mint vs ${fj(f.deployBudget)}`),
		check("SponsoredFPC published", f.sponsorPublished, f.sponsorPublished ? "instance found" : "no instance at the canonical address"),
		check(
			"SponsoredFPC balance vs the sponsored budget (informational)",
			true,
			enough ? `${fj(f.sponsorBalance)} ≥ ${fj(f.sponsoredBudget)}` : `${fj(f.sponsorBalance)}: \`demo fund\` tops it up first`,
		),
	]
}

const L1_ABI = parseAbi([
	"function getCanonicalRollup() view returns (address)",
	"function getInbox() view returns (address)",
	"function getOutbox() view returns (address)",
	"function getVersion() view returns (uint256)",
	"function getFeeAssetPortal() view returns (address)",
	"function decimals() view returns (uint8)",
	"function version() view returns (string)",
	"function mintAmount() view returns (uint256)",
])

async function readL1Wiring(l1: PublicClient, pins: NetworkPins): Promise<L1Wiring> {
	const rollup = await l1.readContract({ address: pins.registry, abi: L1_ABI, functionName: "getCanonicalRollup" })
	const [chainId, inbox, outbox, feeJuicePortal, version] = await Promise.all([
		l1.getChainId(),
		l1.readContract({ address: rollup, abi: L1_ABI, functionName: "getInbox" }),
		l1.readContract({ address: rollup, abi: L1_ABI, functionName: "getOutbox" }),
		l1.readContract({ address: rollup, abi: L1_ABI, functionName: "getFeeAssetPortal" }),
		l1.readContract({ address: rollup, abi: L1_ABI, functionName: "getVersion" }),
	])
	return { chainId, inbox, outbox, feeJuicePortal, version }
}

async function readAssets(l1: PublicClient, pins: NetworkPins) {
	const [usdcDecimals, usdcVersion, code, faucetMint] = await Promise.all([
		l1.readContract({ address: pins.usdc, abi: L1_ABI, functionName: "decimals" }),
		l1.readContract({ address: pins.usdc, abi: L1_ABI, functionName: "version" }),
		l1.getCode({ address: pins.permit2 }),
		l1.readContract({ address: pins.feeAssetHandler, abi: L1_ABI, functionName: "mintAmount" }),
	])
	return { usdcDecimals, usdcVersion, permit2CodeBytes: code ? (code.length - 2) / 2 : 0, faucetMint }
}

/** Keyless, read-only: every identity and funding fact a testnet deploy relies on. */
export async function probeNetwork(pins: NetworkPins, l1RpcUrl: string): Promise<Check[]> {
	const node = createAztecNodeClient(pins.nodeUrl)
	const l1 = createPublicClient({ transport: http(l1RpcUrl) }) as PublicClient
	const fpc = AztecAddress.fromStringUnsafe(pins.sponsoredFpc)
	const [info, wiring, assets, fpcInstance, balance, predicted] = await Promise.all([
		node.getNodeInfo(),
		readL1Wiring(l1, pins),
		readAssets(l1, pins),
		node.getContract(fpc),
		getFeeJuiceBalance(fpc, node),
		node.getPredictedMinFees(ManaUsageEstimate.Limit),
	])
	const budget = (txs: readonly string[]) => feeBudget({ txCount: txs.length, gasPerTx: ESTIMATED_GAS_PER_TX, predicted, headroom: 3n })
	return [
		...checkNodeIdentity(info, pins),
		...checkL1Wiring(wiring, pins),
		...checkAssets(assets, pins),
		...checkFeePath({
			faucetMint: assets.faucetMint,
			deployBudget: budget(TESTNET_DEPLOY_TXS),
			sponsoredBudget: budget(TESTNET_SPONSORED_TXS),
			sponsorPublished: fpcInstance !== undefined,
			sponsorBalance: balance,
		}),
	]
}
