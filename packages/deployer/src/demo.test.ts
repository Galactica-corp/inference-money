import { describe, expect, it } from "bun:test"
import type { ClaimTicket, DepositDraft } from "@galactica-net/inference-money-core"
import { BIND_SEEDS, type PlanStore, runSetup, type Seed, type SetupOps, type SetupPlan } from "./demo"

const memoryStore = () => {
	let plan: SetupPlan | undefined
	const store: PlanStore = {
		read: () => (plan ? structuredClone(plan) : undefined),
		write: (p) => {
			plan = structuredClone(p)
		},
		clear: () => {
			plan = undefined
		},
	}
	return { store, current: () => plan }
}

const draftOf = (seed: Seed) => ({ intent: { amount: 1n, kind: "private" }, seed }) as unknown as DepositDraft
const ticketOf = (seed: Seed) => ({ draft: draftOf(seed), messageHash: "0x01", leafIndex: 0n, depositor: "0x02" }) as unknown as ClaimTicket
const seedOf = (t: ClaimTicket) => (t.draft as unknown as { seed: Seed }).seed
const isBind = (seed: Seed) => (BIND_SEEDS as readonly Seed[]).includes(seed)

/** Each step in `events`, in order; a merchant's binding claim binds it, and the merchants are listed once `listed`. */
function fakeOps(over: Partial<SetupOps> & { finality?: SetupOps["final"]["finality"] } = {}) {
	const events: string[] = []
	const calls = { claims: [] as Seed[], reclaims: [] as Seed[] }
	const bound = new Set<Seed>()
	const ops: SetupOps = {
		prepare: async () => {},
		bound: async (seed) => bound.has(seed),
		list: async () => {
			events.push("list")
		},
		deposit: async (seed) => {
			events.push(`deposit ${seed}`)
			return ticketOf(seed)
		},
		claim: async (t) => {
			const seed = seedOf(t)
			events.push(`claim ${seed}`)
			calls.claims.push(seed)
			if (isBind(seed)) bound.add(seed)
		},
		final: {
			finality: over.finality ?? (async () => "finalized"),
			reconcile: async (t) => t,
			claimAgain: async (t) => {
				calls.reclaims.push(seedOf(t))
			},
			pause: async () => {},
			log: () => {},
		},
		...over,
	}
	return { ops, calls, events, bound }
}

describe("demo setup", () => {
	it("publishes the users' tag and drops the secrets only once every claim is finalized, re-claiming a pruned one first", async () => {
		const { store, current } = memoryStore()
		const floatFinal = Promise.withResolvers<"finalized">()
		const floatAnswers: Promise<"finalized" | "dropped">[] = [Promise.resolve("dropped"), floatFinal.promise]
		let asked = 0
		const finality = async (t: ClaimTicket) => {
			if (seedOf(t) !== "galactica") return "finalized" as const
			asked++
			return floatAnswers.shift() as Promise<"finalized" | "dropped">
		}
		const { ops, calls } = fakeOps({ finality })
		const published: string[] = []
		const run = runSetup(store, ops, (tag) => published.push(tag))

		while (asked < 2) await Bun.sleep(1)
		expect(published).toEqual([])
		expect(calls.reclaims).toEqual(["galactica"])
		expect(current()?.tag).toMatch(/^[0-9a-f]{32}$/)

		floatFinal.resolve("finalized")
		await run
		expect(calls.claims).toEqual(["galacticaBind", "supplierBind", "alice", "bob", "galactica"])
		expect(published).toHaveLength(1)
		expect(current()).toBeUndefined()
	})

	it("binds both merchants and lists them before any user seed, and resumes past a listing it stopped for", async () => {
		const { store, current } = memoryStore()
		const stop = fakeOps({
			list: async () => {
				stop.events.push("list")
				throw new Error("List the demo merchants first")
			},
		})
		await expect(runSetup(store, stop.ops, () => {})).rejects.toThrow("List the demo merchants first")
		expect(stop.events).toEqual(["deposit galacticaBind", "deposit supplierBind", "claim galacticaBind", "claim supplierBind", "list"])
		expect(Object.keys(current()?.tickets ?? {}), "the binding tickets survive the stop").toEqual(["galacticaBind", "supplierBind"])

		const resume = fakeOps()
		for (const seed of BIND_SEEDS) resume.bound.add(seed)
		const published: string[] = []
		await runSetup(store, resume.ops, (tag) => published.push(tag))
		expect(
			resume.events.filter((e) => e.startsWith("deposit")),
			"no merchant deposits twice",
		).toEqual(["deposit alice", "deposit bob", "deposit galactica"])
		expect(resume.events.indexOf("list")).toBeLessThan(resume.events.indexOf("deposit alice"))
		expect(published).toHaveLength(1)
	})

	it("refuses to list a merchant bound anywhere but its treasury, before any deposit or claim, even on resume", async () => {
		const { store, current } = memoryStore()
		const poisoned = () =>
			fakeOps({
				bound: async () => {
					throw new Error("galactica is bound to 0xbad, not its treasury: redeploy, or list another merchant account")
				},
			})
		const fresh = poisoned()
		await expect(runSetup(store, fresh.ops, () => {})).rejects.toThrow("redeploy")
		expect(fresh.events).toEqual([])

		const stop = fakeOps({ list: async () => Promise.reject(new Error("List the demo merchants first")) })
		await expect(runSetup(store, stop.ops, () => {})).rejects.toThrow("List")
		expect(Object.keys(current()?.tickets ?? {})).toEqual(["galacticaBind", "supplierBind"])
		const resumed = poisoned()
		await expect(
			runSetup(store, resumed.ops, () => {}),
			"a stored ticket still checks the binding",
		).rejects.toThrow("redeploy")
		expect(resumed.events).toEqual([])
	})

	it("resumes an interrupted setup with its own tag, recovering a deposit sent before the crash instead of repeating it", async () => {
		const { store, current } = memoryStore()
		const crash = fakeOps({
			deposit: async (seed, _tag, _prior, persist) => {
				if (seed !== "bob") return ticketOf(seed)
				persist(draftOf(seed))
				throw new Error("killed while bob's deposit was in flight")
			},
		})
		await expect(runSetup(store, crash.ops, () => {})).rejects.toThrow("in flight")
		const tag = current()?.tag
		expect(Object.keys(current()?.tickets ?? {})).toEqual(["galacticaBind", "supplierBind", "alice"])
		expect(Object.keys(current()?.drafts ?? {})).toEqual(["bob"])

		const priors: (Seed | undefined)[] = []
		const resume = fakeOps({
			deposit: async (seed, _tag, prior) => {
				priors.push(prior && (prior as unknown as { seed: Seed }).seed)
				return ticketOf(seed)
			},
		})
		for (const seed of BIND_SEEDS) resume.bound.add(seed)
		const published: string[] = []
		await runSetup(store, resume.ops, (t) => published.push(t))
		expect(priors).toEqual(["bob", undefined])
		expect(published).toEqual([tag as string])
	})
})
