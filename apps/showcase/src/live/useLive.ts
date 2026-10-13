import { type RefObject, useCallback, useEffect, useRef, useState } from "react"
import type { Observable } from "@/lib/observable"
import type { ProofState } from "@/presto"
import { CHECKING } from "@/tour/frame"
import type { FeedRow, Holder } from "@/tour/player"
import type { SceneId } from "@/tour/scenes"
import { usdc2 } from "@/ui/format"
import type { Flight } from "@/ui/Stage"
import { STAGES, type Stage, type VerdictState } from "@/ui/Verdict"
import { type Draft, PRESETS, settle, tripOf, type ValidDraft, validate } from "./draft"
import type { ArchivedDeposit, LiveEngine, Payout } from "./engine"
import type { Outcome } from "./outcome"

/** Between runs, payouts are checked this often: an epoch proves on the order of minutes. */
export const PAYOUT_POLL_MS = 30_000

const WORKING: Record<Stage, string> = {
	simulate: CHECKING,
	prove: "The rules allow it. The wallet proves it here, in this browser.",
	send: "Sending it to the network.",
	settle: "Sent. Waiting for the network to include it.",
}
const ON_PRESTO = "The rules allow it. Presto proves it on this computer."

const IDLE: VerdictState = { kind: "idle", detail: "Pick a step, or set your own, then press Try it." }

const verdictOf = (o: Outcome, at: Stage): VerdictState => (o.kind === "failed" ? { kind: "failed", stage: at, detail: o.detail } : o)

/** An Ethereum deposit has nothing to prove. */
const stagesFor = (d: Pick<Draft, "action">): readonly Stage[] => (d.action === "deposit" ? STAGES.filter((s) => s !== "prove") : STAGES)

const coinLabel = (d: ValidDraft): string => (d.amount === undefined ? d.action : usdc2(d.amount))

/** What the chains showed, refreshed after each run, with outstanding payouts polled between runs. */
function useChains(engine: LiveEngine | undefined, running: RefObject<boolean>) {
	const [rows, setRows] = useState<FeedRow[]>([])
	const [balances, setBalances] = useState<Partial<Record<Holder, bigint>>>()
	const [payouts, setPayouts] = useState<Payout[]>([])
	const [archived, setArchived] = useState<ArchivedDeposit[]>([])
	const addRow = useCallback((row: FeedRow) => setRows((r) => [row, ...r.filter((x) => x.key !== row.key)]), [])
	const refresh = useCallback(async () => {
		if (!engine) return
		setArchived(engine.archived())
		const [b, p] = await Promise.all([engine.balances().catch(() => undefined), engine.payouts(addRow).catch(() => undefined)])
		if (b) setBalances(b)
		if (p) setPayouts(p)
	}, [engine, addRow])
	useEffect(() => {
		void refresh()
	}, [refresh])
	useEffect(() => {
		if (!engine || payouts.length === 0) return
		const timer = setInterval(() => void (running.current || refresh()), PAYOUT_POLL_MS)
		return () => clearInterval(timer)
	}, [engine, payouts.length, refresh, running])
	return { rows, addRow, balances, payouts, archived, refresh }
}

/**
 * One run at a time: the verdict and the coin follow its stages, from the runner and from the wallet, and `proof`
 * follows the run's own proofs only, so a run that proves nothing never shows an earlier run's.
 */
function useRun(
	engine: LiveEngine | undefined,
	running: RefObject<boolean>,
	chains: ReturnType<typeof useChains>,
	proofs: Observable<ProofState> | undefined,
) {
	const [busy, setBusy] = useState(false)
	const [verdict, setVerdict] = useState<VerdictState>(IDLE)
	const [flight, setFlight] = useState<Flight>()
	const [stages, setStages] = useState<readonly Stage[]>(STAGES)
	const [proof, setProof] = useState<ProofState>({})
	const { addRow, refresh } = chains
	const execute = useCallback(
		async (d: ValidDraft) => {
			if (!engine || running.current) return
			running.current = true
			setBusy(true)
			setStages(stagesFor(d))
			setProof({})
			const coin = { ...tripOf(d), label: coinLabel(d) }
			let at: Stage = "simulate"
			const report = (stage: Stage, detail?: string) => {
				at = stage
				setVerdict({ kind: "working", stage, detail: detail ?? WORKING[stage] })
				setFlight({ ...coin, ok: true, phase: stage === "simulate" ? "checking" : "moving" })
			}
			const unlisten = engine.stages.listen(report)
			const unlistenProof = proofs?.listen(setProof)
			try {
				const outcome = await engine.run(d, report)
				setVerdict(verdictOf(outcome, at))
				setFlight({ ...coin, ok: outcome.kind === "settled", phase: "landed" })
				if (outcome.kind === "settled") for (const row of [...outcome.rows].reverse()) addRow(row)
			} finally {
				unlisten()
				unlistenProof?.()
				running.current = false
				setBusy(false)
				void refresh()
			}
		},
		[engine, running, addRow, refresh, proofs],
	)
	const recheck = useCallback(
		async (id: string) => {
			if (!engine || running.current) return
			running.current = true
			setBusy(true)
			try {
				const detail = await engine.recheck(id).catch((e: unknown) => (e instanceof Error ? e.message : String(e)))
				setVerdict({ kind: "idle", detail })
			} finally {
				running.current = false
				setBusy(false)
				void refresh()
			}
		},
		[engine, running, refresh],
	)
	return { busy, verdict, setVerdict, flight, stages, execute, proof, recheck }
}

export type LiveView = ReturnType<typeof useLive>

/**
 * Live mode's state: the composer's draft, the run in flight, and what the chains showed. `proofs` is where the page's
 * proofs run, on a page that can prove through Presto.
 */
export function useLive(engine: LiveEngine | undefined, proofs?: Observable<ProofState>) {
	const [draft, setDraft] = useState<Draft>(PRESETS.deposit)
	const [scene, setScene] = useState<SceneId | undefined>("deposit")
	const [error, setError] = useState<string>()
	const running = useRef(false)
	const chains = useChains(engine, running)
	const runner = useRun(engine, running, chains, proofs)
	const { execute, setVerdict, verdict, proof } = runner
	const onPresto = verdict.kind === "working" && verdict.stage === "prove" && proof.attempt === "presto"
	return {
		...chains,
		...runner,
		verdict: onPresto ? { ...verdict, detail: ON_PRESTO } : verdict,
		draft,
		scene,
		error,
		edit: (patch: Partial<Draft>) => {
			setDraft((d) => settle({ ...d, ...patch }))
			setScene(undefined)
			setError(undefined)
		},
		pick: (id: SceneId) => {
			setDraft(PRESETS[id])
			setScene(id)
			setError(undefined)
		},
		run: () => {
			const checked = validate(draft)
			setError(checked.ok ? undefined : checked.error)
			if (checked.ok) void execute(checked.draft)
		},
		reset: () => {
			if (!engine || running.current) return
			void engine.reset().then((r) => (typeof r === "string" ? setVerdict({ kind: "idle", detail: r }) : execute(r)))
		},
	}
}
