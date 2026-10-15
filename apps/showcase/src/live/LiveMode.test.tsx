import { BRIDGE_REFUSALS, TOKEN_REFUSALS } from "@inference-money/bridge-core/rules"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { WALLETS } from "@/config/network"
import type { SendStage } from "@/demo/wallet"
import { cell } from "@/lib/observable"
import { TESTIDS } from "@/lib/testids"
import type { PrestoView, ProofSource, ProofState } from "@/presto"
import type { FeedRow } from "@/tour/player"
import { DEPOSITS_CLOSED, type Draft, type ValidDraft } from "./draft"
import type { LiveEngine } from "./engine"
import { LiveMode } from "./LiveMode"
import { classify, type Outcome } from "./outcome"

/** `PROVES` is a build constant, false under vitest; a test that needs real proofs flips it here and resets it. */
const build = vi.hoisted(() => ({ proves: false }))
vi.mock("@/config/network", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/config/network")>()
	return {
		...actual,
		get PROVES() {
			return build.proves
		},
	}
})

const liveRow = (key: string): FeedRow => ({ key, source: "live", chain: "aztec", text: "A private transaction.", items: [] })

/** The wallet layer, faked: `answer` decides each run's outcome, and a settled run passes through every send stage. */
function fakeEngine(answer: (d: ValidDraft) => Outcome = () => ({ kind: "settled", detail: "Done.", rows: [liveRow("0x1")] })) {
	const listeners = new Set<(s: SendStage) => void>()
	const runs: ValidDraft[] = []
	const engine: LiveEngine = {
		run: async (d) => {
			runs.push(d)
			const outcome = answer(d)
			if (outcome.kind === "settled") for (const s of ["prove", "send", "settle"] as const) for (const f of listeners) f(s)
			return outcome
		},
		balances: async () => ({ alice: 10_000_000n, galactica: 7_000_000n }),
		reset: async () => ({ actor: "galactica", action: "send", to: "alice", amount: 3_000_000n }),
		payouts: async () => [],
		archived: () => [],
		recheck: async () => "",
		stages: {
			emit: (s) => {
				for (const f of listeners) f(s)
			},
			listen: (f) => {
				listeners.add(f)
				return () => listeners.delete(f)
			},
		},
	}
	return { engine, runs }
}

const ready = { status: "ready", depositsOpen: true } as const
const field = (name: string) => within(screen.getAllByTestId(TESTIDS.field).find((f) => f.dataset.field === name) as HTMLElement)
const chip = (id: string) => screen.getAllByTestId(TESTIDS.chip).find((c) => c.dataset.scene === id) as HTMLElement
const tryIt = () => act(async () => fireEvent.click(screen.getByTestId(TESTIDS.tryIt)))
const verdict = () => screen.getByTestId(TESTIDS.verdict)

