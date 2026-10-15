import { describe, expect, it } from "bun:test"
import { type Hex, keccak256 } from "viem"
import type { L1Signer } from "./l1"
import { TESTNET } from "./networks"
import { CANONICAL_PERMIT2, installCanonicalPermit2 } from "./permit2-local"

/** An L1 whose `anvil_setCode` stores what `store` makes of the code. */
function fakeL1(store: (code: Hex) => Hex) {
	const codes = new Map<string, Hex>()
	const publicClient = {
		request: async ({ method, params }: { method: string; params: [Hex, Hex] }) => {
			if (method !== "anvil_setCode") throw new Error(`unexpected ${method}`)
			codes.set(params[0], store(params[1]))
		},
		getCode: async ({ address }: { address: Hex }) => codes.get(address),
	}
	return { l1: { publicClient } as unknown as L1Signer, codes }
}

describe("the vendored Permit2", () => {
	it("is the code its pinned keccak names, at the address testnet pins", () => {
		expect(keccak256(CANONICAL_PERMIT2.code)).toBe(CANONICAL_PERMIT2.keccak)
		expect(CANONICAL_PERMIT2.address).toBe(TESTNET.permit2)
	})

	it("installs at the canonical address and returns it", async () => {
		const { l1, codes } = fakeL1((code) => code)
		expect(await installCanonicalPermit2(l1)).toBe(CANONICAL_PERMIT2.address)
		expect(codes.get(CANONICAL_PERMIT2.address)).toBe(CANONICAL_PERMIT2.code)
	})

	it("refuses a chain that reads back other code", async () => {
		const { l1 } = fakeL1(() => "0x00")
		expect(installCanonicalPermit2(l1)).rejects.toThrow("read back does not match")
	})
})
