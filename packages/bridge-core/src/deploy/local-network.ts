import { NO_FROM } from "@aztec-labs/aztec.js/account"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { sponsoredPayment } from "../claim"
import type { BridgeManifest } from "../manifest"
import { randomSecret } from "../random"
import { signingKeyFor } from "../signing-key"

/**
 * Runs `fn` while forcing a block every `intervalMs`. The local network builds a block only when a tx arrives, so a
 * wait on chain progress (an L1→L2 message becoming consumable, an epoch proving) never advances without one.
 * `forceBlock` failures are ignored: a missed beat only delays the next one.
 */
export async function withBlockHeartbeat<T>(forceBlock: () => Promise<unknown>, fn: () => Promise<T>, intervalMs = 3_000): Promise<T> {
	let beating = true
	let wake: () => void = () => {}
	const beats = (async () => {
		while (beating) {
			await forceBlock().catch(() => {})
			await new Promise<void>((r) => {
				wake = r
				setTimeout(r, intervalMs)
			})
		}
	})()
	try {
		return await fn()
	} finally {
		beating = false
		wake()
		await beats
	}
}

/** A fresh Schnorr account in `wallet`, deployed through the sponsor; `secret` alone rebuilds it in any wallet. */
export async function newSponsoredAccount(wallet: EmbeddedWallet, m: BridgeManifest, secret = randomSecret()): Promise<AztecAddress> {
	const manager = await wallet.createSchnorrAccount(secret, Fr.ZERO, signingKeyFor(secret))
	const deploy = await manager.getDeployMethod()
	await deploy.send({ from: NO_FROM, fee: { paymentMethod: sponsoredPayment(m) } })
	return manager.address
}

/**
 * Keeps a local network building blocks until the returned stop is awaited: it builds one only when a tx arrives, so
 * an L1→L2 message never becomes claimable without traffic. Local networks only: testnet builds its own blocks. The
 * beat revokes a random, never-granted public authwit: the cheapest public tx, from an account of its own so it never
 * races a test's nonces. Give it a wallet of its own, with the sponsor registered (`registerSponsor`).
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
