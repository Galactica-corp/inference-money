import { describe, expect, it } from "bun:test"
import {
	type Address,
	createPublicClient,
	createWalletClient,
	custom,
	getContractAddress,
	type Hex,
	keccak256,
	type PublicClient,
	parseTransaction,
	toHex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { EvmArtifact } from "./evm"
import { deployEvm, type L1Signer, l1Chain } from "./l1"

const account = privateKeyToAccount(`0x${"11".repeat(32)}`)
const NONCE = 7
const ARTIFACT: EvmArtifact = { abi: [], bytecode: "0x6080604052", deployedBytecode: "0x", immutableRanges: [] }
const OTHER: Hex = `0x${"ee".repeat(32)}`

/** An L1 endpoint that answers like anvil, except where `lie` says otherwise. */
function fakeL1(lie: { echo?: Hex; receiptTx?: Hex; created?: Address; fillChainId?: number } = {}) {
	const calls: string[] = []
	const sent: Hex[] = []
	const created = getContractAddress({ from: account.address, nonce: BigInt(NONCE) })
	const answers: Record<string, (params: unknown[]) => unknown> = {
		eth_chainId: () => toHex(31337),
		eth_blockNumber: () => toHex(2),
		eth_getTransactionCount: () => toHex(NONCE),
		eth_estimateGas: () => toHex(500_000),
		eth_maxPriorityFeePerGas: () => toHex(1),
		eth_gasPrice: () => toHex(2),
		eth_getBlockByNumber: () => ({ number: toHex(2), hash: OTHER, baseFeePerGas: toHex(1), timestamp: "0x1", transactions: [] }),
		eth_fillTransaction: ([tx]) => {
			if (lie.fillChainId === undefined) throw new Error("eth_fillTransaction is not available")
			const { data } = tx as { data: Hex }
			const filled = { type: "0x2", chainId: toHex(lie.fillChainId), nonce: toHex(NONCE), gas: toHex(500_000), input: data }
			return { raw: "0x", tx: { ...filled, maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", value: "0x0", to: null, hash: OTHER } }
		},
		eth_sendRawTransaction: ([raw]) => {
			sent.push(raw as Hex)
			return lie.echo ?? keccak256(raw as Hex)
		},
		eth_getTransactionReceipt: ([hash]) => ({
			transactionHash: lie.receiptTx ?? hash,
			contractAddress: lie.created ?? created,
			status: "0x1",
			blockNumber: toHex(2),
			blockHash: OTHER,
			transactionIndex: "0x0",
			from: account.address,
			to: null,
			cumulativeGasUsed: "0x1",
			gasUsed: "0x1",
			effectiveGasPrice: "0x1",
			logs: [],
			logsBloom: `0x${"00".repeat(256)}`,
			type: "0x2",
		}),
	}
	const provider = {
		request: async ({ method, params }: { method: string; params?: unknown[] }) => {
			calls.push(method)
			const answer = answers[method]
			if (!answer) throw new Error(`unexpected ${method}`)
			return answer(params ?? [])
		},
	}
	const chain = l1Chain("http://fake.invalid", 31337)
	const transport = custom(provider)
	const l1: L1Signer = {
		publicClient: createPublicClient({ chain, transport, pollingInterval: 10 }) as PublicClient,
		walletClient: createWalletClient({ chain, transport, account }),
		account,
		chain,
	}
	return { l1, calls, sent, created }
}

describe("deployEvm", () => {
	it("signs the create here at the pending nonce, and returns the address that key and nonce determine", async () => {
		const { l1, sent, created } = fakeL1()
		const deployed = await deployEvm(l1, "Thing", ARTIFACT)
		expect(deployed).toEqual({ address: created, block: 2n, tx: keccak256(sent[0] as Hex) })
		const tx = parseTransaction(sent[0] as Hex)
		expect([tx.nonce, tx.to, tx.data, tx.chainId]).toEqual([NONCE, undefined, ARTIFACT.bytecode, 31337])
	})

	it("refuses an RPC that echoes another tx hash, before waiting on any receipt", async () => {
		const { l1, calls } = fakeL1({ echo: OTHER })
		await expect(deployEvm(l1, "Thing", ARTIFACT)).rejects.toThrow("the RPC answered tx")
		expect(calls).not.toContain("eth_getTransactionReceipt")
	})

	it("refuses a tx the RPC prepared for another chain, before signing it", async () => {
		const { l1, sent } = fakeL1({ fillChainId: 1 })
		await expect(deployEvm(l1, "Thing", ARTIFACT)).rejects.toThrow("prepared it for chain 1, not 31337")
		expect(sent).toEqual([])
	})

	it("refuses a receipt for another tx at the same nonce", async () => {
		const { l1 } = fakeL1({ receiptTx: OTHER })
		await expect(deployEvm(l1, "Thing", ARTIFACT)).rejects.toThrow("was replaced by")
	})

	it("refuses a receipt naming another contract address", async () => {
		const { l1 } = fakeL1({ created: "0x00000000000000000000000000000000000000cc" })
		await expect(deployEvm(l1, "Thing", ARTIFACT)).rejects.toThrow("the receipt names")
	})
})
