import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { L1FeeJuicePortalManager, type L2AmountClaim } from "@aztec-labs/aztec.js/ethereum"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { FeeJuiceContract } from "@aztec-labs/aztec.js/protocol"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { createEthereumChain } from "@aztec-labs/ethereum/chain"
import { createExtendedL1Client } from "@aztec-labs/ethereum/client"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { createLogger } from "@aztec-labs/foundation/log"
import { L2_DONE } from "@galactica-net/inference-money-core"
import { type Hex, isAddressEqual, parseAbi } from "viem"
import type { NetworkPins } from "./networks"

/** Where the funder bridges and what it approves: a network's pins, never a node's answer. */
export type FeeJuicePins = Pick<NetworkPins, "l1ChainId" | "feeJuicePortal" | "feeAssetHandler" | "feeAsset">

/** Fee Juice from the testnet faucet (one mint), or `amount` of the fee asset the L1 key already holds (mainnet). */
export type FeeJuiceSource = { faucet: true } | { amount: bigint }

const PORTAL_ABI = parseAbi(["function UNDERLYING() view returns (address)"])

/**
 * Bridges Fee Juice to `to`: a faucet mint from the testnet handler, or `amount` of the fee asset the key holds,
 * approved for exactly that. Resolves once the L1→L2 message is consumable on L2, so the claim can be spent in the next tx.
 */
export async function bridgeFeeJuice(p: {
	node: AztecNode
	pins: FeeJuicePins
	l1RpcUrl: string
	l1PrivateKey: Hex
	to: AztecAddress
	source?: FeeJuiceSource
	/** Default true. False returns once the L1 deposit is mined; wait with {@link waitFeeJuiceReady} before spending it. */
	waitReady?: boolean
	log: (msg: string) => void
}): Promise<L2AmountClaim> {
	const source = p.source ?? { faucet: true }
	const handler = "faucet" in source ? p.pins.feeAssetHandler : undefined
	if ("faucet" in source && !handler) throw new Error("this network has no fee asset faucet: bridge an amount the key holds")
	// Aztec's L1 helpers are typed against its own viem fork, so the key crosses as a string, in process.
	const chain = createEthereumChain([p.l1RpcUrl], p.pins.l1ChainId)
	const l1 = createExtendedL1Client(chain.rpcUrls, p.l1PrivateKey, chain.chainInfo)
	// `L1FeeJuicePortalManager.new` would take the token, portal and handler from the node's `getNodeInfo()`.
	const token = await l1.readContract({ address: p.pins.feeJuicePortal, abi: PORTAL_ABI, functionName: "UNDERLYING" })
	if (p.pins.feeAsset && !isAddressEqual(token, p.pins.feeAsset)) {
		throw new Error(`the fee juice portal bridges ${token}, not the pinned fee asset ${p.pins.feeAsset}`)
	}
	const portal = new L1FeeJuicePortalManager(
		EthAddress.fromString(p.pins.feeJuicePortal),
		EthAddress.fromString(token),
		handler ? EthAddress.fromString(handler) : undefined,
		l1,
		createLogger("deployer:fee-juice"),
	)
	p.log(`${"faucet" in source ? "minting + bridging" : `bridging ${source.amount} of`} Fee Juice to ${p.to}`)
	const claim =
		"faucet" in source
			? await portal.bridgeTokensPublic(p.to, undefined, true)
			: await portal.bridgeTokensPublic(p.to, source.amount, false)
	p.log(`bridged ${claim.claimAmount} (message ${claim.messageHash})`)
	if (p.waitReady !== false) await waitFeeJuiceReady(p.node, claim, p.log)
	return claim
}

/** Resolves once the claim's L1→L2 message is consumable on L2. */
export async function waitFeeJuiceReady(node: AztecNode, claim: L2AmountClaim, log: (msg: string) => void): Promise<void> {
	log(`waiting until message ${claim.messageHash} is consumable on L2`)
	await waitForL1ToL2MessageReady(node, Fr.fromHexString(claim.messageHash), { timeoutSeconds: 1800 })
}

/** Claims bridged Fee Juice into `to`'s balance, publicly, sent by `from`, which pays the tx; any account may. */
export async function claimFeeJuiceFor(p: {
	wallet: Wallet
	from: AztecAddress
	to: AztecAddress
	claim: L2AmountClaim
	fee?: { paymentMethod: FeePaymentMethod }
}): Promise<void> {
	const { claimAmount, claimSecret, messageLeafIndex } = p.claim
	await FeeJuiceContract.at(p.wallet)
		.methods.claim(p.to, claimAmount, claimSecret, new Fr(messageLeafIndex))
		.send({ from: p.from, fee: p.fee, wait: L2_DONE })
}

const SPONSOR_TOP_UP_FLOOR = 100n * 10n ** 18n

export interface SponsorTopUp {
	node: AztecNode
	wallet: Wallet
	/** Sends the public claim; any account may. */
	from: AztecAddress
	sponsor: AztecAddress
	fee?: { paymentMethod: FeePaymentMethod }
	bridge: Omit<Parameters<typeof bridgeFeeJuice>[0], "node" | "to" | "log">
	log: (m: string) => void
}

/** Bridges a faucet mint to the sponsor and claims it publicly, so the demo's private txs never find it drained. */
export async function topUpSponsor(p: SponsorTopUp): Promise<bigint> {
	const minted = await bridgeFeeJuice({ ...p.bridge, node: p.node, to: p.sponsor, log: p.log })
	await claimFeeJuiceFor({ wallet: p.wallet, from: p.from, to: p.sponsor, claim: minted, fee: p.fee })
	const balance = await getFeeJuiceBalance(p.sponsor, p.node)
	if (balance < SPONSOR_TOP_UP_FLOOR) throw new Error(`the sponsor holds ${balance} FJ after the top-up`)
	p.log(`sponsor ${p.sponsor} topped up to ${balance}`)
	return balance
}
