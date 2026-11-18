import { describe, expect, it } from "bun:test"
import { type DelayReadBack, merchantDelayVerdict } from "./admin"

const M = "0x0000000000000000000000000000000000000000000000000000000000000a01"

describe("merchants delay's verdict from the chain", () => {
	it.each<[string, DelayReadBack, boolean, 0 | 1]>([
		["the setting and every merchant synced", { setting: 7200n, unsynced: [] }, true, 0],
		["a send that threw after it landed", { setting: 7200n, unsynced: [], sendError: "socket hang up" }, true, 1],
		["a first tx that never landed", { setting: 86_400n, unsynced: [M], sendError: "reverted" }, false, 1],
		["a merchant the syncs missed", { setting: 7200n, unsynced: [M] }, true, 1],
		["a read-back that still shows the old setting", { setting: 86_400n, unsynced: [] }, false, 1],
	])("%s", (_, readBack, record, exit) => {
		const v = merchantDelayVerdict(7200n, readBack)
		expect([v.record, v.exit]).toEqual([record, exit])
		if (readBack.unsynced.length > 0) expect(v.lines.join("\n")).toContain(M)
		if (!record) expect(v.lines.join("\n")).toContain("86400s, not the requested 7200s")
	})
})
