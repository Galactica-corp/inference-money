import { describe, expect, it, mock } from "bun:test"
import type { ClaimTicket } from "@inference-money/bridge-core"
import { keepUntilFinal, type ReclaimSteps } from "./claim-finality"

describe("keepUntilFinal", () => {
	const first = { leafIndex: 7n } as ClaimTicket
	const moved = { leafIndex: 9n } as ClaimTicket
	const steps = (o: Partial<ReclaimSteps>): ReclaimSteps => ({
		finality: async () => "finalized",
		reconcile: async () => moved,
		claimAgain: async () => {},
		pause: async () => {},
		log: () => {},
		...o,
	})

	it("keeps the ticket through a prune, an unreadable L1 and a failed claim, then claims from the refreshed one", async () => {
		const finality = mock<ReclaimSteps["finality"]>().mockResolvedValueOnce("dropped").mockResolvedValue("finalized")
		const reconcile = mock<ReclaimSteps["reconcile"]>().mockResolvedValueOnce("pending").mockResolvedValue(moved)
		const claimAgain = mock<ReclaimSteps["claimAgain"]>().mockRejectedValueOnce(new Error("503")).mockResolvedValue()
		await keepUntilFinal(first, steps({ finality, reconcile, claimAgain }))
		expect(claimAgain.mock.calls.map(([t]) => t)).toEqual([moved, moved])
		expect(finality.mock.calls.map(([t]) => t)).toEqual([first, moved])
	})

	it("stops, the ticket left to its caller, only once the L1 reader calls the deposit never sent", async () => {
		const run = keepUntilFinal(first, steps({ finality: async () => "dropped", reconcile: async () => "not-deposited" }))
		await expect(run).rejects.toThrow("never reached L1")
	})
})
