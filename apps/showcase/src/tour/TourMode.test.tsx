import { BRIDGE_REFUSALS, TOKEN_REFUSALS } from "@galactica-net/inference-money-core"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"
import { SCENES } from "./scenes"
import { TourMode } from "./TourMode"
import { BEATS } from "./useTour"

const PACE = { ready: 10, checking: 10, moving: 10, landed: 10 }
const beat = () => act(() => vi.advanceTimersByTime(10))
const verdict = () => screen.getByTestId(TESTIDS.verdict)
const field = (name: string) => within(screen.getAllByTestId(TESTIDS.field).find((f) => f.dataset.field === name) as HTMLElement)
const balance = (holder: string) => screen.getAllByTestId(TESTIDS.balance).find((b) => b.dataset.holder === holder)?.textContent
const chip = (id: string) => screen.getAllByTestId(TESTIDS.chip).find((c) => c.dataset.scene === id) as HTMLElement

const REFUSAL: Record<string, string> = { "pay-a-friend": TOKEN_REFUSALS.transfer, "cash-out": BRIDGE_REFUSALS.exitDestination }

describe("TourMode", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("plays every scene from the recording through its four beats, then starts over", () => {
		render(<TourMode header={null} pace={PACE} />)
		for (const scene of SCENES) {
			expect(chip(scene.id)).toHaveAttribute("aria-pressed", "true")
			expect(field("ACT AS").getByText(scene.actorLabel)).toBeInTheDocument()
			expect(field("TO").getByText(scene.toLabel)).toBeInTheDocument()
			expect(verdict()).toHaveAttribute("data-kind", "idle")
			beat()
			expect(verdict()).toHaveAttribute("data-kind", "working")
			beat()
			beat()
			expect(verdict()).toHaveAttribute("data-kind", scene.cheat ? "refused" : "settled")
			if (scene.cheat) expect(screen.getByTestId(TESTIDS.verdictRule)).toHaveTextContent(REFUSAL[scene.id] as string)
			else expect(screen.queryByTestId(TESTIDS.verdictRule)).toBeNull()
			beat()
		}
		expect(chip("deposit")).toHaveAttribute("aria-pressed", "true")
		expect(screen.queryAllByTestId(TESTIDS.feedRow)).toHaveLength(0)
	})

	it("ends with the run's net moves, and the public rows of what settled, newest first", () => {
		render(<TourMode header={null} pace={PACE} />)
		for (let i = 0; i < SCENES.length * BEATS.length - 1; i++) beat()
		const holders = ["A_demo", "portal", "B_demo", "alice", "bob", "galactica", "supplier"]
		expect(holders.map(balance)).toEqual(["−7.00", "+7.00", "0.00", "0.00", "0.00", "+7.00", "0.00"])
		const rows = screen.getAllByTestId(TESTIDS.feedRow).map((r) => [r.dataset.step, r.dataset.chain])
		expect(rows).toEqual([
			["withdraw", "ethereum"],
			["exit", "aztec"],
			["exit-refused", "none"],
			["transfer-refused", "none"],
			["refund", "aztec"],
			["pay", "aztec"],
			["request", "aztec"],
			["claim", "aztec"],
			["deposit", "ethereum"],
		])
	})

	it("pauses, jumps to a chip's outcome while paused, and replays a scene from its check", () => {
		render(<TourMode header={null} pace={PACE} />)
		fireEvent.click(screen.getByRole("button", { name: "Pause" }))
		fireEvent.click(chip("cash-out"))
		beat()
		expect(verdict()).toHaveAttribute("data-kind", "refused")
		expect(screen.getByTestId(TESTIDS.coin)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Replay" }))
		expect(verdict()).toHaveAttribute("data-kind", "working")
		expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument()
	})
})
