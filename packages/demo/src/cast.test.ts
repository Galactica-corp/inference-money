import { describe, expect, it } from "bun:test"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { signingKeyFor } from "@galactica-net/inference-money-core"
import { MANIFEST } from "../../bridge-core/src/test/fixtures"
import { aztecAddressOf, aztecSecret, type CastKeys, castMember, newMerchantsSalt, newUsersTag } from "./cast"
import { ethereumKey } from "./keys"
import { MERCHANTS_SALT } from "./merchants-salt"

const BRIDGE = MANIFEST.l2.bridge.address
const KEYS = { usersTag: "0123456789abcdef0123456789abcdef", merchantsSalt: `0x${"1f".repeat(32)}` }

describe("demo cast", () => {
	it("derives the address the wallet registers for a secret (the local deployer's, pinned)", async () => {
		const secret = new Fr(0x1a7e0de9107e5n)
		expect((await aztecAddressOf({ secret, signingKey: signingKeyFor(secret) })).toString()).toBe(
			"0x19587f1dc5cae16bf09cf73c63a842ccf6f1fcb48936a868c44f709363101e8a",
		)
	})

	it("ties every key to the deployment, and users' Aztec keys also to the users' tag", () => {
		const other = MANIFEST.l2.token.address
		expect(aztecSecret(BRIDGE, "galactica", KEYS).equals(aztecSecret(other, "galactica", KEYS))).toBe(false)
		expect(ethereumKey(BRIDGE, "alice")).not.toBe(ethereumKey(other, "alice"))
		expect(aztecSecret(BRIDGE, "alice", KEYS).equals(aztecSecret(BRIDGE, "alice", { ...KEYS, usersTag: newUsersTag() }))).toBe(false)
		expect(() => aztecSecret(BRIDGE, "bob", { merchantsSalt: KEYS.merchantsSalt })).toThrow("users' tag")
		expect(castMember(MANIFEST, "alice", KEYS)).toEqual(castMember(MANIFEST, "alice", KEYS))
	})

	it("moves a merchant's key with the merchants' salt, never with the users' tag, and refuses a malformed salt", () => {
		const galactica = (keys: CastKeys) => aztecSecret(BRIDGE, "galactica", keys)
		expect(galactica(KEYS).equals(galactica({ ...KEYS, merchantsSalt: newMerchantsSalt() }))).toBe(false)
		expect(galactica(KEYS).equals(galactica({ merchantsSalt: KEYS.merchantsSalt }))).toBe(true)
		expect(() => galactica({ merchantsSalt: KEYS.merchantsSalt.toUpperCase() })).toThrow("merchants' salt")
		expect(() => galactica({ merchantsSalt: "" })).toThrow("merchants' salt")
	})

	it("keeps every Ethereum key a valid secp256k1 scalar and every Aztec secret in the field", () => {
		const k = BigInt(ethereumKey(BRIDGE, "bob"))
		expect(k > 0n && k < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n).toBe(true)
		expect(aztecSecret(BRIDGE, "supplier", KEYS).toBigInt() < Fr.MODULUS).toBe(true)
		expect(newUsersTag()).toMatch(/^[0-9a-f]{32}$/)
		expect(newMerchantsSalt()).toMatch(MERCHANTS_SALT)
	})
})
