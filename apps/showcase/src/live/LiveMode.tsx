import { lazy, type ReactNode, Suspense } from "react"
import { Button } from "@/components/ui/button"
import { MANIFEST, PROVES, WALLETS } from "@/config/network"
import { type Observable, useObservable } from "@/lib/observable"
import { TESTIDS } from "@/lib/testids"
import type { PrestoConsent, PrestoView, ProofState } from "@/presto"
import type { Holder } from "@/tour/player"
import { SCENES } from "@/tour/scenes"
import { Composer, Field, SceneChips } from "@/ui/Composer"
import { HOLDER_NAME, stageCards } from "@/ui/cards"
import { usdc2 } from "@/ui/format"
import { Layout } from "@/ui/Layout"
import { Stage } from "@/ui/Stage"
import { Verdict } from "@/ui/Verdict"
import { WorldFeed } from "@/ui/WorldFeed"
import { ACTION_LABEL, actionsFor, LIVE_ACTORS, type LiveAction, needsAmount, targetsOf } from "./draft"
import type { ArchivedDeposit, LiveEngine, Payout } from "./engine"
import { type LiveView, useLive } from "./useLive"

/** The page's wallet as live mode sees it. */
export type WalletStatus = { status: "opening" } | { status: "ready" } | { status: "failed"; message: string }

/** Presto in "Try it yourself": the visitor's consent, and where the page's proofs run. */
export interface LivePresto {
	consent: PrestoConsent
	proof: Observable<ProofState>
}

// Real-proof builds only: a fake-proof page never loads Presto.
const PrestoRibbon = PROVES ? lazy(() => import("@/presto/PrestoRibbon").then((m) => ({ default: m.PrestoRibbon }))) : undefined

const control =
	"h-11 w-full min-w-0 rounded-lg border border-field bg-white px-2.5 text-sm font-semibold text-ink disabled:bg-idle-soft disabled:text-muted"
const linkButton = "cursor-pointer font-medium text-usdc underline-offset-2 hover:underline disabled:cursor-default disabled:text-muted"

/** Ethereum wallets read as such in the TO field; the stage's lane already says so on the cards. */
const targetName = (h: Holder): string =>
	h === "A_demo" ? "Alice's Ethereum wallet" : h === "B_demo" ? "Bob's Ethereum wallet" : HOLDER_NAME[h]

function Select<T extends string>(p: {
	value: T
	options: readonly T[]
	label: (v: T) => string
	onChange: (v: T) => void
	disabled: boolean
}) {
	return (
		<select className={control} value={p.value} disabled={p.disabled} onChange={(e) => p.onChange(e.target.value as T)}>
			{p.options.map((o) => (
				<option key={o} value={o}>
					{p.label(o)}
				</option>
			))}
		</select>
	)
}

function Fields({ v, locked }: { v: LiveView; locked: boolean }) {
	const { draft, edit } = v
	return (
		<>
			<Field name="ACT AS">
				<Select
					value={draft.actor}
					options={LIVE_ACTORS}
					label={(a) => HOLDER_NAME[a]}
					onChange={(actor) => edit({ actor })}
					disabled={locked}
				/>
			</Field>
			<Field name="ACTION">
				<Select<LiveAction>
					value={draft.action}
					options={actionsFor(draft.actor)}
					label={(a) => ACTION_LABEL[a]}
					onChange={(action) => edit({ action })}
					disabled={locked}
				/>
			</Field>
			<Field name="TO">
				<Select
					value={draft.to}
					options={targetsOf(draft.actor, draft.action)}
					label={targetName}
					onChange={(to) => edit({ to })}
					disabled={locked}
				/>
			</Field>
			<Field name="USDC">
				<input
					className={`${control} font-mono`}
					inputMode="decimal"
					aria-label="Amount in USDC"
					value={needsAmount(draft.action) ? draft.amount : ""}
					placeholder={needsAmount(draft.action) ? "0.10" : "—"}
					disabled={locked || !needsAmount(draft.action)}
					onChange={(e) => edit({ amount: e.target.value })}
				/>
			</Field>
		</>
	)
}

const OPENING = "Opening the demo wallet: it syncs the demo accounts first."

/** A status means the visitor connected Presto, which then proves when it answers; any other view keeps proofs here. */
function readyHint(view: PrestoView | undefined): string {
	if (!PROVES) return "Runs live on this local network, with proofs off."
	const where = typeof view === "object" ? "by Presto when it can, else in this browser" : "in this browser"
	return `Runs live on ${MANIFEST.network === "testnet" ? "testnet" : "this local network"}, proven ${where}.`
}

