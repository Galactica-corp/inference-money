import { BRIDGE_REFUSALS, TOKEN_REFUSALS } from "@galactica-net/inference-money-core/rules"
import { expect, type Page } from "@playwright/test"
import { TESTIDS } from "../../src/lib/testids"
import { L1_SENDS, L2_SEND, type RpcLog } from "../fixtures/rpc"
import { compose, type Step, tryIt } from "./live"

/** "Within seconds", with room for a cold runner's first simulation. */
const REFUSED_WITHIN_MS = 30_000

/** Each cheat a visitor can try, and the contract rule that refuses it. */
export const CHEATS: [string, Step, string][] = [
	["alice pays her friend bob", { actor: "alice", action: "send", to: "bob", amount: "0.01" }, TOKEN_REFUSALS.transfer],
	[
		"alice cashes out to bob's Ethereum wallet",
		{ actor: "alice", action: "withdraw", to: "B_demo", amount: "0.01" },
		BRIDGE_REFUSALS.exitDestination,
	],
	["bob opens a payment request for alice", { actor: "bob", action: "request", to: "alice" }, TOKEN_REFUSALS.request],
	[
		"alice pays bob's request, which no merchant stamped",
		{ actor: "alice", action: "pay", to: "bob", amount: "0.01" },
		TOKEN_REFUSALS.payment,
	],
]

/** Tries one cheat: refused within seconds with its rule verbatim, and no tx left the page for either chain. */
export async function expectRefused(page: Page, rpc: RpcLog, [name, step, rule]: (typeof CHEATS)[number]): Promise<void> {
	const mark = rpc.calls.length
	await compose(page, step)
	const run = await tryIt(page)
	console.log(`[cheat] ${name}: ${run.kind} in ${run.ms} ms`)
	expect(run.kind, run.detail).toBe("refused")
	await expect(page.getByTestId(TESTIDS.verdictRule)).toHaveText(rule)
	expect(run.detail).toContain("Nothing was proven or sent.")
	expect(run.ms).toBeLessThan(REFUSED_WITHIN_MS)
	for (const method of [L2_SEND, ...L1_SENDS]) expect(rpc.countSince(mark, method), method).toBe(0)
}
