import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Writable } from "node:stream"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Roles } from "@galactica-net/inference-money-core/deploy"
import type { Hex } from "viem"
import { MANIFEST } from "../../bridge-core/src/test/fixtures"
import { assertOwnerOnly, disposableDestroy, disposableExec, disposableInit } from "./disposable"

const someone = new Fr(0x5eedn)
const NOBODY = {
	owner: someone,
	pendingOwner: Fr.ZERO,
	admin: someone,
	pendingAdmin: Fr.ZERO,
	token: Fr.fromHexString(MANIFEST.l2.token.address),
}

const roots: string[] = []
const temp = () => {
	const r = mkdtempSync(join(tmpdir(), "disposable-"))
	roots.push(r)
	return r
}
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** The secret values `init` wrote: the test reads the file it made, which the agent never does with the real one. */
const secretsIn = (file: string) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => /_(PRIVATE_KEY|SECRET)=/.test(l))
		.map((l) => l.slice(l.indexOf("=") + 3).toLowerCase())

function sink() {
	let text = ""
	const stream = new Writable({
		write(chunk, _enc, done) {
			text += String(chunk)
			done()
		},
	})
	return { stream, text: () => text }
}

const CHILD = [
	"-e",
	`const s = process.env.TESTNET_ADMIN_SECRET
console.log(process.argv.some((a) => a.includes(s.slice(2))) ? "argv holds a secret" : "argv clean")
console.log("secret", s, "l1", process.env.TESTNET_L1_PRIVATE_KEY ?? "absent", "interim", process.env.BRIDGE_INTERIM_ADMIN)`,
]

