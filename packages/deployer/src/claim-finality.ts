import type { ClaimTicket, Reconciled } from "@galactica-net/inference-money-core"

export interface ReclaimSteps {
	finality(t: ClaimTicket): Promise<"finalized" | "dropped">
	reconcile(t: ClaimTicket): Promise<Reconciled>
	claimAgain(t: ClaimTicket): Promise<void>
	pause(ms: number): Promise<void>
	log(line: string): void
}

/**
 * A checkpointed claim can still be pruned, so its ticket, the only copy of the secret, is kept until the claim is
 * final. Only a deposit proven never to have reached L1 gives it up; every other failure is retried.
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
