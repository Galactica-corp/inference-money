import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO_ROOT } from "@galactica-net/inference-money-local-network"

/** One item per role: `op-remote create` makes a template's item whole and refuses one that exists. */
const DEPLOY_ITEM = "op://Keyed-Runs/InferenceMoney-Testnet"
const ADMIN_ITEM = "op://Keyed-Runs/InferenceMoney-Testnet-Admin"

/** A keyed-run template as env-exec reads it: NAME=VALUE lines, `# op:` directives above secrets. */
function template(name: string): Map<string, { value: string; directive?: string }> {
	const vars = new Map<string, { value: string; directive?: string }>()
	let directive: string | undefined
	for (const line of readFileSync(join(REPO_ROOT, "deployments", name), "utf8").split("\n")) {
		if (line.startsWith("# op: ")) directive = line.slice(6)
		else if (/^[A-Z0-9_]+=/.test(line)) {
			const [key, ...value] = line.split("=")
			vars.set(key as string, { value: value.join("="), ...(directive ? { directive } : {}) })
			directive = undefined
		}
	}
	return vars
}

describe("keyed-run templates", () => {
	const deploy = template("testnet-deploy.env.example")
	const admin = template("testnet-admin.env.example")
	const fund = template("testnet-fund.env.example")

	it("refer every secret to its own field of its role's item", () => {
		for (const [t, item] of [
			[deploy, DEPLOY_ITEM],
			[fund, DEPLOY_ITEM],
			[admin, ADMIN_ITEM],
		] as const) {
			for (const [name, { value }] of t) if (value.startsWith("op://")) expect(value).toBe(`${item}/${name}`)
		}
		expect(deploy.get("TESTNET_DEPLOYER_SECRET")?.directive).toBe("generate fr")
		expect(admin.get("TESTNET_ADMIN_SECRET")?.directive).toBe("generate fr")
	})

	it("split the roles: the deploy run never sees the admin secret, the admin run never sees the L1 key", () => {
		expect([...deploy.keys()].sort()).toEqual([
			"SEPOLIA_RPC_URL",
			"TESTNET_ADMIN_ADDRESS",
			"TESTNET_DEPLOYER_SECRET",
			"TESTNET_L1_PRIVATE_KEY",
		])
		expect([...admin.keys()]).toEqual(["TESTNET_ADMIN_SECRET"])
		expect([...fund.keys()].sort()).toEqual(["SEPOLIA_RPC_URL", "TESTNET_L1_PRIVATE_KEY"])
		expect(deploy.get("TESTNET_ADMIN_ADDRESS")?.value.startsWith("op://")).toBe(false)
	})
})
