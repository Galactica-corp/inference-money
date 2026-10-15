import { describe, expect, it } from "bun:test"

/** Imports `specifiers` in a fresh `bun`, with SEED set or not. */
function load(specifiers: string[], seed?: string) {
	const script = specifiers.map((s) => `await import(${JSON.stringify(s)})`).join("\n")
	const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...(seed && { SEED: seed }) }
	return Bun.spawnSync([process.execPath, "-e", script], { cwd: import.meta.dir, env })
}

const LEAVES = ["@inference-money/bridge-core/manifest", "@inference-money/bridge-core/rules", "@inference-money/bridge-core/types"]

describe("bridge-core under SEED", () => {
	it("refuses to load its main entry, naming SEED; its leaf subpaths load, and so does the entry without SEED", () => {
		const seeded = load(["@inference-money/bridge-core"], "1")
		expect(seeded.exitCode).not.toBe(0)
		expect(String(seeded.stderr)).toContain("SEED is set")
		const leaves = load(LEAVES, "1")
		expect(leaves.exitCode, String(leaves.stderr)).toBe(0)
		const plain = load(["@inference-money/bridge-core"])
		expect(plain.exitCode, String(plain.stderr)).toBe(0)
	}, 30_000)
})
