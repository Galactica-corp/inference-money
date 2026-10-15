import { describe, expect, it } from "bun:test"
import { withBlockHeartbeat } from "./local-network"

describe("withBlockHeartbeat", () => {
	it("forces blocks while the operation runs and stops with it, even when a beat fails", async () => {
		let beats = 0
		const force = async () => {
			if (++beats === 2) throw new Error("tx rejected")
		}
		const result = await withBlockHeartbeat(force, () => new Promise((r) => setTimeout(() => r("done"), 55)), 10)
		expect(result).toBe("done")
		const after = beats
		expect(after).toBeGreaterThanOrEqual(3)
		await new Promise((r) => setTimeout(r, 40))
		expect(beats).toBe(after)
	})
})
