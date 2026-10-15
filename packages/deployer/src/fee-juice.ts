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
import { type Hex, parseAbi } from "viem"
import type { NetworkPins } from "./networks"

/** Where the funder mints and what it approves: a network's pins, never a node's answer. */
export type FeeJuicePins = Pick<NetworkPins, "l1ChainId" | "feeJuicePortal" | "feeAssetHandler">

const PORTAL_ABI = parseAbi(["function UNDERLYING() view returns (address)"])

/**
 * Mints the testnet fee asset from its permissionless L1 handler and bridges it to `to` as Fee Juice.
 * Resolves once the L1→L2 message is consumable on L2, so the claim can be spent in the next tx.
 */
export async function bridgeFeeJuice(p: {
	node: AztecNode
	pins: FeeJuicePins
	l1RpcUrl: string
	l1PrivateKey: Hex
	to: AztecAddress
	log: (msg: string) => void
}): Promise<L2AmountClaim> {
	// Aztec's L1 helpers are typed against its own viem fork, so the key crosses as a string, in process.
	const chain = createEthereumChain([p.l1RpcUrl], p.pins.l1ChainId)
	const l1 = createExtendedL1Client(chain.rpcUrls, p.l1PrivateKey, chain.chainInfo)
	// `L1FeeJuicePortalManager.new` would take the token, portal and handler from the node's `getNodeInfo()`.
	const token = await l1.readContract({ address: p.pins.feeJuicePortal, abi: PORTAL_ABI, functionName: "UNDERLYING" })
	const portal = new L1FeeJuicePortalManager(
		EthAddress.fromString(p.pins.feeJuicePortal),
		EthAddress.fromString(token),
		EthAddress.fromString(p.pins.feeAssetHandler),
		l1,
		createLogger("deployer:fee-juice"),
	)
	p.log(`minting + bridging Fee Juice to ${p.to}`)
	const claim = await portal.bridgeTokensPublic(p.to, undefined, true)
	p.log(`bridged ${claim.claimAmount} (message ${claim.messageHash}); waiting until it is consumable on L2`)
	await waitForL1ToL2MessageReady(p.node, Fr.fromHexString(claim.messageHash), { timeoutSeconds: 1800 })
	return claim
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
	const claimCall = FeeJuiceContract.at(p.wallet).methods.claim(
		p.sponsor,
		minted.claimAmount,
		minted.claimSecret,
		new Fr(minted.messageLeafIndex),
	)
	await claimCall.send({ from: p.from, fee: p.fee })
	const balance = await getFeeJuiceBalance(p.sponsor, p.node)
	if (balance < SPONSOR_TOP_UP_FLOOR) throw new Error(`the sponsor holds ${balance} FJ after the top-up`)
	p.log(`sponsor ${p.sponsor} topped up to ${balance}`)
	return balance
}
