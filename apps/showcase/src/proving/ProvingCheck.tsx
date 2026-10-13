import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { BridgeManifest } from "@galactica-net/inference-money-core"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { PROVES } from "@/config/network"
import type { DemoWallet } from "@/demo/wallet"
import { TESTIDS } from "@/lib/testids"
import { type ProvingSample, timeOpenAndPay, timeTransfer } from "./check"

/** Timed runs per action. An untimed transfer goes first: it loads bb.js and fetches its proving keys. */
export const RUNS = 3

type Row = ProvingSample & { warmup: boolean }
type State = { status: "idle" | "running" | "done" } | { status: "failed"; message: string }

async function runCheck(demo: DemoWallet, m: BridgeManifest, push: (rows: Row[]) => void): Promise<void> {
	const token = AztecAddress.fromStringUnsafe(m.l2.token.address)
	// Each action waits its turn among the wallet's sends outside its own timing.
	const transfer = () => demo.exclusive(() => timeTransfer(demo, m, token))
	push([{ ...(await transfer()), warmup: true }])
	for (let i = 0; i < RUNS; i++) push([{ ...(await transfer()), warmup: false }])
	for (let i = 0; i < RUNS; i++) {
		const samples = await demo.exclusive(() => timeOpenAndPay(demo, m, token))
		push(samples.map((s) => ({ ...s, warmup: false })))
	}
}

const STATE_TEXT = { idle: "Not run yet.", running: "Proving…", done: "Done." } as const

/** Times the page's own proving on this device: what a visitor waits for on each private step. */
export function ProvingCheck({ demo, manifest }: { demo: DemoWallet; manifest: BridgeManifest }) {
	const [rows, setRows] = useState<Row[]>([])
	const [state, setState] = useState<State>({ status: "idle" })
	const cores = globalThis.navigator?.hardwareConcurrency ?? 0
	const isolated = globalThis.crossOriginIsolated === true
	const start = () => {
		setRows([])
		setState({ status: "running" })
		runCheck(demo, manifest, (added) => setRows((prev) => [...prev, ...added]))
			.then(() => setState({ status: "done" }))
			.catch((e: unknown) => setState({ status: "failed", message: e instanceof Error ? e.message : String(e) }))
	}
	return (
		<section className="flex flex-col gap-3 rounded-lg border border-line bg-white p-4">
			<p
				className="text-sm text-muted"
				data-testid={TESTIDS.provingEnv}
				data-cores={cores}
				data-isolated={isolated}
				data-proves={PROVES}
			>
				{cores} cores · {isolated ? "cross-origin isolated" : "not cross-origin isolated, so proving runs on one thread"}
			</p>
			<div className="flex items-center gap-3">
				<Button data-testid={TESTIDS.provingRun} disabled={state.status === "running"} onClick={start}>
					Run
				</Button>
				<span className="text-sm" data-testid={TESTIDS.provingState} data-state={state.status}>
					{state.status === "failed" ? state.message : STATE_TEXT[state.status]}
				</span>
			</div>
			<ol className="flex flex-col gap-1 text-sm tabular-nums">
				{rows.map((r) => (
					<li
						key={r.txHash}
						data-testid={TESTIDS.provingSample}
						data-action={r.action}
						data-ms={r.ms}
						data-warmup={r.warmup}
						data-tx={r.txHash}
					>
						{r.action}
						{r.warmup ? " (warm-up)" : ""}: {(r.ms / 1000).toFixed(1)} s
					</li>
				))}
			</ol>
		</section>
	)
}
