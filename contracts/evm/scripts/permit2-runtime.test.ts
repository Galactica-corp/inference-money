import { describe, expect, it } from "bun:test"
import { GENERATED, render, VENDORED, type Vendored } from "./permit2-runtime"

describe("Permit2Runtime.sol", () => {
	it("is the vendored runtime, byte for byte", async () => {
		const vendored = (await Bun.file(VENDORED).json()) as Vendored
		expect(await Bun.file(GENERATED).text()).toBe(render(vendored))
	})

	it("refuses a malformed vendored file", () => {
		expect(() => render({ keccak: "0x00", code: "0x00" })).toThrow("keccak")
	})
})
