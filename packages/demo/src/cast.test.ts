import { describe, expect, it } from "bun:test"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { signingKeyFor } from "@inference-money/bridge-core"
import { MANIFEST } from "../../bridge-core/src/test/fixtures"
import { aztecAddressOf, aztecSecret, castMember, newUsersTag } from "./cast"
import { ethereumKey } from "./keys"

const BRIDGE = MANIFEST.l2.bridge.address
const TAG = "0123456789abcdef0123456789abcdef"

describe("demo cast", () => {
	it("derives the address the wallet registers for a secret (the local deployer's, pinned)", async () => {
		const secret = new Fr(0x1a7e0de9107e5n)
		expect((await aztecAddressOf({ secret, signingKey: signingKeyFor(secret) })).toString()).toBe(
			"0x19587f1dc5cae16bf09cf73c63a842ccf6f1fcb48936a868c44f709363101e8a",
		)
	})

	it("ties every key to the deployment, and users' Aztec keys also to the users' tag", () => {
		const other = MANIFEST.l2.token.address
		expect(aztecSecret(BRIDGE, "galactica").equals(aztecSecret(other, "galactica"))).toBe(false)
		expect(ethereumKey(BRIDGE, "alice")).not.toBe(ethereumKey(other, "alice"))
		expect(aztecSecret(BRIDGE, "alice", TAG).equals(aztecSecret(BRIDGE, "alice", newUsersTag()))).toBe(false)
		expect(() => aztecSecret(BRIDGE, "bob")).toThrow("users' tag")
		expect(castMember(MANIFEST, "alice", TAG)).toEqual(castMember(MANIFEST, "alice", TAG))
	})

	it("keeps every Ethereum key a valid secp256k1 scalar and every Aztec secret in the field", () => {
		const k = BigInt(ethereumKey(BRIDGE, "bob"))
		expect(k > 0n && k < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n).toBe(true)
		expect(aztecSecret(BRIDGE, "supplier").toBigInt() < Fr.MODULUS).toBe(true)
		expect(newUsersTag()).toMatch(/^[0-9a-f]{32}$/)
	})
})
