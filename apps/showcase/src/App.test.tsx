import { act, render } from "@testing-library/react"
import { StrictMode } from "react"
import { describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { openOnce } from "./demo/useOpening"
import type { DemoWallet } from "./demo/wallet"

// The views load the Aztec SDK; only whether the page opens its wallet is under test here.
vi.mock("@/live/LiveRoot", () => ({ LiveRoot: () => <p>live</p> }))
vi.mock("@/proving/ProvingPage", () => ({ ProvingPage: () => <p>proving</p> }))
vi.mock("@/tour/TourMode", () => ({ TourMode: () => <p>tour</p> }))

const goTo = (hash: string) =>
	act(async () => {
		window.location.hash = hash
		window.dispatchEvent(new HashChangeEvent("hashchange"))
	})

/** A page loaded at `hash` whose wallet start is counted and stays pending until `opened`. */
async function load(hash: string) {
	const counts = { starts: 0 }
	let opened = (_: DemoWallet) => {}
	const opening = new Promise<DemoWallet>((resolve) => {
		opened = resolve
	})
	const openDemo = openOnce(() => {
		counts.starts++
		return opening
	})
	window.location.hash = hash
	const view = render(
		<StrictMode>
			<App openDemo={openDemo} />
		</StrictMode>,
	)
	await act(async () => {})
	return { counts, opened, view }
}

describe("App", () => {
	it("opens the wallet on a page loaded at Try it yourself or #proving, never at the recording", async () => {
		for (const [hash, starts] of [
			["", 1],
			["#proving", 1],
			["#recorded", 0],
		] as const) {
			const page = await load(hash)
			expect(page.counts.starts, hash || "the bare URL").toBe(starts)
			page.view.unmount()
		}
	})

	it("opens it once per page across hash changes, from the recording on", async () => {
		const page = await load("#recorded")
		for (const hash of ["#live", "#recorded", "#proving", "#live"]) await goTo(hash)
		await act(async () => page.opened({} as DemoWallet))
		expect(page.counts.starts).toBe(1)
	})
})
