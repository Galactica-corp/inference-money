import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TESTNET } from "./networks"
import { aztecSecretFrom, containsSecret, l1PrivateKeyFrom, scrubbedEnv, secretNeedles } from "./secrets"

const KEY: `0x${string}` = `0x${"0b".repeat(32)}`
const FR: `0x${string}` = `0x${"0c".repeat(32)}`
const RPC = "https://eth-sepolia.example.com/v2/Abc123DefGhi456Jkl"

describe("keyed-run secrets", () => {
	it("reads each key from the environment and names a missing or malformed one without echoing it", () => {
		expect(l1PrivateKeyFrom({ TESTNET_L1_PRIVATE_KEY: KEY })).toBe(KEY)
		expect(aztecSecretFrom("TESTNET_ADMIN_SECRET", { TESTNET_ADMIN_SECRET: FR }).toString()).toBe(FR)
		const aboveField = `0x${"ab".repeat(32)}`
		for (const [read, name, bad] of [
			[l1PrivateKeyFrom, "TESTNET_L1_PRIVATE_KEY", "0xdeadbeefsecret"],
			[l1PrivateKeyFrom, "TESTNET_L1_PRIVATE_KEY", `0x${"00".repeat(32)}`],
			[(env: NodeJS.ProcessEnv) => aztecSecretFrom("TESTNET_DEPLOYER_SECRET", env), "TESTNET_DEPLOYER_SECRET", aboveField],
		] as const) {
			const run = () => read({ [name]: bad })
			expect(run).toThrow(new RegExp(name))
			expect(run).not.toThrow(new RegExp(bad.slice(2)))
		}
	})

	it("never falls back to a secrets file or argv: a clean environment fails by name alone", () => {
		const dir = mkdtempSync(join(tmpdir(), "secrets-"))
		writeFileSync(join(dir, ".env.testnet"), `TESTNET_L1_PRIVATE_KEY=${KEY}\n`)
		const script = `import { l1PrivateKeyFrom } from "${join(import.meta.dir, "secrets.ts")}"; l1PrivateKeyFrom()`
		const r = Bun.spawnSync([process.execPath, "-e", script, KEY], { cwd: dir, env: { PATH: process.env.PATH ?? "" } })
		const out = `${r.stdout}${r.stderr}`
		expect(r.exitCode).not.toBe(0)
		expect(out).toContain("TESTNET_L1_PRIVATE_KEY is missing")
		expect(out.toLowerCase()).not.toContain(KEY.slice(2))
	})

	it("holds every credential out of process.env: its readers still see it, a process spawned after does not", () => {
		const script = [
			`import { spawnSync } from "node:child_process"`,
			`import { aztecSecretFrom, holdSecrets } from "${join(import.meta.dir, "secrets.ts")}"`,
			"holdSecrets()",
			`const child = spawnSync(process.execPath, ["-e", "console.log(process.env.TESTNET_ADMIN_SECRET ?? 'absent')"])`,
			`console.log(aztecSecretFrom("TESTNET_ADMIN_SECRET").toString(), process.env.TESTNET_ADMIN_SECRET ?? "absent", String(child.stdout).trim())`,
		].join("\n")
		const r = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: process.env.PATH ?? "", TESTNET_ADMIN_SECRET: FR } })
		expect(String(r.stdout).trim(), String(r.stderr)).toBe(`${FR} absent absent`)
	})

	it("takes needles from every credential-named variable, in every form, and nothing else, not the public default RPC", () => {
		const needles = secretNeedles({ TESTNET_L1_PRIVATE_KEY: KEY, SEPOLIA_RPC_URL: RPC, PATH: "/usr/bin:/bin", X_TOKEN: "short" })
		expect(needles).toContain(KEY)
		expect(needles).toContain(KEY.slice(2))
		expect(needles).toContain("abc123defghi456jkl")
		expect(needles.some((n) => n.includes("/usr/bin") || n === "short")).toBe(false)
		expect(secretNeedles({ PATH: "/bin", HOME: "/home/x" })).toEqual([])
		const sepoliaPort = TESTNET.defaultL1RpcUrl.replace(/^https:\/\/([^/]+)/, "https://$1:443")
		expect(secretNeedles({ SEPOLIA_RPC_URL: sepoliaPort, AZTEC_RPC_URL: TESTNET.nodeUrl })).toEqual([])
		expect(secretNeedles({ SEPOLIA_RPC_URL: `${TESTNET.defaultL1RpcUrl}/v2/key12345` }).length).toBeGreaterThan(0)
		expect(containsSecret(`log: ${KEY.slice(2).toUpperCase()}`, needles)).toBe(true)
		expect(containsSecret(`tx 0x${"ab".repeat(31)}ff`, needles)).toBe(false)
	})

	it("drops public endpoint parts from the needles and keeps every other URL credential", () => {
		const url = "https://rpc.example/aztec-testnet/Ak_x9Yz7Qw3Er5Ty?key=abcdefghijklmnop"
		const needles = secretNeedles({ SEPOLIA_RPC_URL: url })
		expect(needles).not.toContain("aztec-testnet")
		expect(needles).toContain("/aztec-testnet/ak_x9yz7qw3er5ty?key=abcdefghijklmnop")
		expect(needles).toContain("ak_x9yz7qw3er5ty")
		expect(needles).toContain("abcdefghijklmnop")
		expect(containsSecret(`defaultL1RpcUrl: "${TESTNET.defaultL1RpcUrl}"`, needles)).toBe(false)
		expect(containsSecret(`rpc ${url}\n`, needles)).toBe(true)
	})

	it("scrubs credential-bearing variables from a child env, keeping the rest", () => {
		const env = scrubbedEnv({ PATH: "/bin", HOME: "/h", TESTNET_L1_PRIVATE_KEY: KEY, SEPOLIA_RPC_URL: "https://k", MNEMONIC: "m" })
		expect(env).toEqual({ PATH: "/bin", HOME: "/h" })
	})
})
