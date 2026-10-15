import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { describeError, redact, runRedacted } from "./redact"
import { secretNeedles } from "./secrets"

const KEY = `0x${"0b".repeat(32)}` as const
const RPC = "https://eth-sepolia.example.com/v2/Abc123DefGhi456Jkl"

const sink = () => {
	let text = ""
	const stream = new Writable({
		write(chunk, _enc, done) {
			text += String(chunk)
			done()
		},
	})
	return { stream, text: () => text }
}

const roots: string[] = []
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function storeChild(tail: string): { root: string; script: string } {
	const root = mkdtempSync(join(tmpdir(), "redact-test-"))
	roots.push(root)
	const dir = `require("node:path").join(${JSON.stringify(root)}, String(process.pid))`
	const script = `const fs = require("node:fs"); const d = ${dir}; fs.mkdirSync(d); fs.writeFileSync(d + "/store.mdb", "sk"); console.log("stored"); ${tail}`
	return { root, script }
}

describe("output redaction", () => {
	it("masks each secret form in any case, and a URL's API key on its own", () => {
		const needles = secretNeedles({ TESTNET_L1_PRIVATE_KEY: KEY, SEPOLIA_RPC_URL: RPC })
		const out = redact(`k=${KEY.toUpperCase()} bare=${KEY.slice(2)} url=${RPC} key=abc123defghi456jkl`, needles)
		expect(out).toBe("k=[redacted] bare=[redacted] url=[redacted] key=[redacted]")
	})

	it("masks a basic-auth URL as a library prints it with the userinfo stripped, and a short path key", () => {
		const url = "https://alice:hunter22@rpc.example.com/v2/short-key"
		const needles = secretNeedles({ SEPOLIA_RPC_URL: url })
		expect(redact("URL: https://rpc.example.com/v2/short-key", needles)).toBe("URL: [redacted]")
		expect(redact("path /v2/short-key; auth alice:hunter22", needles)).toBe("path [redacted]; auth [redacted]")
	})

	it("redacts a child's output even when a secret straddles two writes, and keeps its exit code", async () => {
		const [out, err] = [sink(), sink()]
		const script = `process.stdout.write("a=${KEY.slice(0, 30)}"); setTimeout(() => { process.stdout.write("${KEY.slice(30)}\\n"); console.error("${RPC}"); process.exit(3) }, 50)`
		const needles = secretNeedles({ TESTNET_L1_PRIVATE_KEY: KEY, SEPOLIA_RPC_URL: RPC })
		const code = await runRedacted(["-e", script], needles, out.stream, err.stream)
		expect([code, out.text(), err.text()]).toEqual([3, "a=[redacted]\n", "[redacted]\n"])
	})

	it("reaps a descendant the child leaves behind instead of waiting on the pipes it holds", async () => {
		const [out, err] = [sink(), sink()]
		const script = `const g = require("node:child_process").spawn("sleep", ["30"], { stdio: "inherit" }); console.log(g.pid); process.exit(0)`
		const started = Date.now()
		expect(await runRedacted(["-e", script], [], out.stream, err.stream)).toBe(0)
		expect(Date.now() - started).toBeLessThan(5_000)
		const grandchild = Number(out.text().trim())
		await new Promise((r) => setTimeout(r, 200))
		expect(() => process.kill(grandchild, 0)).toThrow()
	})

	it("kills a descendant that ignores SIGTERM and holds no pipe, before returning", async () => {
		const [out, err] = [sink(), sink()]
		const script = `const g = require("node:child_process").spawn("sh", ["-c", "trap '' TERM; exec sleep 31"], { stdio: "ignore" }); console.log(g.pid); setTimeout(() => process.exit(0), 100)`
		expect(await runRedacted(["-e", script], [], out.stream, err.stream)).toBe(0)
		const survivor = Number(out.text().trim())
		await new Promise((r) => setTimeout(r, 200))
		expect(() => process.kill(survivor, 0)).toThrow()
	}, 15_000)

	it("removes the wallet store of a child a signal killed mid-run", async () => {
		const { root, script } = storeChild("setInterval(() => {}, 1000)")
		const out = sink()
		const run = runRedacted(["-e", script], [], out.stream, sink().stream, process.env, root)
		while (!out.text().includes("stored")) await new Promise((r) => setTimeout(r, 20))
		// The operator's Ctrl-C reaches only the parent, whose handler SIGTERMs the child's group.
		process.emit("SIGINT", "SIGINT")
		expect(await run).toBe(1)
		expect(readdirSync(root)).toEqual([])
	})

	it("removes the wallet store of a child that exits with an error", async () => {
		const { root, script } = storeChild("process.exit(1)")
		const out = sink()
		expect(await runRedacted(["-e", script], [], out.stream, sink().stream, process.env, root)).toBe(1)
		expect([out.text(), readdirSync(root)]).toEqual(["stored\n", []])
	})

	it("describes an error through its causes", () => {
		const e = new Error("outer", { cause: new TypeError("inner") })
		expect(describeError(e)).toBe("Error: outer\n  caused by: TypeError: inner")
	})
})
