import { getSchnorrAccountContractAddress } from "@aztec-labs/accounts/schnorr/lazy"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type Fq, Fr } from "@aztec-labs/aztec.js/fields"
import { type BridgeManifest, randomSecret, signingKeyFor } from "@galactica-net/inference-money-core"
import { type Address, bytesToHex, type Hex } from "viem"
import { privateKeyToAddress } from "viem/accounts"
import { type Actor, isUser } from "./actors"
import { demoDigest as digest, ethereumKey } from "./keys"
import { MERCHANTS_SALT } from "./merchants-salt"
import { USERS_TAG } from "./users-tag"

/** What the cast derives from: the users' tag and the merchants' salt. */
export interface CastKeys {
	usersTag?: string
	merchantsSalt: string
}

/**
 * An actor's Aztec secret. A user's takes the users' tag and a merchant's the merchants' salt, which `demo setup` draws
 * and publishes only once every binding is final, so nobody can bind a cast account before the demo.
 */
export function aztecSecret(bridge: Hex, actor: Actor, keys: CastKeys): Fr {
	if (isUser(actor)) {
		const tag = keys.usersTag
		if (tag === undefined || !USERS_TAG.test(tag)) throw new Error(`${actor}'s key needs the users' tag (32 lowercase hex characters)`)
		return new Fr(digest(`${bridge}/${tag}/${actor}/aztec`) % Fr.MODULUS)
	}
	const salt = keys.merchantsSalt
	if (!MERCHANTS_SALT.test(salt)) throw new Error(`${actor}'s key needs the merchants' salt (a 0x-prefixed field element)`)
	return new Fr(digest(`${bridge}/${salt}/${actor}/aztec`) % Fr.MODULUS)
}

/** A fresh users' tag for `demo setup` (`--rotate` draws a new one). */
export const newUsersTag = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(16))).slice(2)

/** A fresh merchants' salt for `demo setup` (`--rotate` keeps the published one). */
export const newMerchantsSalt = (): string => randomSecret().toString()

export interface CastMember {
	actor: Actor
	secret: Fr
	signingKey: Fq
	ethereumKey: Hex
	ethereum: Address
}

export function castMember(m: BridgeManifest, actor: Actor, keys: CastKeys): CastMember {
	const secret = aztecSecret(m.l2.bridge.address, actor, keys)
	const key = ethereumKey(m.l2.bridge.address, actor)
	return { actor, secret, signingKey: signingKeyFor(secret), ethereumKey: key, ethereum: privateKeyToAddress(key) }
}

/** The member's Schnorr account at salt 0: the address `createSchnorrAccount(secret, 0, signingKey)` registers. */
export const aztecAddressOf = (c: Pick<CastMember, "secret" | "signingKey">): Promise<AztecAddress> =>
	getSchnorrAccountContractAddress(c.signingKey, Fr.ZERO, c.secret)
