import { afterEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DepositDraft, decodeDepositDraft } from "@inference-money/bridge-core"
import { keepAbandonedDraft, StateDir, withStateDir } from "./run-state"

/** Above every platform's pid range, so never alive. */
const DEAD = 999_999_999

const roots: string[] = []
const root = () => {
	const r = mkdtempSync(join(tmpdir(), "run-state-"))
	roots.push(r)
	return r
}
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe("StateDir", () => {
	it("lets one live process hold a deployment's state, leaves other deployments' state free, and writes owner-only", async () => {
		const r = root()
		const held = StateDir.acquire("smoke", "0xb", r)
		expect(() => StateDir.acquire("smoke", "0xb", r)).toThrow(`in use by process ${process.pid}`)
		expect(() => StateDir.acquire("smoke", "0xother", r).release()).not.toThrow()
		held.release()

		await withStateDir(
			"smoke",
			"0xb",
			async (s) => {
				s.write("state.json", { step: "claimed" })
				expect(s.read<{ step: string }>("state.json")).toEqual({ step: "claimed" })
				expect(statSync(join(s.dir, "state.json")).mode & 0o777).toBe(0o600)
				const store = s.paymentStore()
				await store.put("k", { state: "paid", txHash: "0x1" })
				expect(await store.get("k")).toEqual({ state: "paid", txHash: "0x1" })
			},
			r,
		)
		expect(() => StateDir.acquire("smoke", "0xb", r).release()).not.toThrow()
	})

	it("renames a state file in place, and keeps an abandoned draft under its permit nonce, once however often kept", () => {
		const s = StateDir.acquire("demo", "0xb", root())
		s.write("setup.json", { tag: "t" })
		s.rename("setup.json", "setup-t.json")
		expect([s.read("setup.json"), s.read("setup-t.json")]).toEqual([undefined, { tag: "t" }])
		const d = { intent: { amount: 1n }, typedData: { message: { nonce: 0xabcn } } } as unknown as DepositDraft
		keepAbandonedDraft(s, d)
		keepAbandonedDraft(s, d)
		expect(readdirSync(s.dir).filter((f) => f.startsWith("abandoned-"))).toEqual(["abandoned-abc.json"])
		expect(decodeDepositDraft(s.read<{ draft: string }>("abandoned-abc.json")?.draft ?? "")).toEqual(d)
		s.release()
	})

	it("refuses a lock its holder left behind, naming it for removal, and never removes another holder's lock", () => {
		const r = root()
		const s = StateDir.acquire("smoke", "0xb", r)
		const lock = join(s.dir, "lock")
		writeFileSync(lock, String(DEAD))
		expect(() => StateDir.acquire("smoke", "0xb", r)).toThrow(`${lock} was left by process ${DEAD}, which has exited`)
		s.release()
		expect(existsSync(lock)).toBe(true)

		rmSync(lock)
		expect(() => StateDir.acquire("smoke", "0xb", r).release()).not.toThrow()
	})

	it("releases the lock when its holder is stopped by a signal", async () => {
		const r = root()
		const script = `import { withStateDir } from ${JSON.stringify(join(import.meta.dir, "run-state.ts"))}
await withStateDir("smoke", "0xb", () => { console.log("held"); return new Promise(() => {}) }, ${JSON.stringify(r)})`
		const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] })
		await new Promise<void>((held) => child.stdout.once("data", () => held()))
		expect(existsSync(join(r, "smoke", "0xb", "lock"))).toBe(true)

		child.kill("SIGTERM")
		expect(await new Promise<number | null>((exited) => child.once("exit", (code) => exited(code)))).toBe(143)
		expect(existsSync(join(r, "smoke", "0xb", "lock"))).toBe(false)
	})
})
