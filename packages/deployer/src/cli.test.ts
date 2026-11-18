import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BOOTSTRAP = ["./cli-args", "./redact", "./secrets"]

/** How many child processes this runtime has right after running `setup`. */
function childrenAfter(setup: string): number {
	const count = `const kids = require("node:child_process").spawnSync("pgrep", ["-P", String(process.pid)]).stdout.toString().trim()
console.log(kids ? kids.split("\\n").length : 0)
process.exit(0)`
	const r = Bun.spawnSync([process.execPath, "-e", `${setup}\n${count}`])
	if (r.exitCode !== 0) throw new Error(String(r.stderr))
	return Number(String(r.stdout).trim().split("\n").at(-1))
}

describe("the CLI's entry point", () => {
	it("spawns nothing before it holds the secrets: the SDK, whose import starts bb, loads after", () => {
		const scanned = new Bun.Transpiler({ loader: "ts" }).scanImports(readFileSync(join(import.meta.dir, "cli.ts"), "utf8"))
		const of = (kind: string) =>
			scanned
				.filter((i) => i.kind === kind)
				.map((i) => i.path)
				.sort()
		expect(of("import-statement")).toEqual(BOOTSTRAP)
		expect(of("dynamic-import")).toEqual(["./commands"])

		const imports = BOOTSTRAP.map((m) => `await import(${JSON.stringify(join(import.meta.dir, `${m}.ts`))})`).join("\n")
		expect(childrenAfter(imports)).toBe(0)
		expect(childrenAfter(`require("node:child_process").spawn("sleep", ["5"], { detached: true }).unref()`)).toBe(1)
	}, 60_000)

	const cli = (flags: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
		Bun.spawnSync([process.execPath, ...flags, join(import.meta.dir, "cli.ts"), "manifest-path", "local"], {
			cwd: opts.cwd ?? import.meta.dir,
			env: { PATH: process.env.PATH ?? "", ...opts.env },
		})

	it("refuses every command while SEED is set", () => {
		const r = cli(["--no-env-file"], { env: { SEED: "1" } })
		expect(r.exitCode).toBe(2)
		expect(String(r.stderr)).toContain("SEED is set")
		expect(String(r.stdout)).toBe("")
	})

	it("never loads a .env from the working directory: refuses to start without --no-env-file, and with it the file stays unread", () => {
		const dir = mkdtempSync(join(tmpdir(), "cli-env-"))
		try {
			writeFileSync(join(dir, ".env"), "SEED=1\n")
			const bare = cli([], { cwd: dir })
			expect(bare.exitCode).toBe(2)
			expect(String(bare.stderr)).toContain("--no-env-file")
			// With the file loaded, the SEED refusal above would exit 2.
			const flagged = cli(["--no-env-file"], { cwd: dir })
			expect(flagged.exitCode, String(flagged.stderr)).toBe(0)
			expect(String(flagged.stdout).trim()).toEndWith("manifest.json")
			// As an operator starts it: `bun run` itself reads the file, and must hand none of it to the script it runs.
			const script = `bun --no-env-file ${join(import.meta.dir, "cli.ts")}`
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { bridge: script } }))
			const viaRun = Bun.spawnSync([process.execPath, "run", "bridge", "manifest-path", "local"], {
				cwd: dir,
				env: { PATH: process.env.PATH ?? "" },
			})
			expect(viaRun.exitCode, String(viaRun.stderr)).toBe(0)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}, 60_000)
})
