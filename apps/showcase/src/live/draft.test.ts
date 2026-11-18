import { BRIDGE_REFUSALS, TOKEN_REFUSALS } from "@galactica-net/inference-money-core/rules"
import { describe, expect, it } from "vitest"
import { SCENES } from "@/tour/scenes"
import { actionsFor, PRESETS, settle, targetsOf, validate } from "./draft"
import { classify, NOTHING_SENT } from "./outcome"

describe("live drafts", () => {
	it("offer deposits and claims to the users only, and name only who each action can reach", () => {
		expect(actionsFor("galactica")).toEqual(["request", "pay", "send", "withdraw"])
		expect(targetsOf("alice", "deposit")).toEqual(["alice"])
		expect(targetsOf("alice", "send")).toEqual(["bob", "galactica", "supplier"])
		expect(targetsOf("bob", "withdraw")).toEqual(["A_demo", "B_demo"])
		expect(settle({ actor: "galactica", action: "deposit", to: "alice", amount: "1" })).toMatchObject({
			action: "request",
			to: "alice",
		})
		expect(settle({ actor: "alice", action: "withdraw", to: "bob", amount: "1" }).to).toBe("A_demo")
	})

	it("validate the amount as typed, and leave it out where the action takes none", () => {
		const send = { actor: "alice", action: "send", to: "galactica", amount: "" } as const
		expect(validate(send)).toEqual({ ok: false, error: "Enter an amount." })
		expect(validate({ ...send, amount: "1.2345678" })).toEqual({ ok: false, error: "USDC has at most 6 decimal places." })
		expect(validate({ ...send, amount: "0" })).toEqual({ ok: false, error: "The amount must be more than zero." })
		expect(validate({ ...send, amount: "0.10" })).toEqual({ ok: true, draft: { ...send, amount: 100_000n } })
		const claim = { actor: "alice", action: "claim", to: "alice" } as const
		expect(validate({ ...claim, amount: "junk" })).toEqual({ ok: true, draft: claim })
		expect(validate({ actor: "galactica", action: "deposit", to: "galactica", amount: "1" }).ok).toBe(false)
	})

	it("preset every scene to a draft that validates", () => {
		for (const s of SCENES) expect(validate(PRESETS[s.id]).ok, s.id).toBe(true)
	})
})

describe("classify", () => {
	const d = { actor: "alice", action: "send", to: "bob", amount: 10_000n } as const

	it("quotes each rule verbatim and says why by role, for the token's and the bridge's refusals", () => {
		expect(classify(new Error(`Simulation error: ${TOKEN_REFUSALS.transfer}`), d)).toEqual({
			kind: "refused",
			rule: TOKEN_REFUSALS.transfer,
			detail: `Alice and Bob are both users, and a user can only pay a merchant. ${NOTHING_SENT}`,
		})
		const exit = classify(new Error(`Assertion failed: ${BRIDGE_REFUSALS.exitDestination} 'bound'`), {
			...d,
			action: "withdraw",
			to: "B_demo",
		})
		expect(exit).toMatchObject({ kind: "refused", rule: BRIDGE_REFUSALS.exitDestination })
	})

	it("fails anything that is no rule, in a sentence the visitor can act on", () => {
		expect(classify(new Error("Simulation error: Balance too low"), d)).toMatchObject({ kind: "failed", detail: /smaller amount/ })
		const refused = Object.assign(new Error("This request is already paid."), { name: "PaymentRefusedError" })
		expect(classify(refused, d)).toEqual({ kind: "failed", detail: "This request is already paid." })
	})
})
