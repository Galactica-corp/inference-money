import { BRIDGE_REFUSALS, TOKEN_REFUSALS } from "@galactica-net/inference-money-core/rules"
import type { Tour, TourStep, WorldItem } from "@galactica-net/inference-money-demo/tour"
import { type Holder, SCENES, type Scene } from "./scenes"

export type { Holder }
export type Moves = Partial<Record<Holder, bigint>>

export interface FeedRow {
	/** Unique within a feed: a recorded row's tour step. */
	key: string
	/** Replayed from the recording, or sent from this page: the feed never passes one off as the other. */
	source: "recorded" | "live"
	chain: "ethereum" | "aztec" | "none"
	text: string
	items: readonly WorldItem[]
	/** The tx on a public explorer, where the network has one. */
	href?: string
}

/** Tx pages by hash prefix: Ethereum's, then Aztec's. */
export interface Explorer {
	l1Tx: string
	l2Tx: string
}

/** A scene as the recording tells it. */
export interface PlayedScene {
	scene: Scene
	verdict: "settled" | "refused"
	/** The contracts' own refusal text, verbatim. */
	refusal: string | undefined
	/** What the coin carries: the scene's last step's amount, in base units. */
	amount: bigint
	moves: Moves
	rows: FeedRow[]
}

/** What an observer of the chain can say about a step: no more than its public fields show. */
export const PUBLIC_TEXT: Record<TourStep["action"], string> = {
	deposit: "A deposit into the portal, in the clear.",
	claim: "A private transaction minted USDC.",
	request: "A private transaction.",
	pay: "A private payment whose amount is public.",
	refund: "A private transaction.",
	transfer: "A private transaction.",
	exit: "A private transaction burned USDC and messaged Ethereum.",
	withdraw: "The portal paid a withdrawal out, in the clear.",
}
export const REFUSED_TEXT = "The wallet refused it before proving anything, so nothing reached a chain."

const RULES: Record<string, string> = { ...TOKEN_REFUSALS, ...BRIDGE_REFUSALS }

/** The contracts' text for a refusal's rule id. */
export const refusalText = (rule: string): string => RULES[rule] ?? rule

/** How a settled step moves balances, read from its action, its parties and its amount. */
export function movesOf(s: TourStep): Moves {
	if (s.verdict === "refused") return {}
	const a = BigInt(s.amount)
	switch (s.action) {
		case "deposit":
			return { [s.actor]: -a, portal: a }
		case "claim":
			return { [s.to]: a }
		case "pay":
		case "refund":
		case "transfer":
			return { [s.actor]: -a, [s.to]: a }
		case "exit":
			return { [s.actor]: -a }
		case "withdraw":
			return { portal: -a, [s.to]: a }
		default:
			return {}
	}
}

export function addMoves(a: Moves, b: Moves): Moves {
	const sum: Moves = { ...a }
	for (const [k, v] of Object.entries(b) as [Holder, bigint][]) sum[k] = (sum[k] ?? 0n) + v
	return sum
}

function txLink(s: TourStep, explorer: Explorer | undefined): string | undefined {
	if (!explorer) return undefined
	if (s.l2) return `${explorer.l2Tx}${s.l2.txHash}`
	if (s.l1) return `${explorer.l1Tx}${s.l1.txHash}`
	return undefined
}

/** A recorded step's public row. */
export function rowOf(s: TourStep, explorer: Explorer | undefined): FeedRow {
	const row = { key: s.id, source: "recorded" } as const
	if (s.verdict === "refused") return { ...row, chain: "none", text: REFUSED_TEXT, items: [] }
	const chain = s.world.some((w) => w.chain === "ethereum") ? "ethereum" : "aztec"
	return { ...row, chain, text: PUBLIC_TEXT[s.action], items: s.world, href: txLink(s, explorer) }
}

export function playScene(tour: Tour, scene: Scene, explorer?: Explorer): PlayedScene {
	const entries = scene.steps.map((id) => {
		const s = tour.steps.find((t) => t.id === id)
		if (!s) throw new Error(`The tour has no ${id} step.`)
		return s
	})
	const refused = entries.find((s) => s.verdict === "refused")
	return {
		scene,
		verdict: refused ? "refused" : "settled",
		refusal: refused?.rule === undefined ? undefined : refusalText(refused.rule),
		amount: BigInt(entries[entries.length - 1]?.amount ?? 0),
		moves: entries.map(movesOf).reduce(addMoves, {}),
		rows: entries.map((s) => rowOf(s, explorer)),
	}
}

/** Every scene of the tour, in order. */
export const playTour = (tour: Tour, explorer?: Explorer): PlayedScene[] => SCENES.map((s) => playScene(tour, s, explorer))