describe("the disposable fallback", () => {
	it("init writes three new keys to one owner-only file, never again over it, and returns only their addresses", async () => {
		const file = join(temp(), "disposable", "testnet.env")
		const addresses = await disposableInit(file)
		expect(statSync(file).mode & 0o777).toBe(0o600)
		const secrets = secretsIn(file)
		expect(secrets).toHaveLength(3)
		const shown = JSON.stringify(addresses).toLowerCase()
		expect(secrets.filter((s) => shown.includes(s))).toEqual([])

		const before = readFileSync(file, "utf8")
		await expect(disposableInit(file)).rejects.toThrow("EEXIST")
		expect(readFileSync(file, "utf8")).toBe(before)
	})

	it("exec refuses a looser file, another owner, another checkout and a nested call; its child gets only its command's values, by env, redacted", async () => {
		const [keys, checkout] = [temp(), temp()]
		const file = join(keys, "testnet.env")
		await disposableInit(file)
		const clean = () => ({ found: false, files: 0, skipped: 0, walletDirs: [] })
		const opts = { file, root: checkout, keyedRoot: checkout, scan: clean }

		chmodSync(file, 0o640)
		await expect(disposableExec(["verify", "x"], opts)).rejects.toThrow("mode 0600")
		chmodSync(file, 0o600)
		expect(() => assertOwnerOnly(file, (process.getuid?.() ?? 0) + 1)).toThrow("another user")
		await expect(disposableExec(["verify", "x"], { ...opts, keyedRoot: keys })).rejects.toThrow("keyed worktree")
		await expect(disposableExec(["disposable", "destroy", "x"], opts)).rejects.toThrow("not another disposable")

		const accept = ["admin", "accept", "x"]
		const [out, err] = [sink(), sink()]
		const code = await disposableExec(accept, { ...opts, argv: () => CHILD, out: out.stream, err: err.stream })
		expect(code, err.text()).toBe(0)
		expect(out.text()).toContain("argv clean")
		expect(out.text()).toContain("secret [redacted] l1 absent interim 1")
		expect(secretsIn(file).filter((s) => out.text().toLowerCase().includes(s))).toEqual([])

		const leaked = () => ({ found: true, files: 1, skipped: 0, walletDirs: [] })
		expect(await disposableExec(accept, { ...opts, argv: () => CHILD, out: sink().stream, err: sink().stream, scan: leaked })).toBe(1)
	})

	it("a signal during exec reaps its child and runs the scan before the bundle is released", async () => {
		const [keys, checkout] = [temp(), temp()]
		const file = join(keys, "testnet.env")
		await disposableInit(file)
		let scanned = false
		const scan = () => {
			scanned = true
			return { found: false, files: 0, skipped: 0, walletDirs: [] }
		}
		const opts = { file, root: checkout, keyedRoot: checkout, scan, out: sink().stream, err: sink().stream }
		const pidFile = join(keys, "child.pid")
		const lingers = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
		const run = disposableExec(["verify", "x"], { ...opts, argv: () => ["-e", lingers] })
		while (!existsSync(pidFile)) await Bun.sleep(20)
		await expect(disposableExec(["verify", "x"], opts)).rejects.toThrow("in use")

		process.emit("SIGTERM", "SIGTERM")
		expect(await run).not.toBe(0)
		expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow()
		expect(scanned).toBe(true)
		expect(await disposableExec(["verify", "x"], { ...opts, argv: () => ["-e", ""] })).toBe(0)
	})

	it("binds a bundle to the deployment its deploy made: a second deploy is refused, and destroy takes only that one", async () => {
		const [keys, checkout] = [temp(), temp()]
		const file = join(keys, "testnet.env")
		const { l1 } = await disposableInit(file)
		const m = { ...MANIFEST, l1: { ...MANIFEST.l1, deployer: l1 }, l2: { ...MANIFEST.l2, admin: someone.toString() as Hex } }
		const out = join(checkout, "deployments", "testnet.json")
		const writes = `const fs = require("node:fs"); fs.mkdirSync(${JSON.stringify(dirname(out))}); fs.writeFileSync(${JSON.stringify(out)}, ${JSON.stringify(JSON.stringify(m))})`
		const clean = () => ({ found: false, files: 0, skipped: 0, walletDirs: [] })
		const opts = {
			file,
			root: checkout,
			keyedRoot: checkout,
			scan: clean,
			argv: () => ["-e", writes],
			out: sink().stream,
			err: sink().stream,
		}
		expect(await disposableExec(["deploy", "testnet"], opts)).toBe(0)
		await expect(disposableExec(["deploy", "testnet"], opts)).rejects.toThrow("one deployment per bundle")

		const roles = async () => NOBODY
		const other = {
			path: "other.json",
			m: { ...m, l2: { ...m.l2, bridge: { ...m.l2.bridge, address: `0x${"cd".repeat(32)}` as Hex } } },
		}
		await expect(disposableDestroy(other, { file, roles })).rejects.toThrow("names another")
		await disposableDestroy({ path: "testnet.json", m }, { file, roles })
		expect(existsSync(file)).toBe(false)
	})

	it("a deploy that fails, or dies, before recording its bridge blocks a second deploy and destroy until resolved", async () => {
		const [keys, checkout] = [temp(), temp()]
		const file = join(keys, "testnet.env")
		const { l1 } = await disposableInit(file)
		const m = { ...MANIFEST, l1: { ...MANIFEST.l1, deployer: l1 } }
		const opts = {
			file,
			root: checkout,
			keyedRoot: checkout,
			argv: () => ["-e", "process.exit(3)"],
			out: sink().stream,
			err: sink().stream,
		}
		expect(
			await disposableExec(["deploy", "testnet"], { ...opts, scan: () => ({ found: false, files: 0, skipped: 0, walletDirs: [] }) }),
		).toBe(3)
		await expect(disposableExec(["deploy", "testnet"], opts)).rejects.toThrow("never recorded its bridge")
		await expect(disposableDestroy({ path: "testnet.json", m }, { file, roles: async () => NOBODY })).rejects.toThrow("never recorded")
		expect(existsSync(file)).toBe(true)
	})

	it("one operation per bundle: while a destroy is in flight, another destroy and an init refuse", async () => {
		const file = join(temp(), "testnet.env")
		const { l1 } = await disposableInit(file)
		const ref = {
			path: "testnet.json",
			m: { ...MANIFEST, l1: { ...MANIFEST.l1, deployer: l1 }, l2: { ...MANIFEST.l2, admin: someone.toString() as Hex } },
		}
		writeFileSync(`${file}.deployment`, `${MANIFEST.l2.bridge.address}\n`)
		let release = () => {}
		const gate = new Promise<void>((r) => {
			release = r
		})
		const first = disposableDestroy(ref, { file, roles: () => gate.then(() => NOBODY) })
		await expect(disposableDestroy(ref, { file, roles: async () => NOBODY })).rejects.toThrow("in use")
		await expect(disposableInit(file)).rejects.toThrow("in use")
		release()
		await first
		expect(existsSync(file)).toBe(false)
		await disposableInit(file)
	})

	it("destroy removes the keys only on finalized proof that the manifest's admin, not a disposable one, holds both roles alone", async () => {
		const file = join(temp(), "testnet.env")
		const { l1, admin } = await disposableInit(file)
		const mine = { ...MANIFEST, l1: { ...MANIFEST.l1, deployer: l1 } }
		const handedOver = { path: "testnet.json", m: { ...mine, l2: { ...mine.l2, admin: someone.toString() as Hex } } }
		const roles = (r: Partial<Roles & { token: Fr }>) => async () => ({ ...NOBODY, ...r })

		await expect(disposableDestroy(handedOver, { file, roles: roles({}) })).rejects.toThrow("recorded no deployment")
		writeFileSync(`${file}.deployment`, `${MANIFEST.l2.bridge.address}\n`)
		await expect(disposableDestroy({ path: "other.json", m: MANIFEST }, { file, roles: roles({}) })).rejects.toThrow(
			"not the deployment",
		)
		await expect(disposableDestroy(handedOver, { file, roles: roles({ token: someone }) })).rejects.toThrow("configured with token")
		const before = { owner: Fr.ZERO, admin: Fr.ZERO }
		await expect(disposableDestroy(handedOver, { file, roles: roles(before) })).rejects.toThrow("does not hold both roles alone")
		await expect(disposableDestroy(handedOver, { file, roles: roles({ pendingAdmin: admin.toField() }) })).rejects.toThrow("alone")
		const interim = { path: "testnet.json", m: { ...mine, l2: { ...mine.l2, admin: admin.toString() as Hex } } }
		const held = roles({ owner: admin.toField(), admin: admin.toField() })
		await expect(disposableDestroy(interim, { file, roles: held })).rejects.toThrow("disposable")
		expect(existsSync(file)).toBe(true)

		await disposableDestroy(handedOver, { file, roles: roles({}) })
		expect(existsSync(file)).toBe(false)
	})
})
