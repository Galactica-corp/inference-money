import { describe, expect, it } from "bun:test"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { tokenArtifact } from "@galactica-net/inference-money-core"
import { MANIFEST } from "../../bridge-core/src/test/fixtures"
import { parseTour, TOUR_STEPS, type TourStep, type TourStepId, tourHeader, tourMismatches } from "./tour"
import { aztecWorld, ethereumWorld } from "./world-view"

const REFUSED: Partial<Record<TourStepId, string>> = { "transfer-refused": "transfer", "exit-refused": "exitDestination" }

/** A whole acceptance run, each step overridable. */
const steps = (o: Partial<Record<TourStepId, Record<string, unknown>>> = {}): TourStep[] =>
	TOUR_STEPS.map((id) => ({
		id,
		actor: "alice",
		action: "transfer",
		to: "bob",
		amount: "1000000",
		verdict: REFUSED[id] ? "refused" : "settled",
		...(REFUSED[id] ? { rule: REFUSED[id] } : {}),
		world: [],
		...o[id],
	})) as TourStep[]

describe("tour", () => {
	it("validates a recording and checks it belongs to the manifest's deployment", () => {
		const tour = parseTour({ ...tourHeader(MANIFEST), steps: steps() })
		expect(tourMismatches(tour, MANIFEST)).toEqual([])
		const elsewhere = { ...MANIFEST, l2: { ...MANIFEST.l2, bridge: { ...MANIFEST.l2.bridge, address: MANIFEST.l2.proxy.address } } }
		expect(tourMismatches(tour, elsewhere)).toEqual([
			`contracts.bridge ${MANIFEST.l2.bridge.address} (manifest ${MANIFEST.l2.proxy.address})`,
		])
	})

	it("refuses unknown fields, a refused step without its rule, a settled step with one, and any other run", () => {
		const header = tourHeader(MANIFEST)
		expect(() => parseTour({ ...header, steps: steps({ "transfer-refused": { rule: undefined } }) })).toThrow("names its rule")
		expect(() => parseTour({ ...header, steps: steps({ deposit: { rule: "transfer" } }) })).toThrow("names its rule")
		expect(() => parseTour({ ...header, steps: steps({ claim: { secret: "0x1" } }) })).toThrow()
		expect(() => parseTour({ ...header, steps: steps().slice(1) })).toThrow("the acceptance run's, in order")
		expect(() => parseTour({ ...header, steps: steps().reverse() })).toThrow("the acceptance run's, in order")
	})
})

describe("world view", () => {
	it("shows counts, named public writes, a completed payment's amount, the payer and the expiry, and only labels what stays hidden", () => {
		const supply = { leafSlot: new Fr(7), label: "USDC total supply" }
		const slot = tokenArtifact.storageLayout.private_balances?.slot as Fr
		const encrypted = { fields: Array.from({ length: 16 }, (_, i) => new Fr(i + 1)), emittedLength: 16 }
		// The completion log of a payment on testnet (the recorded tour's pay tx): tag, balances slot, 10 USDC.
		const completion = { fields: [new Fr(3), slot, new Fr(10_000_000), ...Array(13).fill(Fr.ZERO)], emittedLength: 3 }
		const effect = {
			transactionFee: new Fr(5),
			noteHashes: [1, 2],
			nullifiers: [1, 2, 3],
			l2ToL1Msgs: [1],
			privateLogs: [encrypted, completion],
			publicLogs: [],
			publicDataWrites: [
				{ leafSlot: new Fr(7), value: new Fr(1_000_000) },
				{ leafSlot: new Fr(8), value: new Fr(1) },
			],
		}
		const world = aztecWorld(effect, { feePayer: "0xfee", expiresAt: 99n }, [supply], ["sender", "amount"])
		expect(world).toContainEqual({ chain: "aztec", label: "USDC total supply", value: "1000000", visibility: "readable" })
		expect(world).toContainEqual({ chain: "aztec", label: "other public writes", value: "1", visibility: "readable" })
		expect(world).toContainEqual({ chain: "aztec", label: "messages to Ethereum", value: "1", visibility: "readable" })
		expect(world).toContainEqual({ chain: "aztec", label: "encrypted logs", value: "1", visibility: "readable" })
		expect(world).toContainEqual({ chain: "aztec", label: "amount", value: "10000000", visibility: "readable" })
		expect(world.filter((w) => w.visibility === "hidden")).toEqual([
			{ chain: "aztec", label: "sender", visibility: "hidden" },
			{ chain: "aztec", label: "amount", visibility: "hidden" },
		])
		expect(ethereumWorld([["depositor", "0xA"]])).toEqual([
			{ chain: "ethereum", label: "depositor", value: "0xA", visibility: "readable" },
		])
	})
})