function Payouts({ payouts }: { payouts: readonly Payout[] }) {
	if (payouts.length === 0) return null
	return (
		<section className="rounded-xl border border-line bg-white px-4 py-3 text-sm" aria-labelledby="payouts-title">
			<h3 id="payouts-title" className="m-0 mb-1.5 font-mono text-[11px] font-semibold tracking-[0.08em] text-muted">
				PAYOUTS ON THEIR WAY TO ETHEREUM
			</h3>
			<ul className="m-0 flex list-none flex-col gap-1 p-0">
				{payouts.map((p) => (
					<li key={p.id} data-testid={TESTIDS.payout} data-state={p.state}>
						{usdc2(p.amount)} USDC to {targetName(p.recipient === WALLETS.B_demo ? "B_demo" : "A_demo")}:{" "}
						{p.state === "proving" ? "waiting for Ethereum to accept the proof of its block." : `stuck: ${p.note}`}
					</li>
				))}
			</ul>
		</section>
	)
}

function ArchivedDeposits(p: { deposits: readonly ArchivedDeposit[]; onCheck: (id: string) => void; disabled: boolean }) {
	if (p.deposits.length === 0) return null
	return (
		<section className="rounded-xl border border-line bg-white px-4 py-3 text-sm" aria-labelledby="archived-title">
			<h3 id="archived-title" className="m-0 mb-1.5 font-mono text-[11px] font-semibold tracking-[0.08em] text-muted">
				DEPOSITS ETHEREUM DOES NOT SHOW
			</h3>
			<ul className="m-0 flex list-none flex-col gap-1 p-0">
				{p.deposits.map((d) => (
					<li key={d.id} data-testid={TESTIDS.archivedDeposit}>
						{d.amount === undefined ? "A deposit" : `${usdc2(d.amount)} USDC`} from{" "}
						{targetName(d.user === "bob" ? "B_demo" : "A_demo")}: Ethereum showed no sign of it, so this page keeps its record.{" "}
						<button type="button" className={linkButton} disabled={p.disabled} onClick={() => p.onCheck(d.id)}>
							Check again
						</button>
					</li>
				))}
			</ul>
		</section>
	)
}

/** "Try it yourself": the composer drives the page's own wallet, live, and the stage shows the chains' balances. */
export function LiveMode(p: { header: ReactNode; engine: LiveEngine | undefined; wallet: WalletStatus; presto?: LivePresto }) {
	const { header, engine, wallet, presto } = p
	const v = useLive(engine, presto?.proof)
	const view = useObservable(presto?.consent.view)
	const ready = engine !== undefined && wallet.status === "ready"
	const figure = (h: Holder) => {
		const b = v.balances?.[h]
		return b === undefined ? "…" : usdc2(b)
	}
	const { ethereum, aztec } = stageCards(WALLETS, figure, "Private balance")
	const hint = wallet.status === "failed" ? wallet.message : wallet.status === "opening" ? OPENING : readyHint(view)
	const composer = (
		<Composer
			hint={hint}
			hintTestId={TESTIDS.walletStatus}
			hintStatus={wallet.status}
			aside={
				<button type="button" className={linkButton} disabled={!ready || v.busy} onClick={v.reset}>
					Reset balances
				</button>
			}
			fields={<Fields v={v} locked={v.busy} />}
			action={
				<Button className="w-full" data-testid={TESTIDS.tryIt} disabled={!ready || v.busy} onClick={v.run}>
					{v.busy ? "Running…" : "Try it"}
				</Button>
			}
			footer={
				v.error && (
					<p role="alert" className="m-0 text-sm text-bad">
						{v.error}
					</p>
				)
			}
			chips={<SceneChips scenes={SCENES} active={v.scene} onPick={(s) => v.pick(s.id)} />}
		/>
	)
	return (
		<Layout
			header={header}
			notice={
				presto &&
				PrestoRibbon && (
					<Suspense>
						<PrestoRibbon consent={presto.consent} />
					</Suspense>
				)
			}
			composer={composer}
			stage={<Stage ethereum={ethereum} aztec={aztec} flight={v.flight} />}
			verdict={
				<>
					<Verdict state={v.verdict} stages={v.stages} proof={v.proof} />
					<Payouts payouts={v.payouts} />
					<ArchivedDeposits deposits={v.archived} onCheck={(id) => void v.recheck(id)} disabled={!ready || v.busy} />
				</>
			}
			feed={<WorldFeed rows={v.rows} />}
		/>
	)
}
