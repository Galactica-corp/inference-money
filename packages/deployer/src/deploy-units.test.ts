import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { MANIFEST } from "../../bridge-core/src/test/fixtures"
import { forgeEnv, maskImmutables } from "./evm"
import { readManifest, writeManifest } from "./manifest"

describe("deploy units", () => {
	it("masks exactly the immutable ranges, so any other byte difference still fails the bytecode match", () => {
		const ranges = [{ start: 1, length: 2 }]
		expect(maskImmutables("0xaabbccdd", ranges)).toBe("0xaa0000dd")
		expect(maskImmutables("0xaa1122dd", ranges)).toBe(maskImmutables("0xaabbccdd", ranges))
		expect(maskImmutables("0xaabbccde", ranges)).not.toBe(maskImmutables("0xaabbccdd", ranges))
	})

	it("builds under the default profile whatever Foundry overrides the caller's environment carries", () => {
		const env = forgeEnv({ FOUNDRY_PROFILE: "fuzz", FOUNDRY_OPTIMIZER_RUNS: "1", DAPP_SRC: "x", PATH: "/bin" })
		expect(env).toEqual({ FOUNDRY_PROFILE: "default", PATH: "/bin" })
	})

	it("writes only a valid manifest, and reads it back unchanged", () => {
		const dir = mkdtempSync(join(homedir(), ".cache", "inference-money-manifest-test-"))
		try {
			const path = join(dir, "local", "r", "manifest.json")
			expect(() => writeManifest(path, { ...MANIFEST, l1: { ...MANIFEST.l1, chainId: 0 } })).toThrow("failed validation")
			expect(existsSync(path)).toBe(false)
			writeManifest(path, MANIFEST)
			expect(readManifest(path)).toEqual(MANIFEST)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
