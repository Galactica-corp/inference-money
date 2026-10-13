import type { Tour } from "@galactica-net/inference-money-demo/tour"
import { useEffect, useMemo, useState } from "react"
import { addMoves, type Explorer, type FeedRow, type Moves, type PlayedScene, playTour } from "./player"

/** A scene in four beats: about to run, the wallet checking the rules, the coin moving, and the outcome. */
export const BEATS = ["ready", "checking", "moving", "landed"] as const
export type Beat = (typeof BEATS)[number]

/** How long each beat holds, in ms: the outcome long enough to read why. */
export const PACE: Readonly<Record<Beat, number>> = { ready: 1600, checking: 1200, moving: 1200, landed: 3600 }

export interface TourView {
	played: readonly PlayedScene[]
	index: number
	beat: Beat
	/** What moved over the scenes played so far, the current one once it lands. */
	moves: Moves
	/** Their public rows, newest first. */
	feed: readonly FeedRow[]
	playing: boolean
	/** Shows scene `index` at `beat`: by default its check while playing, its outcome while paused. */
	goTo: (index: number, beat?: Beat) => void
	setPlaying: (playing: boolean) => void
}

/** Plays the recording scene by scene, from the start again after the last. */
export function useTour(tour: Tour, pace: Readonly<Record<Beat, number>> = PACE, explorer?: Explorer): TourView {
	const played = useMemo(() => playTour(tour, explorer), [tour, explorer])
	const [tick, setTick] = useState(0)
	const [playing, setPlaying] = useState(true)
	const length = played.length * BEATS.length
	const index = Math.floor(tick / BEATS.length)
	const beat = BEATS[tick % BEATS.length] as Beat
	useEffect(() => {
		if (!playing) return
		const timer = setTimeout(() => setTick((tick + 1) % length), pace[BEATS[tick % BEATS.length] as Beat])
		return () => clearTimeout(timer)
	}, [playing, pace, tick, length])
	const done = played.slice(0, beat === "landed" ? index + 1 : index)
	return {
		played,
		index,
		beat,
		moves: done.map((p) => p.moves).reduce(addMoves, {}),
		feed: done.flatMap((p) => p.rows).reverse(),
		playing,
		goTo: (i, at = playing ? "checking" : "landed") => setTick(i * BEATS.length + BEATS.indexOf(at)),
		setPlaying,
	}
}
