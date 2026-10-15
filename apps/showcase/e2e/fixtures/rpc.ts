/**
 * Every JSON-RPC call a context makes to the run's Aztec node and anvil, read off the requests themselves, so a spec
 * proves what the page sent (or never sent) without trusting the page. Registered after the egress fence, so it sees
 * each request first and passes it on. The node's client batches calls, so one request may carry several.
 */
import type { BrowserContext, Route } from "@playwright/test"

export interface RpcLog {
	/** Every method called so far, in order; a spec marks a point with `calls.length`. */
	readonly calls: readonly string[]
	/** How many calls to `method` were made since `mark`. */
	countSince(mark: number, method: string): number
	/**
	 * Holds the next request that calls `method`; `held` resolves with that call's params once one is caught. `release`
	 * passes it on, or aborts it so it never reaches the chain (a request whose page has gone cannot be passed on).
	 */
	holdNext(method: string): { held: Promise<unknown[]>; release: (how?: "continue" | "abort") => void }
	/** Answers later calls to `method` with `edit` applied to the chain's real result, until the returned stop runs. */
	rewrite(method: string, edit: (result: unknown, params: unknown[]) => unknown): () => void
}

type Call = { id?: unknown; method?: unknown; params?: unknown[] }

/** The methods L1 txs leave the page by: the demo wallets sign locally, so a raw tx is what anvil receives. */
export const L1_SENDS = ["eth_sendRawTransaction", "eth_sendTransaction"] as const
/** aztec.js namespaces the node's methods `aztec_`; a spec that expects a send counts it, so a rename fails loudly. */
export const L2_SEND = "aztec_sendTx"

function callsOf(body: string | null): Call[] {
	if (!body) return []
	try {
		const parsed: unknown = JSON.parse(body)
		return (Array.isArray(parsed) ? parsed : [parsed]).filter((c: Call | null): c is Call => typeof c?.method === "string")
	} catch {
		return []
	}
}

type Rewrite = { method: string; edit: (result: unknown, params: unknown[]) => unknown }

/** The chain's real reply, with each matching call's result passed through `r.edit`; batches are matched by id. */
async function rewritten(route: Route, calls: Call[], r: Rewrite): Promise<void> {
	const response = await route.fetch()
	const body: unknown = await response.json()
	const bend = (reply: { id?: unknown; result?: unknown }) => {
		const call = calls.find((c) => c.id === reply?.id)
		return call?.method === r.method && reply && "result" in reply
			? { ...reply, result: r.edit(reply.result, call.params ?? []) }
			: reply
	}
	await route.fulfill({ response, json: Array.isArray(body) ? body.map(bend) : bend(body as { id?: unknown }) })
}

export async function recordRpc(context: BrowserContext, endpoints: readonly string[]): Promise<RpcLog> {
	const origins = new Set(endpoints.map((u) => new URL(u).origin))
	const calls: string[] = []
	type Release = "continue" | "abort"
	let hold: { method: string; caught: (params: unknown[]) => void; gate: Promise<Release> } | undefined
	let bent: Rewrite | undefined
	await context.route(
		(url) => origins.has(url.origin),
		async (route: Route) => {
			const sent = callsOf(route.request().postData())
			const methods = sent.map((c) => c.method as string)
			calls.push(...methods)
			const h = hold
			const r = bent
			if (r && methods.includes(r.method)) return rewritten(route, sent, r)
			if (!h || !methods.includes(h.method)) return route.fallback()
			hold = undefined
			h.caught(sent.find((c) => c.method === h.method)?.params ?? [])
			if ((await h.gate) === "abort") return route.abort("failed").catch(() => {})
			return route.fallback()
		},
	)
	return {
		calls,
		countSince: (mark, method) => calls.slice(mark).filter((m) => m === method).length,
		rewrite(method, edit) {
			const r = { method, edit }
			bent = r
			return () => {
				if (bent === r) bent = undefined
			}
		},
		holdNext(method) {
			let caught: (params: unknown[]) => void = () => {}
			let release: (how?: Release) => void = () => {}
			const held = new Promise<unknown[]>((r) => {
				caught = r
			})
			const gate = new Promise<Release>((r) => {
				release = (how = "continue") => r(how)
			})
			hold = { method, caught, gate }
			return { held, release }
		},
	}
}