describe("LiveMode", () => {
	it("runs a scene's preset live, through every stage, and labels what the chains showed as live", async () => {
		const { engine, runs } = fakeEngine()
		render(<LiveMode header={null} engine={engine} wallet={ready} />)
		await act(async () => fireEvent.click(chip("refund")))
		expect((field("ACT AS").getByRole("combobox") as HTMLSelectElement).value).toBe("galactica")
		expect((field("TO").getByRole("combobox") as HTMLSelectElement).value).toBe("alice")
		await tryIt()
		expect(runs).toEqual([{ actor: "galactica", action: "send", to: "alice", amount: 30_000n }])
		expect(verdict()).toHaveAttribute("data-kind", "settled")
		expect(screen.getByTestId(TESTIDS.feedSource)).toHaveTextContent("LIVE")
		await waitFor(() =>
			expect(screen.getAllByTestId(TESTIDS.balance).find((b) => b.dataset.holder === "galactica")).toHaveTextContent("7.00"),
		)
	})

	it("lists a deposit Ethereum does not show with Check again, which reads it again and says what it found", async () => {
		const { engine } = fakeEngine()
		const kept = [{ id: "d1", user: "alice" as const, amount: 100_000n }]
		const checked: string[] = []
		engine.archived = () => kept
		engine.recheck = async (id) => {
			checked.push(id)
			kept.length = 0
			return "Found it on Ethereum: Alice can claim it now."
		}
		render(<LiveMode header={null} engine={engine} wallet={ready} />)
		const row = await screen.findByTestId(TESTIDS.archivedDeposit)
		expect(row).toHaveTextContent("0.10 USDC from Alice's Ethereum wallet")
		await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Check again" })))
		expect(checked).toEqual(["d1"])
		await waitFor(() => expect(verdict()).toHaveTextContent("Found it on Ethereum: Alice can claim it now."))
		await waitFor(() => expect(screen.queryByTestId(TESTIDS.archivedDeposit)).toBeNull())
	})

	/** A simulation's error carries the rule; bridge-core's exit check, which runs first, words it for the CLI. */
	const simulated = (rule: string) => new Error(`Simulation error: ${rule}`)
	const exitCheck = Object.assign(new Error("This account withdraws only to its funding address 0x1, not 0x2."), {
		name: "ExitDestinationError",
	})

	it.each<[string, Draft, string, Error]>([
		[
			"paying a friend",
			{ actor: "alice", action: "send", to: "bob", amount: "0.01" },
			TOKEN_REFUSALS.transfer,
			simulated(TOKEN_REFUSALS.transfer),
		],
		[
			"cashing out elsewhere",
			{ actor: "alice", action: "withdraw", to: "B_demo", amount: "0.01" },
			BRIDGE_REFUSALS.exitDestination,
			exitCheck,
		],
		[
			"a request between users",
			{ actor: "bob", action: "request", to: "alice", amount: "" },
			TOKEN_REFUSALS.request,
			simulated(TOKEN_REFUSALS.request),
		],
		[
			"paying a user's unstamped request",
			{ actor: "alice", action: "pay", to: "bob", amount: "0.01" },
			TOKEN_REFUSALS.payment,
			simulated(TOKEN_REFUSALS.payment),
		],
	])("shows %s refused with the contract's own rule, verbatim", async (_, draft, rule, thrown) => {
		const { engine } = fakeEngine((d) => classify(thrown, d))
		render(<LiveMode header={null} engine={engine} wallet={ready} />)
		await act(async () => {
			fireEvent.change(field("ACT AS").getByRole("combobox"), { target: { value: draft.actor } })
			fireEvent.change(field("ACTION").getByRole("combobox"), { target: { value: draft.action } })
			fireEvent.change(field("TO").getByRole("combobox"), { target: { value: draft.to } })
			fireEvent.change(field("USDC").getByRole("textbox"), { target: { value: draft.amount } })
		})
		await tryIt()
		expect(verdict()).toHaveAttribute("data-kind", "refused")
		expect(screen.getByTestId(TESTIDS.verdictRule).textContent).toBe(rule)
		expect(screen.queryAllByTestId(TESTIDS.feedRow)).toHaveLength(0)
	})

	it("checks the amount before anything runs, and waits for the wallet before it lets anything run", async () => {
		const { engine, runs } = fakeEngine()
		const { rerender } = render(<LiveMode header={null} engine={engine} wallet={ready} />)
		await act(async () => fireEvent.change(field("USDC").getByRole("textbox"), { target: { value: "1,5" } }))
		await tryIt()
		expect(screen.getByRole("alert")).toHaveTextContent("Use digits and at most one decimal point")
		expect(runs).toHaveLength(0)
		rerender(<LiveMode header={null} engine={undefined} wallet={{ status: "opening" }} />)
		expect(screen.getByTestId(TESTIDS.tryIt)).toBeDisabled()
		expect(screen.getByTestId(TESTIDS.walletStatus)).toHaveAttribute("data-status", "opening")
	})

	it("with deposits closed, says why and refuses only a deposit: a claim still runs and payouts still show", async () => {
		const { engine, runs } = fakeEngine()
		engine.payouts = async () => [{ id: "p", recipient: WALLETS.A_demo, amount: 10_000n, state: "proving" }]
		const closed = { status: "ready", depositsOpen: false } as const
		const { rerender } = render(<LiveMode header={null} engine={engine} wallet={closed} />)
		expect(screen.getByRole("status")).toHaveTextContent(DEPOSITS_CLOSED)
		const pick = (action: string) =>
			act(async () => {
				fireEvent.change(field("ACT AS").getByRole("combobox"), { target: { value: "alice" } })
				fireEvent.change(field("ACTION").getByRole("combobox"), { target: { value: action } })
			})
		await pick("deposit")
		expect(screen.getByTestId(TESTIDS.tryIt)).toBeDisabled()
		await pick("claim")
		await tryIt()
		expect(runs).toEqual([{ actor: "alice", action: "claim", to: "alice" }])
		await waitFor(() => expect(screen.getByTestId(TESTIDS.payout)).toHaveAttribute("data-state", "proving"))
		rerender(<LiveMode header={null} engine={engine} wallet={ready} />)
		await pick("deposit")
		expect(screen.queryByTestId(TESTIDS.depositsClosed)).toBeNull()
		expect(screen.getByTestId(TESTIDS.tryIt)).toBeEnabled()
	})

	it("names Presto on the Prove chip for a run whose proof finished there, and for no later run", async () => {
		const { engine } = fakeEngine()
		const proof = cell<ProofState>({})
		const run = engine.run
		let next: ProofSource | undefined
		engine.run = async (d, report) => {
			if (next) proof.set({ ran: next })
			return run(d, report)
		}
		const presto = { consent: { view: cell(undefined), connect: vi.fn(), stop: vi.fn() }, proof }
		render(<LiveMode header={null} engine={engine} wallet={ready} presto={presto} />)
		await act(async () => fireEvent.click(chip("refund")))
		const proveChip = () =>
			within(verdict())
				.getAllByRole("listitem")
				.find((li) => li.dataset.stage === "prove")
		const labels: (string | null | undefined)[] = []
		for (const source of ["presto", "browser", "presto", undefined] as const) {
			next = source
			await tryIt()
			labels.push(proveChip()?.textContent)
		}
		expect(labels).toEqual(["Prove · Presto", "Prove", "Prove · Presto", "Prove"])
	})

	it("says Presto receives each proof's private inputs, keys included, only while it is connected", async () => {
		build.proves = true
		try {
			const view = cell<PrestoView | undefined>({ available: true, needsDownload: false, protocol: "https" })
			const presto = { consent: { view, connect: vi.fn(), stop: vi.fn() }, proof: cell<ProofState>({}) }
			render(<LiveMode header={null} engine={fakeEngine().engine} wallet={ready} presto={presto} />)
			const hint = screen.getByTestId(TESTIDS.walletStatus)
			expect(hint).toHaveTextContent("proven by Presto when it can, else in this browser.")
			expect(hint).toHaveTextContent("full private inputs, the keys that track this account's spends included")
			act(() => view.set("ask"))
			expect(hint).toHaveTextContent("proven in this browser.")
			expect(hint).not.toHaveTextContent("private inputs")
		} finally {
			build.proves = false
		}
	})

	it("resets the balances with galactica's refund to alice, or says why there is none", async () => {
		const { engine, runs } = fakeEngine()
		render(<LiveMode header={null} engine={engine} wallet={ready} />)
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reset balances" })))
		await waitFor(() => expect(runs).toEqual([{ actor: "galactica", action: "send", to: "alice", amount: 3_000_000n }]))
		engine.reset = async () => "Alice already holds her starting balance."
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reset balances" })))
		await waitFor(() => expect(verdict()).toHaveTextContent("Alice already holds her starting balance."))
	})
})
