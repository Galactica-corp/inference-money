import type { BrowserContext, Route } from "@playwright/test"
import { encodeAbiParameters, toFunctionSelector } from "viem"
import { TESTIDS } from "../../src/lib/testids"
import { demoWallet, depositsBy, usdcOf } from "../fixtures/chain"
import { L1_SENDS, L2_SEND } from "../fixtures/rpc"
import { expect, test } from "../fixtures/test"
import { compose, countRuns, expectBalance, openLive, shownBalance, tryIt, USDC, WALLET_READY_MS } from "../pages/live"

test.describe.configure({ timeout: 30 * 60_000 })

const CANONICAL_ROLLUP = toFunctionSelector("getCanonicalRollup()")
const NEW_ROLLUP = encodeAbiParameters([{ type: "address" }], ["0x000000000000000000000000000000000000dEaD"])

type Call = { id?: unknown; method?: unknown; params?: unknown }
const readsCanonical = (c: Call) =>
	c.method === "eth_call" && Array.isArray(c.params) && String(c.params[0]?.data ?? "").startsWith(CANONICAL_ROLLUP)

/**
 * From `switch()` on, anvil answers the registry's `getCanonicalRollup` with another rollup, as after an Aztec upgrade;
 * every other call reaches the chain unchanged. Registered after the suite's routes, so it sees each request first.
 */
async function moveRegistry(context: BrowserContext, anvilUrl: string) {
	const origin = new URL(anvilUrl).origin
	let moved = false
	await context.route(
		(url) => url.origin === origin,
		async (route: Route) => {
			const body = route.request().postData()
			const parsed = moved && body ? (JSON.parse(body) as Call | Call[]) : undefined
			const calls = parsed === undefined ? [] : Array.isArray(parsed) ? parsed : [parsed]
			const ids = new Set(calls.filter(readsCanonical).map((c) => c.id))
			if (ids.size === 0) return route.fallback()
			const response = await route.fetch()
			const patch = (r: { id?: unknown }) => (ids.has(r.id) ? { ...r, result: NEW_ROLLUP } : r)
			const json = (await response.json()) as { id?: unknown } | { id?: unknown }[]
			return route.fulfill({ response, json: Array.isArray(json) ? json.map(patch) : patch(json) })
		},
	)
	return {
		switch: () => {
			moved = true
		},
	}
}

const DEPOSIT = { actor: "alice", action: "deposit", to: "alice", amount: "0.10" }
const SEND = { actor: "alice", action: "send", to: "galactica", amount: "0.01" }

test("after a rollup switch the page refuses only deposits, with a notice, and a live send still settles", async ({
	page,
	me,
	run,
	manifest,
}) => {
	const registry = await moveRegistry(me.context, run.anvilUrl)
	const aDemo = demoWallet(manifest, "alice").address
	await openLive(page)
	const notice = page.getByTestId(TESTIDS.depositsClosed)
	const button = page.getByTestId(TESTIDS.tryIt)
	let refusal = ""

	await test.step("a page opened before the switch refuses a deposit before anything leaves for Ethereum", async () => {
		await expect(notice).toHaveCount(0)
		registry.switch()
		const [held, deposits, mark] = [
			await usdcOf(run.anvilUrl, manifest, aDemo),
			await depositsBy(run.anvilUrl, manifest, aDemo),
			me.rpc.calls.length,
		]
		await compose(page, DEPOSIT)
		const outcome = await tryIt(page)
		expect(outcome.kind).toBe("failed")
		expect(outcome.detail).toContain("Deposits are closed.")
		refusal = outcome.detail
		expect(
			L1_SENDS.map((m) => me.rpc.countSince(mark, m)),
			"no Ethereum tx left the page",
		).toEqual([0, 0])
		expect(await usdcOf(run.anvilUrl, manifest, aDemo)).toBe(held)
		expect(await depositsBy(run.anvilUrl, manifest, aDemo)).toHaveLength(deposits.length)
	})

	await test.step("after a reload the notice shows and Try it stays off for a deposit draft", async () => {
		await page.reload()
		await expect(page.getByTestId(TESTIDS.walletStatus)).toHaveAttribute("data-status", "ready", { timeout: WALLET_READY_MS })
		await expect(notice).toBeVisible()
		expect(refusal).toContain(await notice.innerText())
		await compose(page, DEPOSIT)
		await expect(button).toBeDisabled()
	})

	await test.step("a private send on Aztec still runs live and settles", async () => {
		await compose(page, SEND)
		await expect(button).toBeEnabled()
		await countRuns(page)
		const galactica = await shownBalance(page, "galactica")
		const mark = me.rpc.calls.length
		const outcome = await tryIt(page)
		expect(outcome.kind, outcome.detail).toBe("settled")
		expect(me.rpc.countSince(mark, L2_SEND), "sent to the Aztec node").toBe(1)
		await expectBalance(page, "galactica", galactica + USDC / 100n)
	})
})
