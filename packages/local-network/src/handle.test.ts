import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { handlePath, type NetHandle, readHandle, resolveEndpoints, runIdFor, writeHandle } from "./handle"

describe("run identity and endpoints", () => {
	it("namespaces RUN_ID by checkout and refuses unsafe tags", () => {
		expect(runIdFor({ RUN_ID: "a" }, "/x")).toMatch(/^[0-9a-f]{8}-a$/)
		expect(runIdFor({ RUN_ID: "a" }, "/x")).not.toBe(runIdFor({ RUN_ID: "a" }, "/y"))
		expect(runIdFor({}, "/x")).toMatch(/-default$/)
		expect(() => runIdFor({ RUN_ID: "../etc" }, "/x")).toThrow("must match")
	})

	it("attaches only with both URLs, else uses this run's handle, written owner-only and strict", () => {
		const root = mkdtempSync(join(homedir(), ".cache", "inference-money-handle-test-"))
		try {
			expect(resolveEndpoints("r", { NET_L1_RPC: "http://l1", NET_NODE_URL: "http://n" }, root)).toEqual({
				anvilUrl: "http://l1",
				nodeUrl: "http://n",
				attached: true,
			})
			expect(() => resolveEndpoints("r", { NET_L1_RPC: "http://l1" }, root)).toThrow("together")
			expect(() => resolveEndpoints("r", {}, root)).toThrow("net:up first")

			const h: NetHandle = {
				runId: "r",
				anvilUrl: "http://127.0.0.1:10001",
				nodeUrl: "http://127.0.0.1:10002",
				l1ChainId: 31337,
				ports: { anvil: 10001, aztec: 10002, aztecAdmin: 10003, aztecP2p: 10004 },
				dataDir: "/d",
				processes: [{ name: "anvil", pgid: 42, started: "Mon Jan  1 00:00:00 2026", marker: "anvil-m" }],
				ready: false,
				worktree: "/w",
				nodeVersion: "5.0.0",
				createdAt: "2026-09-26T00:00:00.000Z",
			}
			writeHandle(h, root)
			expect(statSync(handlePath("r", root)).mode & 0o777).toBe(0o600)
			expect(readHandle("r", root)).toEqual(h)
			expect(() => resolveEndpoints("r", {}, root)).toThrow("still booting")
			writeHandle({ ...h, ready: true }, root)
			expect(resolveEndpoints("r", {}, root)).toEqual({ anvilUrl: h.anvilUrl, nodeUrl: h.nodeUrl, attached: false })
			expect(() => writeHandle({ ...h, extra: 1 } as NetHandle, root)).toThrow()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
