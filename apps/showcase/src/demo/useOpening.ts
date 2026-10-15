import { useEffect, useState } from "react"
import type { DemoWallet } from "./wallet"

export type Opening = { status: "opening" } | { status: "ready"; demo: DemoWallet } | { status: "failed"; message: string }

/** `start` run at most once per page, on the first call: the wallet's stores may not open twice. */
export function openOnce(start: () => Promise<DemoWallet>): () => Promise<DemoWallet> {
	let demo: Promise<DemoWallet> | undefined
	return () => {
		demo ??= start()
		return demo
	}
}

/** The page's wallet as it opens, opened only once `needed`: `open` must be {@link openOnce}'s, so this only follows it. */
export function useOpening(open: () => Promise<DemoWallet>, needed: boolean): Opening {
	const [opening, setOpening] = useState<Opening>({ status: "opening" })
	useEffect(() => {
		if (!needed) return
		let live = true
		open().then(
			(d) => live && setOpening({ status: "ready", demo: d }),
			(e: unknown) => live && setOpening({ status: "failed", message: e instanceof Error ? e.message : String(e) }),
		)
		return () => {
			live = false
		}
	}, [open, needed])
	return opening
}
