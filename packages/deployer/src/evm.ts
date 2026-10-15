import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
	BRIDGE_EVM_SOURCES,
	type BridgeEvmArtifacts,
	type EvmArtifact,
	evmArtifactFromForge,
} from "@galactica-net/inference-money-core/deploy"
import type { Hex } from "viem"

export const EVM_ROOT = resolve(import.meta.dir, "../../../contracts/evm")

export type { BridgeEvmArtifacts, EvmArtifact }

const readArtifact = (outDir: string, key: keyof BridgeEvmArtifacts): EvmArtifact => {
	const { source, name } = BRIDGE_EVM_SOURCES[key]
	return evmArtifactFromForge(JSON.parse(readFileSync(join(outDir, source, `${name}.json`), "utf8")))
}

export const forgeRunDir = (runId: string) => join(homedir(), ".cache", "inference-money", "forge", runId)

/**
 * A deploy and every later verify compile under `foundry.toml`'s default profile: an inherited `FOUNDRY_*` or `DAPP_*`
 * override (the fuzz profile, other optimizer runs) would change the code deployed or the code compared against.
 */
export function forgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...Object.fromEntries(Object.entries(env).filter(([k]) => !/^(FOUNDRY|DAPP)_/.test(k))), FOUNDRY_PROFILE: "default" }
}

/**
 * Remapping check, then `forge build` into a per-run out and cache dir, so concurrent runs in one checkout never
 * read artifacts another run is rewriting (`--force`: every artifact recompiled, none trusted from cache). Test and
 * script sources are skipped; `test/mocks` (MockUsdc) is not `.t.sol`, so it still builds.
 */
export function buildBridgeContracts(runId: string, force: boolean, env: NodeJS.ProcessEnv): BridgeEvmArtifacts {
	const dir = forgeRunDir(runId)
	execFileSync("bun", ["--no-env-file", "scripts/check-remappings.ts"], { cwd: EVM_ROOT, stdio: "inherit", env })
	const skip = ["--skip", "test", "--skip", "script"]
	const args = ["build", "--out", join(dir, "out"), "--cache-path", join(dir, "cache"), ...skip, ...(force ? ["--force"] : [])]
	execFileSync("forge", args, { cwd: EVM_ROOT, stdio: "inherit", env: forgeEnv(env) })
	const out = join(dir, "out")
	return { portal: readArtifact(out, "portal"), router: readArtifact(out, "router"), mockUsdc: readArtifact(out, "mockUsdc") }
}

/** Runtime code with every immutable range zeroed; compares on-chain code to an artifact independent of constructor args. */
export function maskImmutables(code: Hex, ranges: EvmArtifact["immutableRanges"]): Hex {
	const bytes = Buffer.from(code.slice(2), "hex")
	for (const r of ranges) bytes.fill(0, r.start, r.start + r.length)
	return `0x${bytes.toString("hex")}`
}
