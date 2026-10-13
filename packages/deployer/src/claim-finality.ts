import type { ClaimTicket, Reconciled } from "@inference-money/bridge-core"

export interface ReclaimSteps {
	finality(t: ClaimTicket): Promise<"finalized" | "dropped">
	reconcile(t: ClaimTicket): Promise<Reconciled>
	claimAgain(t: ClaimTicket): Promise<void>
	pause(ms: number): Promise<void>
	log(line: string): void
}

/**
 * A checkpointed claim can still be pruned, so it is claimed again until final. A deposit the L1 reader calls never
 * sent stops this by throwing, the ticket still stored; every other failure is retried.
 */
export async function keepUntilFinal(first: ClaimTicket, steps: ReclaimSteps): Promise<void> {
	let t = first
	while ((await steps.finality(t)) === "dropped") {
		steps.log("  the claim was pruned before it was final; claiming again")
		t = await reclaim(t, steps)
	}
}

async function reclaim(t: ClaimTicket, steps: ReclaimSteps): Promise<ClaimTicket> {
	for (;;) {
		const r = await steps.reconcile(t)
		if (r === "not-deposited") throw new Error("the pruned claim's deposit never reached L1 and its permit expired")
		if (r === "pending") steps.log("  the deposit is not readable on L1 right now; retrying in a minute")
		else {
			try {
				await steps.claimAgain(r)
				return r
			} catch (e) {
				steps.log(`  claiming again failed (${e instanceof Error ? e.message : String(e)}); retrying in a minute`)
			}
		}
		await steps.pause(60_000)
	}
}
