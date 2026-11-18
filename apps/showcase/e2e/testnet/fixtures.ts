/**
 * The testnet check's `test`: the committed deployment it must find served, every JSON-RPC method the page posts to
 * the testnet node and the L1 RPC, and every CSP violation the page reports, which fails the test.
 */
import { readFileSync } from "node:fs"
import { type BridgeManifest, parseManifest } from "@galactica-net/inference-money-core/manifest"
import { parseTour, type Tour } from "@galactica-net/inference-money-demo/tour"
import { TESTNET } from "@galactica-net/inference-money-deployer/networks"
import { test as base, expect } from "@playwright/test"
import { type RpcLog, recordRpc } from "../fixtures/rpc"

const repoFile = (path: string) => JSON.parse(readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8")) as unknown

interface Fixtures {
	rpc: RpcLog
	violations: string[]
}

interface WorkerFixtures {
	manifest: BridgeManifest
	tour: Tour
}

export const test = base.extend<Fixtures, WorkerFixtures>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the destructuring form even with no dependencies.
	manifest: [async ({}, use) => use(parseManifest(repoFile("deployments/testnet.json"))), { scope: "worker" }],
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the destructuring form even with no dependencies.
	tour: [async ({}, use) => use(parseTour(repoFile("deployments/testnet-tour.json"))), { scope: "worker" }],

	rpc: async ({ context, manifest }, use) => use(await recordRpc(context, [manifest.l2.nodeUrl, TESTNET.defaultL1RpcUrl])),

	// Chrome reports each violation on the console, the workers' included.
	violations: [
		async ({ page }, use) => {
			const seen: string[] = []
			page.on("console", (msg) => {
				if (/Content Security Policy/i.test(msg.text())) seen.push(msg.text())
			})
			page.on("pageerror", (err) => console.log(`[pageerror] ${err.message.slice(0, 300)}`))
			await use(seen)
			expect(seen, "no CSP violation").toEqual([])
		},
		{ auto: true },
	],
})

export { expect }
