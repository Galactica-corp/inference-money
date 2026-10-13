import {
	type Abi,
	type Account,
	type Address,
	type Chain,
	createPublicClient,
	createWalletClient,
	defineChain,
	getAddress,
	type Hex,
	http,
	type PublicClient,
	type WalletClient,
} from "viem"
import { withGasHeadroom } from "../types"
import type { EvmArtifact } from "./evm"

/** A signing L1 context for scripts: one account, one writer, sends in sequence (each awaits its receipt). */
export interface L1Signer {
	publicClient: PublicClient
	walletClient: WalletClient
	account: Account
	chain: Chain
}

export const l1Chain = (rpcUrl: string, chainId: number): Chain =>
	defineChain({
		id: chainId,
		name: `chain-${chainId}`,
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: { default: { http: [rpcUrl] } },
	})

export function l1Signer(rpcUrl: string, chainId: number, account: Account): L1Signer {
	const chain = l1Chain(rpcUrl, chainId)
	const transport = http(rpcUrl)
	return {
		publicClient: createPublicClient({ chain, transport }) as PublicClient,
		walletClient: createWalletClient({ chain, transport, account }),
		account,
		chain,
	}
}

async function mined(l1: L1Signer, hash: Hex, what: string) {
	const receipt = await l1.publicClient.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`${what} reverted (tx ${hash})`)
	return receipt
}

export async function deployEvm(l1: L1Signer, name: string, a: EvmArtifact, args: unknown[] = []) {
	const hash = await l1.walletClient.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: l1.account, chain: l1.chain })
	const receipt = await mined(l1, hash, `${name} deploy`)
	if (!receipt.contractAddress) throw new Error(`${name} deploy produced no address (tx ${hash})`)
	return { address: getAddress(receipt.contractAddress), block: receipt.blockNumber }
}

export async function writeEvm(l1: L1Signer, what: string, address: Address, abi: Abi, functionName: string, args: unknown[]) {
	const call = { address, abi, functionName, args, account: l1.account }
	const gas = withGasHeadroom(await l1.publicClient.estimateContractGas(call))
	const hash = await l1.walletClient.writeContract({ ...call, gas, chain: l1.chain })
	return mined(l1, hash, what)
}
