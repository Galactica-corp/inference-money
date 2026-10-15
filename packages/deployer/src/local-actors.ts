import { NO_FROM } from "@aztec-labs/aztec.js/account"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { type BridgeManifest, randomSecret, signingKeyFor, sponsoredPayment } from "@inference-money/bridge-core"
import { withBlockHeartbeat } from "@inference-money/local-network"

/** A fresh Schnorr account in `wallet`, deployed through the sponsor; `secret` alone rebuilds it in any wallet. */
export async function newSponsoredAccount(wallet: EmbeddedWallet, m: BridgeManifest, secret = randomSecret()): Promise<AztecAddress> {
	const manager = await wallet.createSchnorrAccount(secret, Fr.ZERO, signingKeyFor(secret))
	const deploy = await manager.getDeployMethod()
	await deploy.send({ from: NO_FROM, fee: { paymentMethod: sponsoredPayment(m) } })
	return manager.address
}

/**
 * Keeps a local network building blocks until the returned stop is awaited: it builds one only when a tx arrives, so
 * an L1→L2 message never becomes claimable without traffic. The beat revokes a random, never-granted public authwit:
 * the cheapest public tx, from an account of its own so it never races a test's nonces.
 */
export async function startBlockHeartbeat(wallet: EmbeddedWallet, m: BridgeManifest): Promise<() => Promise<void>> {
	const beater = await newSponsoredAccount(wallet, m)
	const send = { from: beater, fee: { paymentMethod: sponsoredPayment(m) }, wait: { waitForStatus: TxStatus.PROPOSED } }
	const forceBlock = async () => (await SetPublicAuthwitContractInteraction.create(wallet, beater, randomSecret(), false)).send(send)
	const stop = Promise.withResolvers<void>()
	const beating = withBlockHeartbeat(forceBlock, () => stop.promise)
	return async () => {
		stop.resolve()
		await beating
	}
}
