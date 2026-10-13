import { describe, expect, it } from "bun:test"
import { BRIDGE_REFUSALS, bridgeRefusalOf, TOKEN_REFUSALS, tokenRefusalOf } from "./rules"

const TOKEN_SOURCE = new URL("../../../contracts/aztec/token/src/main.nr", import.meta.url).pathname
const BRIDGE_SOURCE = new URL("../../../contracts/aztec/token_bridge/src/main.nr", import.meta.url).pathname
const ENCODER_SOURCE = new URL("../../../contracts/aztec/portal_messages/src/lib.nr", import.meta.url).pathname

describe("token refusals", () => {
	it("each appears verbatim as a string literal in the token's Noir source", async () => {
		const source = await Bun.file(TOKEN_SOURCE).text()
		for (const text of Object.values(TOKEN_REFUSALS)) expect(source, text).toContain(`"${text}"`)
	})

	it("maps an error to the most specific refusal it names", () => {
		expect(tokenRefusalOf(new Error("Assertion failed: Only the merchant admin or guardian 'caller == admin'"))).toBe(
			"notAdminOrGuardian",
		)
		expect(tokenRefusalOf(new Error("Assertion failed: Only the pending merchant admin"))).toBe("notPendingAdmin")
		expect(tokenRefusalOf(new Error("Assertion failed: Only the merchant admin lowers a delay"))).toBe("notAdminLowersDelay")
		expect(tokenRefusalOf(new Error("Assertion failed: Only the merchant admin"))).toBe("notAdmin")
		expect(tokenRefusalOf(`Simulation error: ${TOKEN_REFUSALS.payment}`)).toBe("payment")
		expect(tokenRefusalOf(new Error("Balance too low"))).toBeUndefined()
	})
})

describe("bridge refusals", () => {
	it("each appears verbatim as a string literal in the bridge's Noir source, or the withdraw encoder's", async () => {
		const source = (await Bun.file(BRIDGE_SOURCE).text()) + (await Bun.file(ENCODER_SOURCE).text())
		for (const text of Object.values(BRIDGE_REFUSALS)) expect(source, text).toContain(`"${text}"`)
	})

	it("maps a simulation error to the rule it names", () => {
		expect(bridgeRefusalOf(new Error(`Assertion failed: ${BRIDGE_REFUSALS.exitDestination} 'bound'`))).toBe("exitDestination")
		expect(bridgeRefusalOf(`Simulation error: ${BRIDGE_REFUSALS.publicClaimToUser}`)).toBe("publicClaimToUser")
		expect(bridgeRefusalOf(new Error("Balance too low"))).toBeUndefined()
	})
})
