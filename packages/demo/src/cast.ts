import { getSchnorrAccountContractAddress } from "@aztec-labs/accounts/schnorr/lazy"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type Fq, Fr } from "@aztec-labs/aztec.js/fields"
import { type BridgeManifest, signingKeyFor } from "@galactica-net/inference-money-core"
import { type Address, bytesToHex, type Hex } from "viem"
import { privateKeyToAddress } from "viem/accounts"
import { type Actor, isUser } from "./actors"
import { demoDigest as digest, ethereumKey } from "./keys"
import { USERS_TAG } from "./users-tag"

/**
 * An actor's Aztec secret. A merchant's derives from the deployment alone; a user's also takes the users' tag, which
 * `demo setup` draws and publishes only once both users are bound, so nobody can bind a user account before the demo.
 */
export function aztecSecret(bridge: Hex, actor: Actor, tag?: string): Fr {
	if (!isUser(actor)) return new Fr(digest(`${bridge}/${actor}/aztec`) % Fr.MODULUS)
	if (tag === undefined || !USERS_TAG.test(tag)) throw new Error(`${actor}'s key needs the users' tag (32 lowercase hex characters)`)
	return new Fr(digest(`${bridge}/${tag}/${actor}/aztec`) % Fr.MODULUS)
}

/** A fresh users' tag for `demo setup` (`--rotate` draws a new one). */
export const newUsersTag = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(16))).slice(2)

export interface CastMember {
	actor: Actor
	secret: Fr
	signingKey: Fq
	ethereumKey: Hex
	ethereum: Address
}

export function castMember(m: BridgeManifest, actor: Actor, tag?: string): CastMember {
	const secret = aztecSecret(m.l2.bridge.address, actor, tag)
	const key = ethereumKey(m.l2.bridge.address, actor)
	return { actor, secret, signingKey: signingKeyFor(secret), ethereumKey: key, ethereum: privateKeyToAddress(key) }
}

/** The member's Schnorr account at salt 0: the address `createSchnorrAccount(secret, 0, signingKey)` registers. */
export const aztecAddressOf = (c: Pick<CastMember, "secret" | "signingKey">): Promise<AztecAddress> =>
	getSchnorrAccountContractAddress(c.signingKey, Fr.ZERO, c.secret)
