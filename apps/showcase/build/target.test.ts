// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import fixture from "../src/test/manifest.fixture.json"
import { cspFor, headersFile, resolveTarget } from "./target"

const root = mkdtempSync(join(tmpdir(), "showcase-target-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const demo = (bridge: string) => JSON.stringify({ version: 1, bridge, usersTag: "ab".repeat(16) })

const testnet = join(root, "testnet.json")
writeFileSync(testnet, JSON.stringify({ ...fixture, network: "testnet" }))
writeFileSync(join(root, "testnet-demo.json"), demo(fixture.l2.bridge.address))
writeFileSync(join(root, "testnet-tour.json"), JSON.stringify({ recorded: "testnet" }))
const local = join(root, "local", "run-1", "manifest.json")
mkdirSync(join(root, "local", "run-1"), { recursive: true })
writeFileSync(local, JSON.stringify({ ...fixture, network: "local" }))
writeFileSync(join(root, "local", "run-1", "demo.json"), demo(fixture.l2.bridge.address))
mkdirSync(join(root, "apps", "showcase", "e2e", "fixtures"), { recursive: true })
writeFileSync(join(root, "apps", "showcase", "e2e", "fixtures", "tour.json"), JSON.stringify({ recorded: "fixture" }))
/** A local manifest's L1 RPC comes from its run's network; attached endpoints stand in for one. */
const ANVIL = { NET_L1_RPC: "http://127.0.0.1:8545", NET_NODE_URL: "http://127.0.0.1:8080" }
// The fixture manifest names node 5.0.0; `current` names the toolchain's node, for which Presto pins another stdlib.
writeFileSync(join(root, "toolchain.json"), JSON.stringify({ aztecNode: "6.0.0-rc.3", aztecJs: "6.0.0-rc.3" }))
const presto = join(root, "apps", "showcase", "node_modules", "@alejoamiras", "presto")
mkdirSync(presto, { recursive: true })
const prestoPinning = (stdlib?: string) =>
	writeFileSync(join(presto, "package.json"), JSON.stringify({ dependencies: stdlib ? { "@aztec-labs/stdlib": stdlib } : {} }))
prestoPinning("6.0.0-rc.1")
const current = join(root, "local", "run-2", "manifest.json")
mkdirSync(join(root, "local", "run-2"), { recursive: true })
writeFileSync(current, JSON.stringify({ ...fixture, network: "local", l2: { ...fixture.l2, nodeVersion: "6.0.0-rc.3" } }))
writeFileSync(join(root, "local", "run-2", "demo.json"), demo(fixture.l2.bridge.address))

describe("resolveTarget", () => {
	it("pins the testnet build to the committed manifest, refuses every override and every keyed variable", () => {
		expect(() => resolveTarget({ BRIDGE_TARGET: "testnet", BRIDGE_MANIFEST: local }, root)).toThrow(/unset BRIDGE_MANIFEST/)
		expect(() => resolveTarget({ BRIDGE_TARGET: "mainnet" }, root)).toThrow(/Unknown BRIDGE_TARGET/)
		expect(() => resolveTarget({ BRIDGE_MANIFEST: testnet, SEPOLIA_RPC_URL: "https://k" }, root)).toThrow(
			/keyless: unset SEPOLIA_RPC_URL/,
		)
		expect(() => resolveTarget({ BRIDGE_MANIFEST: testnet, SHOWCASE_PROOFS: "fake" }, root)).toThrow(/proves for real/)
		expect(() => resolveTarget({ BRIDGE_MANIFEST: testnet, PRESTO_HTTPS_PORT: "40002" }, root)).toThrow(
			/finds Presto on its own ports: unset PRESTO_HTTPS_PORT/,
		)
		expect(() => resolveTarget({}, join(root, "nowhere"))).toThrow(/No bridge manifest at .*deployments\/testnet\.json/)
	})

	it("needs the deployment's own published demo, and fakes proofs on local unless asked for real ones", () => {
		writeFileSync(join(root, "testnet-demo.json"), demo(`0x${"cd".repeat(32)}`))
		expect(() => resolveTarget({ BRIDGE_MANIFEST: testnet }, root)).toThrow(/no published demo/)
		writeFileSync(join(root, "testnet-demo.json"), demo(fixture.l2.bridge.address))

		expect(resolveTarget({ BRIDGE_MANIFEST: local, ...ANVIL }, root)).toMatchObject({ proofs: "fake", l1RpcUrl: ANVIL.NET_L1_RPC })
		expect(resolveTarget({ BRIDGE_MANIFEST: local, SHOWCASE_PROOFS: "real", ...ANVIL }, root).proofs).toBe("real")
		expect(resolveTarget({ BRIDGE_MANIFEST: testnet }, root)).toMatchObject({ proofs: "real", usersTag: "ab".repeat(16) })
	})

	it("embeds the deployment's recorded tour, and the fixture tour on a local network", () => {
		expect(resolveTarget({ BRIDGE_MANIFEST: testnet }, root).tour).toEqual({ recorded: "testnet" })
		expect(resolveTarget({ BRIDGE_MANIFEST: local, ...ANVIL }, root).tour).toEqual({ recorded: "fixture" })
		rmSync(join(root, "testnet-tour.json"))
		expect(() => resolveTarget({ BRIDGE_MANIFEST: testnet }, root)).toThrow(
			/has no recorded tour at .*testnet-tour\.json: run `bun run bridge smoke/,
		)
		writeFileSync(join(root, "testnet-tour.json"), JSON.stringify({ recorded: "testnet" }))
	})
})

describe("Presto's stdlib", () => {
	it("refuses a real-proof build for the toolchain's node until Presto pins the toolchain's stdlib", () => {
		const real = { BRIDGE_MANIFEST: current, SHOWCASE_PROOFS: "real", ...ANVIL }
		expect(() => resolveTarget(real, root)).toThrow(/pins @aztec-labs\/stdlib 6\.0\.0-rc\.1, not the toolchain's 6\.0\.0-rc\.3/)
		for (const malformed of [undefined, "", "^6.0.0-rc.3"]) {
			prestoPinning(malformed)
			expect(() => resolveTarget(real, root)).toThrow(/an exact @aztec-labs\/stdlib/)
		}
		prestoPinning("6.0.0-rc.3")
		expect(resolveTarget(real, root).proofs).toBe("real")
		prestoPinning("6.0.0-rc.1")
	})

	it("builds fake proofs, and a manifest on another node version, whatever Presto pins", () => {
		expect(resolveTarget({ BRIDGE_MANIFEST: current, ...ANVIL }, root).proofs).toBe("fake")
		expect(resolveTarget({ BRIDGE_MANIFEST: testnet }, root).proofs).toBe("real")
	})
})

describe("Presto's ports", () => {
	it("stay the app's own unless a local build moves them, to two distinct valid ports", () => {
		expect(resolveTarget({ BRIDGE_MANIFEST: testnet }, root).presto).toEqual({ port: 59833, httpsPort: 59834 })
		const moved = { BRIDGE_MANIFEST: local, ...ANVIL, PRESTO_PORT: "40001", PRESTO_HTTPS_PORT: "40002" }
		expect(resolveTarget(moved, root).presto).toEqual({ port: 40001, httpsPort: 40002 })
		for (const bad of ["", "abc", "0", "65536", "1.5", "-1"]) {
			expect(() => resolveTarget({ ...moved, PRESTO_PORT: bad }, root)).toThrow(/PRESTO_PORT is a port/)
		}
		expect(() => resolveTarget({ ...moved, PRESTO_HTTPS_PORT: "40001" }, root)).toThrow(/must differ/)
	})
})

describe("served headers", () => {
	it("isolate the page, frame nothing, and reach only the node and the L1 RPC, plus the CRS hosts and Presto when proving", () => {
		const node = new URL(fixture.l2.nodeUrl).origin
		const faked = resolveTarget({ BRIDGE_MANIFEST: local, ...ANVIL }, root)
		expect(cspFor(faked)).toContain(`connect-src 'self' data: blob: ${node} http://127.0.0.1:8545;`)
		const proving = resolveTarget(
			{ BRIDGE_MANIFEST: local, ...ANVIL, SHOWCASE_PROOFS: "real", PRESTO_PORT: "40001", PRESTO_HTTPS_PORT: "40002" },
			root,
		)
		expect(cspFor(proving)).toContain("https://crs.aztec-labs.com https://127.0.0.1:40002 http://127.0.0.1:40001;")
		expect(cspFor(faked)).toContain("frame-src 'none'")
		expect(cspFor(faked)).toContain("frame-ancestors 'none'")
		const shipped = resolveTarget({ BRIDGE_MANIFEST: testnet }, root)
		expect(cspFor(shipped)).toContain(
			`connect-src 'self' data: blob: ${node} https://ethereum-sepolia-rpc.publicnode.com https://crs.aztec-cdn.foundation https://crs.aztec-labs.com https://127.0.0.1:59834 http://127.0.0.1:59833;`,
		)
		expect(headersFile(shipped)).toMatch(
			/^\/\*\n {2}Cross-Origin-Opener-Policy: same-origin\n {2}Cross-Origin-Embedder-Policy: require-corp\n/,
		)
	})
})
