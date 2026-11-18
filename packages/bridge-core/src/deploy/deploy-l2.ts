import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { BatchCall, Contract } from "@aztec-labs/aztec.js/contracts"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { ContractInitializationStatus } from "@aztec-labs/aztec.js/wallet"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import type { Address } from "viem"
import { tokenArtifact, tokenBridgeArtifact, tokenMinterProxyArtifact } from "../artifacts"
import { instanceRecord } from "../instances"
import type { L2InstanceRecord } from "../manifest"
import { randomSecret } from "../random"
import { signingKeyFor } from "../signing-key"

/** How a network pays: the account deploy (the account has no balance yet), then every later tx (undefined: its own Fee Juice). */
export interface L2Fees {
	accountDeploy(account: AztecAddress): Promise<FeePaymentMethod>
	tx: FeePaymentMethod | undefined
}

/**
 * Registers the Schnorr account `secret` rebuilds in `wallet`, deploying it first unless its initialization nullifier
 * exists. An account deploy does not publish its instance, so the node's contract lookup cannot answer this.
 */
export async function ensureAccount(
	wallet: EmbeddedWallet,
	secret: Fr,
	fees: Pick<L2Fees, "accountDeploy">,
	log: (m: string) => void,
	label: string,
): Promise<AztecAddress> {
	const manager = await wallet.createSchnorrAccount(secret, Fr.ZERO, signingKeyFor(secret))
	const { initializationStatus } = await wallet.getContractMetadata(manager.address)
	if (initializationStatus === ContractInitializationStatus.INITIALIZED) {
		log(`${label} ${manager.address}: already deployed`)
		return manager.address
	}
	log(`${label} ${manager.address}: deploying`)
	const deploy = await manager.getDeployMethod()
	await deploy.send({ from: NO_FROM, fee: { paymentMethod: await fees.accountDeploy(manager.address) } })
	return manager.address
}

export interface L2Deployment {
	proxy: L2InstanceRecord
	token: L2InstanceRecord
	bridge: L2InstanceRecord
}

/**
 * Proxy, Token (minter = proxy), bridge(proxy, token, portal), then the proxy's one-shot `set_token` + `set_bridge` in one
 * batch. Every instance is bound to `deployer`: aztec-nr refuses any other initializer, so nobody can front-run an
 * initialization and capture ownership.
 */
export async function deployBridgeL2(
	wallet: EmbeddedWallet,
	deployer: AztecAddress,
	fees: L2Fees,
	portal: Address,
	log: (m: string) => void,
): Promise<L2Deployment> {
	const send = { from: deployer, fee: fees.tx ? { paymentMethod: fees.tx } : undefined }
	const deployOne = async (label: string, artifact: ContractArtifact, initializer: string, args: unknown[]) => {
		const method = Contract.deploy(wallet, artifact, args, initializer, { deployer, salt: randomSecret() })
		const instance = await method.getInstance()
		log(`${label} ${instance.address}: deploying`)
		await method.send(send)
		return instanceRecord(instance, initializer, args as never)
	}
	const proxy = await deployOne("proxy", tokenMinterProxyArtifact, "constructor", [])
	const proxyAddress = AztecAddress.fromStringUnsafe(proxy.address)
	const token = await deployOne("token", tokenArtifact, "constructor_with_minter", [
		"USD Coin",
		"USDC",
		6,
		proxyAddress,
		AztecAddress.ZERO,
	])
	const bridge = await deployOne("bridge", tokenBridgeArtifact, "constructor", [
		proxyAddress,
		AztecAddress.fromStringUnsafe(token.address),
		EthAddress.fromString(portal),
	])
	log("proxy: set_token + set_bridge")
	const p = Contract.at(proxyAddress, tokenMinterProxyArtifact, wallet)
	const wiring = [
		p.methods.set_token!(AztecAddress.fromStringUnsafe(token.address)),
		p.methods.set_bridge!(AztecAddress.fromStringUnsafe(bridge.address)),
	]
	await new BatchCall(wallet, wiring).send(send)
	return { proxy, token, bridge }
}
