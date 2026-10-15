import {
	type Abi,
	type Account,
	type Address,
	type Chain,
	createPublicClient,
	createWalletClient,
	defineChain,
	encodeDeployData,
	getContractAddress,
	type Hex,
	http,
	isAddressEqual,
	keccak256,
	type PublicClient,
	type TransactionSerializable,
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

/** viem resolves a replaced tx (another one at its nonce) with the replacement's receipt; only `hash` itself counts. */
async function mined(l1: L1Signer, hash: Hex, what: string) {
	const receipt = await l1.publicClient.waitForTransactionReceipt({ hash })
	if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
		throw new Error(`${what}: tx ${hash} was replaced by ${receipt.transactionHash}`)
	}
	if (receipt.status !== "success") throw new Error(`${what} reverted (tx ${hash})`)
	return receipt
}

export interface Deployed {
	address: Address
	block: bigint
	/** The creation tx, hashed from the bytes signed here. */
	tx: Hex
}

/**
 * Creates at the address this key and its pending nonce determine, from a tx signed here (prepared as `deployContract`
 * would), so neither the RPC's echoed hash nor its receipt's address can bind the deploy to another contract. The RPC
 * is still trusted for inclusion.
 */
export async function deployEvm(l1: L1Signer, name: string, a: EvmArtifact, args: unknown[] = []): Promise<Deployed> {
	const { account, chain, publicClient, walletClient } = l1
	if (account.type !== "local") throw new Error(`${name} deploy needs a local account: its tx is signed in process`)
	const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" })
	const address = getContractAddress({ from: account.address, nonce: BigInt(nonce) })
	const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args })
	const request = await walletClient.prepareTransactionRequest({ account, chain, data, nonce })
	// viem keeps the chain id an RPC's eth_fillTransaction answers; signed for another chain, the tx is replayable there.
	if (request.chainId !== chain.id) throw new Error(`${name} deploy: the RPC prepared it for chain ${request.chainId}, not ${chain.id}`)
	const signed = await account.signTransaction(request as TransactionSerializable, { serializer: chain.serializers?.transaction })
	const tx = keccak256(signed)
	const echoed = await walletClient.sendRawTransaction({ serializedTransaction: signed })
	if (echoed.toLowerCase() !== tx) throw new Error(`${name} deploy: the RPC answered tx ${echoed} for the signed ${tx}`)
	const receipt = await mined(l1, tx, `${name} deploy`)
	if (!receipt.contractAddress || !isAddressEqual(receipt.contractAddress, address)) {
		throw new Error(`${name} deploy: the receipt names ${receipt.contractAddress} for tx ${tx}, not ${address}`)
	}
	return { address, block: receipt.blockNumber, tx }
}

export async function writeEvm(l1: L1Signer, what: string, address: Address, abi: Abi, functionName: string, args: unknown[]) {
	const call = { address, abi, functionName, args, account: l1.account }
	const gas = withGasHeadroom(await l1.publicClient.estimateContractGas(call))
	const hash = await l1.walletClient.writeContract({ ...call, gas, chain: l1.chain })
	return mined(l1, hash, what)
}
