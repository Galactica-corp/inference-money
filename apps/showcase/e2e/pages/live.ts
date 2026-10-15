/** Driving "Try it yourself" the way a visitor does: the composer, the Try it button, and what the page then shows. */
import { expect, type Page } from "@playwright/test"
import { TESTIDS } from "../../src/lib/testids"

/** One USDC in base units. */
export const USDC = 1_000_000n
/** The first open syncs every demo account into a fresh store; a long-lived testnet deployment takes longer. */
export const WALLET_READY_MS = 10 * 60_000
/** A claim waits for its message, a payout for its epoch's proof. */
const RUN_MS = 10 * 60_000

export interface Step {
	actor: string
	action: string
	to: string
	/** As typed; left alone for actions that take none. */
	amount?: string
}

export interface Run {
	kind: string
	detail: string
	ms: number
}

export interface FeedEntry {
	/** A live row's tx hash (an Ethereum deposit's message hash), a recorded row's step id. */
	step: string
	chain: string
	source: string
	/** The tx on a public explorer, where the network has one. */
	href?: string
}

const byField = (page: Page, name: string) => page.locator(`[data-testid="${TESTIDS.field}"][data-field="${name}"]`)
const balance = (page: Page, holder: string) => page.locator(`[data-testid="${TESTIDS.balance}"][data-holder="${holder}"]`)

/**
 * Counts the runs that ended on `window.__runsEnded`: Try it is disabled exactly while a run is in flight, a reset's
 * included, and a refusal can end before a poll would see it disabled. With deposits closed it is disabled for a deposit
 * draft too, so count only once a non-deposit draft is picked, and pick no deposit after.
 */
export async function countRuns(page: Page): Promise<void> {
	await page.evaluate((id) => {
		const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
		if (!button) throw new Error("live mode shows no Try it button")
		const w = window as unknown as { __runsEnded: number }
		w.__runsEnded = 0
		let busy = button.disabled
		new MutationObserver(() => {
			if (button.disabled) busy = true
			else if (busy) {
				busy = false
				w.__runsEnded++
			}
		}).observe(button, { attributes: true, attributeFilter: ["disabled"] })
	}, TESTIDS.tryIt)
}

/** Live mode with the page's wallet open, after checking the page is cross-origin isolated (bb.js needs it). */
export async function openLive(page: Page, opts: { reload?: boolean; readyMs?: number } = {}): Promise<void> {
	if (opts.reload) await page.reload()
	else await page.goto("/#live")
	expect(await page.evaluate(() => crossOriginIsolated), "the page is cross-origin isolated").toBe(true)
	const timeout = opts.readyMs ?? WALLET_READY_MS
	await expect(page.getByTestId(TESTIDS.walletStatus)).toHaveAttribute("data-status", "ready", { timeout })
	await expect(page.getByTestId(TESTIDS.tryIt)).toBeEnabled()
	await countRuns(page)
}

export async function compose(page: Page, s: Step): Promise<void> {
	await byField(page, "ACT AS").locator("select").selectOption(s.actor)
	await byField(page, "ACTION").locator("select").selectOption(s.action)
	await byField(page, "TO").locator("select").selectOption(s.to)
	if (s.amount !== undefined) await byField(page, "USDC").locator("input").fill(s.amount)
}

export const pickScene = (page: Page, scene: string) => page.locator(`[data-testid="${TESTIDS.chip}"][data-scene="${scene}"]`).click()

/** Runs `start` (a press of Try it by default) and waits for that run to end; what the verdict then says. */
export async function tryIt(page: Page, start = () => page.getByTestId(TESTIDS.tryIt).click()): Promise<Run> {
	const ended = await page.evaluate(() => (window as unknown as { __runsEnded: number }).__runsEnded)
	const t0 = Date.now()
	await start()
	await page.waitForFunction((n) => (window as unknown as { __runsEnded: number }).__runsEnded > n, ended, { timeout: RUN_MS })
	const verdict = page.getByTestId(TESTIDS.verdict)
	return { kind: (await verdict.getAttribute("data-kind")) ?? "", detail: (await verdict.textContent()) ?? "", ms: Date.now() - t0 }
}

export const resetBalances = (page: Page) => tryIt(page, () => page.getByRole("button", { name: "Reset balances" }).click())

/** Base units from the stage's two-decimal figure; waits until the page has read it. */
export async function shownBalance(page: Page, holder: string): Promise<bigint> {
	const el = balance(page, holder)
	await expect(el).toHaveText(/^\d[\d,]*\.\d\d$/)
	const [whole = "0", cents = "0"] = ((await el.textContent()) ?? "").replaceAll(",", "").split(".")
	return BigInt(whole) * USDC + BigInt(cents) * (USDC / 100n)
}

/** Waits for the stage to show `holder` holding `expected`: balances refresh after a run ends, not with it. */
export const expectBalance = (page: Page, holder: string, expected: bigint) =>
	expect.poll(() => shownBalance(page, holder), { message: `${holder}'s balance`, timeout: 60_000 }).toBe(expected)

/** The feed, newest first. */
export function feed(page: Page): Promise<FeedEntry[]> {
	return page.getByTestId(TESTIDS.feedRow).evaluateAll(
		(rows, sourceId) =>
			rows.map((r) => ({
				step: (r as HTMLElement).dataset.step ?? "",
				chain: (r as HTMLElement).dataset.chain ?? "",
				source: r.querySelector(`[data-testid="${sourceId}"]`)?.textContent ?? "",
				href: r.querySelector("a")?.getAttribute("href") ?? undefined,
			})),
		TESTIDS.feedSource,
	)
}

/** The rows a run added: the feed's rows now that `before` did not hold. */
export async function newRows(page: Page, before: readonly FeedEntry[]): Promise<FeedEntry[]> {
	const seen = new Set(before.map((r) => r.step))
	return (await feed(page)).filter((r) => !seen.has(r.step))
}
