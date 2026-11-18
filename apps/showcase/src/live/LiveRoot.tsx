import { type ReactNode, useMemo } from "react"
import { EXPLORER, L1_RPC_URL, MANIFEST, TOUR, WALLETS } from "@/config/network"
import { deploymentStore } from "@/demo/start"
import { tickets } from "@/demo/tickets"
import type { Opening } from "@/demo/useOpening"
import { liveEngine } from "./engine"
import { LiveMode } from "./LiveMode"
import { useLivePresto } from "./useLivePresto"

/** Live mode with the page's wallet behind it, once open: loaded on demand, since it carries the Aztec SDK. */
export function LiveRoot({ header, opening }: { header: ReactNode; opening: Opening }) {
	const engine = useMemo(() => {
		if (opening.status !== "ready") return undefined
		const ctx = {
			demo: opening.demo,
			m: MANIFEST,
			l1RpcUrl: L1_RPC_URL,
			tickets: tickets(deploymentStore()),
			tour: TOUR,
			explorer: EXPLORER,
			requests: new Map(),
		}
		return liveEngine(ctx, WALLETS)
	}, [opening])
	const presto = useLivePresto(opening.status === "ready" ? opening.demo.presto : undefined)
	const wallet = opening.status === "ready" ? { status: "ready" as const, depositsOpen: opening.demo.depositsOpen } : opening
	return <LiveMode header={header} engine={engine} wallet={wallet} presto={presto} />
}
