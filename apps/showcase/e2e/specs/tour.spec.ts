import { readFileSync } from "node:fs"
import { BRIDGE_REFUSALS, TOKEN_REFUSALS } from "@galactica-net/inference-money-core/rules"
import { TESTIDS } from "../../src/lib/testids"
import { L1_SENDS, L2_SEND } from "../fixtures/rpc"
import { expect, test } from "../fixtures/test"
import { feed, pickScene } from "../pages/live"

/** Each scene and what the recording says it shows: a refused scene quotes its rule. */
const SCENES: [string, string | undefined][] = [
	["deposit", undefined],
	["claim", undefined],
	["pay", undefined],
	["refund", undefined],
	["pay-a-friend", TOKEN_REFUSALS.transfer],
	["cash-out", BRIDGE_REFUSALS.exitDestination],
	["withdraw", undefined],
]

/** The recording a local build plays. */
const RECORDED = JSON.parse(readFileSync(new URL("../fixtures/tour.json", import.meta.url), "utf8")) as { steps: { id: string }[] }

test("the page opens on Try it yourself; its recorded run plays by itself, shows every scene's recorded outcome, and sends nothing", async ({
	page,
	me,
}) => {
	await page.goto("/")
	expect(await page.evaluate(() => crossOriginIsolated), "the page is cross-origin isolated").toBe(true)
	await expect(page.getByTestId(TESTIDS.network)).toHaveText("Local network · proofs off")
	await expect(page.getByTestId(TESTIDS.tryIt)).toBeVisible()
	await page.locator(`[data-testid="${TESTIDS.mode}"][data-mode="tour"]`).click()
	await expect(page).toHaveURL(/#recorded$/)
	// The replay starts without Play: the first scene lands and its row reaches the feed.
	await expect(page.getByTestId(TESTIDS.feedRow).first()).toHaveAttribute("data-step", "deposit", { timeout: 30_000 })

	await page.getByRole("button", { name: "Pause" }).click()
	for (const [scene, rule] of SCENES) {
		await pickScene(page, scene)
		await expect(page.getByTestId(TESTIDS.verdict)).toHaveAttribute("data-kind", rule ? "refused" : "settled")
		if (rule) await expect(page.getByTestId(TESTIDS.verdictRule)).toHaveText(rule)
	}
	const rows = await feed(page)
	expect(rows.map((r) => r.step)).toEqual(RECORDED.steps.map((s) => s.id).reverse())
	expect(
		rows.filter((r) => r.source !== "RECORDED"),
		"every row says it was recorded",
	).toEqual([])
	// A local network has no explorer, so a row links nowhere.
	await expect(page.getByRole("link", { name: "TX ↗" })).toHaveCount(0)

	await page.locator(`[data-testid="${TESTIDS.mode}"][data-mode="live"]`).click()
	await expect(page).toHaveURL(/#live$/)
	await expect(page.getByTestId(TESTIDS.tryIt)).toBeVisible()
	const sends: string[] = [L2_SEND, ...L1_SENDS]
	expect(
		me.rpc.calls.filter((m) => sends.includes(m)),
		"the tour sends nothing",
	).toEqual([])
})
