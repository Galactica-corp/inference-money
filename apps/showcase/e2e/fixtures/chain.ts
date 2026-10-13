/**
 * The suite's own view of the chains, independent of the app: the run's manifest, anvil reads and writes, and the Aztec
 * node's receipts. Everything here is Node-side and never goes through the page.
 */
import { readFileSync } from "node:fs"
import { ethereumKey } from "@galactica-net/inference-money-demo/keys"
import { type Address, createPublicClient, createWalletClient, decodeFunctionData, type Hex, http, parseAbi, parseAbiItem } from "viem"
import { privateKeyToAccount } from "viem/accounts"

/** The manifest fields the suite reads; the app embeds the same file. */
export interface RunManifest {
	l1: { usdc: Address; router: Address; portal: Address; outbox: Address; deployBlock: number }
	l2: { nodeUrl: string; sponsoredFpc?: string; bridge: { address: string }; token: { address: string } }
}

export const readRunManifest = (path: string): RunManifest => JSON.parse(readFileSync(path, "utf8")) as RunManifest

/** Restated from the contract, not imported from bridge-core: decoding fails if the two ever diverge. */
export const ROUTER_ABI = parseAbi([
	"function deposit(uint256 amount, bytes32 aztecRecipient, bytes32 secretHash, bool isPrivate, uint256 nonce, uint256 deadline, bytes signature)",
])
const DEPOSIT_EVENT = parseAbiItem(
	"event Deposit(address indexed depositor, bytes32 indexed aztecRecipient, bytes32 key, uint256 index, uint256 amount, bytes32 secretHash, bool isPrivate)",
)
const ERC20_ABI = parseAbi([
	"function balanceOf(address) view returns (uint256)",
	"function mint(address to, uint256 amount)",
	"function transfer(address to, uint256 amount) returns (bool)",
])

const reader = (anvilUrl: string) => createPublicClient({ transport: http(anvilUrl) })

export function usdcOf(anvilUrl: string, m: RunManifest, who: Address): Promise<bigint> {
	return reader(anvilUrl).readContract({ address: m.l1.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [who] })
}

/** A demo user's Ethereum wallet (A_demo is alice's), whose key is public like every demo key. */
export function demoWallet(m: RunManifest, user: "alice" | "bob"): { key: Hex; address: Address } {
	const key = ethereumKey(m.l2.bridge.address as Hex, user)
	return { key, address: privateKeyToAccount(key).address }
}

/** A MockUsdc call signed by `key`, mined. */
async function writeUsdc(anvilUrl: string, m: RunManifest, key: Hex, call: "mint" | "transfer", to: Address, amount: bigint) {
	const account = privateKeyToAccount(key)
	const wallet = createWalletClient({ account, transport: http(anvilUrl) })
	const chainId = await reader(anvilUrl).getChainId()
	const hash = await wallet.writeContract({
		address: m.l1.usdc,
		abi: ERC20_ABI,
		functionName: call,
		args: [to, amount],
		chain: {
			id: chainId,
			name: "anvil",
			nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
			rpcUrls: { default: { http: [anvilUrl] } },
		},
	})
	await reader(anvilUrl).waitForTransactionReceipt({ hash })
}

export const mintUsdc = (anvilUrl: string, m: RunManifest, key: Hex, amount: bigint) =>
	writeUsdc(anvilUrl, m, key, "mint", privateKeyToAccount(key).address, amount)

export const transferUsdc = (anvilUrl: string, m: RunManifest, key: Hex, to: Address, amount: bigint) =>
	writeUsdc(anvilUrl, m, key, "transfer", to, amount)

/** Every router deposit `depositor` made, decoded from the calldata that actually mined. */
export async function depositsBy(anvilUrl: string, m: RunManifest, depositor: Address) {
	const client = reader(anvilUrl)
	const logs = await client.getLogs({
		address: m.l1.router,
		event: DEPOSIT_EVENT,
		args: { depositor },
		fromBlock: BigInt(m.l1.deployBlock),
	})
	return Promise.all(
		logs.map(async (log) => {
			const tx = await client.getTransaction({ hash: log.transactionHash as Hex })
			const [amount, aztecRecipient, secretHash, isPrivate, nonce, deadline] = decodeFunctionData({
				abi: ROUTER_ABI,
				data: tx.input,
			}).args
			return { txHash: log.transactionHash as Hex, amount, aztecRecipient, secretHash, isPrivate, nonce, deadline }
		}),
	)
}

/** The Aztec node's own receipt for `hash`, read here rather than through any wallet or the app. */
export async function l2Receipt(nodeUrl: string, hash: string): Promise<{ status: string; executionResult?: string }> {
	const res = await fetch(nodeUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_getTxReceipt", params: [hash] }),
	})
	const body = (await res.json()) as { result?: { status: string; executionResult?: string }; error?: unknown }
	if (!body.result) throw new Error(`node_getTxReceipt ${hash}: ${JSON.stringify(body.error)}`)
	return body.result
}
