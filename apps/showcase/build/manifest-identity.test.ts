// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseManifest } from "@galactica-net/inference-money-core/manifest"
import { parseTour, tourMismatches } from "@galactica-net/inference-money-demo"
import { describe, expect, it } from "vitest"
import { EMBEDDED_MANIFEST, EMBEDDED_TOUR, TESTNET_MANIFEST } from "./target"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const dist = join(appRoot, "dist")

// Runs only right after `build:testnet`, against the dist that build wrote.
describe.skipIf(process.env.BUILT_TARGET !== "testnet")("the testnet bundle", () => {
	it("embeds exactly the committed testnet manifest, and its code names that network", () => {
		const embedded = parseManifest(JSON.parse(readFileSync(join(dist, EMBEDDED_MANIFEST), "utf8")))
		const committed = parseManifest(JSON.parse(readFileSync(join(appRoot, "../..", TESTNET_MANIFEST), "utf8")))
		expect(embedded).toEqual(committed)
		expect(embedded.network).toBe("testnet")

		const assets = join(dist, "assets")
		const code = readdirSync(assets)
			.filter((f) => f.endsWith(".js"))
			.map((f) => readFileSync(join(assets, f), "utf8"))
			.join("\n")
		for (const v of [embedded.l2.nodeUrl, embedded.l1.router, embedded.l1.portal, embedded.l2.bridge.address]) {
			expect(code, v).toContain(v)
		}
	})

	it("plays this deployment's own recorded tour", () => {
		const manifest = parseManifest(JSON.parse(readFileSync(join(dist, EMBEDDED_MANIFEST), "utf8")))
		const tour = parseTour(JSON.parse(readFileSync(join(dist, EMBEDDED_TOUR), "utf8")))
		expect(tourMismatches(tour, manifest)).toEqual([])
	})
})
