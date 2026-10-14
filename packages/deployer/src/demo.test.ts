import { describe, expect, it } from "bun:test"
import { type ClaimTicket, type DepositDraft, encodeTicket } from "@inference-money/bridge-core"
import { castMember } from "@inference-money/demo"
import { MANIFEST } from "../../bridge-core/src/test/fixtures"
import { BIND_SEEDS, keptSalt, type PlanStore, runSetup, type Seed, type SetupKeys, type SetupOps, type SetupPlan } from "./demo"

const SALT = `0x${"1f".repeat(32)}`
const SALTED = /^0x[0-9a-f]{64}$/

const memoryStore = () => {
	let plan: SetupPlan | undefined
	const kept = { abandoned: [] as DepositDraft[], archived: new Map<string, SetupPlan>() }
	const store: PlanStore = {
		read: () => (plan ? structuredClone(plan) : undefined),
		write: (p) => {
			plan = structuredClone(p)
		},
		abandon: (d) => {
			kept.abandoned.push(d)
		},
		archive: (tag) => {
			if (plan) kept.archived.set(tag, plan)
			plan = undefined
		},
	}
	return { store, current: () => plan, kept }
}

const draftOf = (seed: Seed) => ({ intent: { amount: 1n, kind: "private" }, seed }) as unknown as DepositDraft
const ticketOf = (seed: Seed) => ({ draft: draftOf(seed), messageHash: "0x01", leafIndex: 0n, depositor: "0x02" }) as unknown as ClaimTicket
const seedOf = (t: ClaimTicket) => (t.draft as unknown as { seed: Seed }).seed
const isBind = (seed: Seed) => (BIND_SEEDS as readonly Seed[]).includes(seed)

/** Each step in `events`, in order; a merchant's binding claim binds it, and the merchants are listed once `listed`. */
function fakeOps(over: Partial<SetupOps> & { finality?: SetupOps["final"]["finality"] } = {}) {
	const events: string[] = []
	const calls = { claims: [] as Seed[], reclaims: [] as Seed[], prepared: [] as SetupKeys[] }
	const bound = new Set<Seed>()
	const ops: SetupOps = {
		prepare: async (keys) => {
			calls.prepared.push(keys)
		},
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
	it("publishes the users' tag and the merchants' salt and archives the secrets only once every claim is finalized, re-claiming a pruned one first", async () => {
		const { store, current, kept } = memoryStore()
		const floatFinal = Promise.withResolvers<"finalized">()
		const floatAnswers: Promise<"finalized" | "dropped">[] = [Promise.resolve("dropped"), floatFinal.promise]
		let asked = 0
		const finality = async (t: ClaimTicket) => {
			if (seedOf(t) !== "galactica") return "finalized" as const
			asked++
			return floatAnswers.shift() as Promise<"finalized" | "dropped">
		}
		const { ops, calls } = fakeOps({ finality })
		const published: SetupKeys[] = []
		const run = runSetup(store, ops, (keys) => published.push(keys))

		while (asked < 2) await Bun.sleep(1)
		expect(published).toEqual([])
		expect(calls.reclaims).toEqual(["galactica"])
		expect(current()?.tag).toMatch(/^[0-9a-f]{32}$/)
		expect(current()?.merchantsSalt).toMatch(SALTED)

		floatFinal.resolve("finalized")
		await run
		expect(calls.claims).toEqual(["galacticaBind", "supplierBind", "alice", "bob", "galactica"])
		expect(published).toEqual(calls.prepared)
		expect(published[0]?.merchantsSalt).toMatch(SALTED)
		expect(current(), "nothing left for a resume").toBeUndefined()
		expect(Object.keys(kept.archived.get(published[0]?.usersTag as string)?.tickets ?? {})).toHaveLength(5)
	})

	it("keeps a stored draft the reader calls never sent before depositing that seed anew", async () => {
		const { store, kept } = memoryStore()
		const tag = "a".repeat(32)
		store.write({ tag, merchantsSalt: SALT, drafts: { galacticaBind: encodeTicket("draft", draftOf("galacticaBind")) }, tickets: {} })
		const { ops } = fakeOps({
			deposit: async (seed, _tag, prior) => {
				prior?.abandon()
				return ticketOf(seed)
			},
		})
		await runSetup(store, ops, () => {})
		expect(kept.abandoned).toEqual([draftOf("galacticaBind")])
		expect(kept.archived.get(tag)?.drafts).toEqual({})
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
		const published: SetupKeys[] = []
		await runSetup(store, resume.ops, (keys) => published.push(keys))
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

	it("resumes an interrupted setup with its own tag and salt, recovering a deposit sent before the crash instead of repeating it", async () => {
		const { store, current } = memoryStore()
		const crash = fakeOps({
			deposit: async (seed, _tag, _prior, persist) => {
				if (seed !== "bob") return ticketOf(seed)
				persist(draftOf(seed))
				throw new Error("killed while bob's deposit was in flight")
			},
		})
		await expect(runSetup(store, crash.ops, () => {})).rejects.toThrow("in flight")
		const drawn = { usersTag: current()?.tag, merchantsSalt: current()?.merchantsSalt }
		expect(Object.keys(current()?.tickets ?? {})).toEqual(["galacticaBind", "supplierBind", "alice"])
		expect(Object.keys(current()?.drafts ?? {})).toEqual(["bob"])

		const priors: (Seed | undefined)[] = []
		const resume = fakeOps({
			deposit: async (seed, _tag, prior) => {
				priors.push(prior && (prior.draft as unknown as { seed: Seed }).seed)
				return ticketOf(seed)
			},
		})
		for (const seed of BIND_SEEDS) resume.bound.add(seed)
		const published: SetupKeys[] = []
		await runSetup(store, resume.ops, (keys) => published.push(keys), `0x${"2e".repeat(32)}`)
		expect(priors).toEqual(["bob", undefined])
		expect(resume.calls.prepared, "a stored plan's salt wins over a handed-over one").toEqual([drawn as SetupKeys])
		expect(published).toEqual([drawn as SetupKeys])
	})

	it("rotates to a new users' tag that keeps a published salt, so the merchants stay the demo's, and refuses a version-1 demo", async () => {
		const before = { usersTag: "b".repeat(32), merchantsSalt: SALT }
		const { store } = memoryStore()
		const { ops, calls } = fakeOps()
		const published: SetupKeys[] = []
		await runSetup(store, ops, (keys) => published.push(keys), keptSalt({ version: 2, bridge: MANIFEST.l2.bridge.address, ...before }))
		const after = published[0] as SetupKeys
		expect(calls.prepared).toEqual([after])
		expect(after.usersTag).not.toBe(before.usersTag)
		expect(castMember(MANIFEST, "galactica", after)).toEqual(castMember(MANIFEST, "galactica", before))
		expect(castMember(MANIFEST, "supplier", after)).toEqual(castMember(MANIFEST, "supplier", before))
		expect(castMember(MANIFEST, "alice", after)).not.toEqual(castMember(MANIFEST, "alice", before))
		expect(() => keptSalt({ version: 1, bridge: MANIFEST.l2.bridge.address, usersTag: before.usersTag })).toThrow("redeploy")
		expect(keptSalt(undefined), "a first setup draws its own").toBeUndefined()
	})
})
