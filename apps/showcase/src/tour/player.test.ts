import { BRIDGE_REFUSALS, TOKEN_REFUSALS } from "@galactica-net/inference-money-core"
import { SMOKE_AMOUNTS as A } from "@galactica-net/inference-money-demo"
import { describe, expect, it } from "vitest"
import { TOUR } from "@/config/network"
import { addMoves, playTour } from "./player"

describe("playTour", () => {
	const played = playTour(TOUR)

	it("tells the seven scenes in order, each refusal in the contracts' own words", () => {
		expect(played.map((p) => [p.scene.id, p.verdict, p.refusal])).toEqual([
			["deposit", "settled", undefined],
			["claim", "settled", undefined],
			["pay", "settled", undefined],
			["refund", "settled", undefined],
			["pay-a-friend", "refused", TOKEN_REFUSALS.transfer],
			["cash-out", "refused", BRIDGE_REFUSALS.exitDestination],
			["withdraw", "settled", undefined],
		])
	})

	it("moves the balances as the acceptance run does, and a refusal moves nothing and publishes nothing", () => {
		const net = played.map((p) => p.moves).reduce(addMoves, {})
		expect(net).toEqual({
			A_demo: A.exit - A.deposit,
			portal: A.deposit - A.exit,
			alice: A.refund - A.exit,
			galactica: A.deposit - A.refund,
		})
		for (const p of played.filter((s) => s.verdict === "refused")) {
			expect(p.moves).toEqual({})
			const nothing = { chain: "none", text: expect.stringMatching(/nothing reached a chain/), items: [] }
			expect(p.rows).toEqual([{ key: p.scene.steps[0], source: "recorded", ...nothing }])
		}
		expect(played.find((p) => p.scene.id === "withdraw")?.rows.map((r) => r.chain)).toEqual(["aztec", "ethereum"])
	})

	it("labels every row recorded, and links each recorded tx where the network has an explorer", () => {
		const step = (id: string) => TOUR.steps.find((s) => s.id === id)
		const rows = playTour(TOUR, { l1Tx: "https://l1/tx/", l2Tx: "https://l2/tx/" }).flatMap((p) => p.rows)
		expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["recorded"]))
		expect(Object.fromEntries(rows.map((r) => [r.key, r.href]))).toMatchObject({
			deposit: `https://l1/tx/${step("deposit")?.l1?.txHash}`,
			claim: `https://l2/tx/${step("claim")?.l2?.txHash}`,
			"transfer-refused": undefined,
		})
		expect(played.flatMap((p) => p.rows).every((r) => r.href === undefined)).toBe(true)
	})
})
