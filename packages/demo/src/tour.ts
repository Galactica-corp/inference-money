import type { BridgeManifest } from "@galactica-net/inference-money-core"
import { z } from "zod"
import { ACTORS } from "./actors"

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x address")
const field = z.string().regex(/^0x[0-9a-f]{64}$/, "expected a 32-byte lowercase 0x hex value")
const uint = z.number().int().nonnegative()

/** Who acts in a step: a cast member, or A_demo / B_demo, alice's and bob's Ethereum accounts. */
export const TOUR_ACTORS = [...ACTORS, "A_demo", "B_demo"] as const

/** The acceptance run's steps in order: `smoke --record` writes one entry for each, and the showcase plays them. */
export const TOUR_STEPS = ["deposit", "claim", "request", "pay", "refund", "transfer-refused", "exit-refused", "exit", "withdraw"] as const
export type TourStepId = (typeof TOUR_STEPS)[number]

/** One line of "what the world sees": an actual public field, or something the chain keeps hidden. */
export const worldItemSchema = z.strictObject({
	chain: z.enum(["ethereum", "aztec"]),
	label: z.string().min(1),
	value: z.string().optional(),
	visibility: z.enum(["readable", "hidden"]),
})
export type WorldItem = z.infer<typeof worldItemSchema>

export const tourStepSchema = z.strictObject({
	id: z.enum(TOUR_STEPS),
	actor: z.enum(TOUR_ACTORS),
	action: z.enum(["deposit", "claim", "request", "pay", "refund", "transfer", "exit", "withdraw"]),
	to: z.string().min(1),
	/** Base units (6 decimals), as a decimal string. */
	amount: z.string().regex(/^\d+$/),
	verdict: z.enum(["settled", "refused"]),
	/** The refusal's rule id (`BRIDGE_REFUSALS` or `TOKEN_REFUSALS`), on a refused step only. */
	rule: z.string().optional(),
	l1: z.strictObject({ txHash: z.string().regex(/^0x[0-9a-f]{64}$/), block: uint }).optional(),
	l2: z.strictObject({ txHash: field, block: uint, expiration: uint }).optional(),
	world: z.array(worldItemSchema),
})
export type TourStep = z.infer<typeof tourStepSchema>

/** `deployments/testnet-tour.json`: one recorded acceptance run, replayed by the showcase when it cannot act live. */
export const tourSchema = z
	.strictObject({
		version: z.literal(1),
		network: z.strictObject({ l1ChainId: uint.positive(), rollupVersion: uint.positive() }),
		contracts: z.strictObject({ portal: evmAddress, router: evmAddress, token: field, bridge: field }),
		steps: z.array(tourStepSchema),
	})
	.superRefine((t, ctx) => {
		if (t.steps.map((s) => s.id).join() !== TOUR_STEPS.join()) {
			ctx.addIssue({
				code: "custom",
				path: ["steps"],
				message: `the steps are the acceptance run's, in order: ${TOUR_STEPS.join(", ")}`,
			})
		}
		t.steps.forEach((s, i) => {
			if ((s.verdict === "refused") !== (s.rule !== undefined)) {
				ctx.addIssue({ code: "custom", path: ["steps", i, "rule"], message: "a refused step names its rule; a settled one none" })
			}
		})
	})
export type Tour = z.infer<typeof tourSchema>

export function parseTour(raw: unknown): Tour {
	const r = tourSchema.safeParse(raw)
	if (!r.success) throw new Error(`tour failed validation: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
	return r.data
}

/** The tour's identity against a manifest: the same chains and the same four contracts, or the mismatches. */
export function tourMismatches(t: Tour, m: BridgeManifest): string[] {
	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
	const pairs: [string, string | number, string | number][] = [
		["network.l1ChainId", t.network.l1ChainId, m.l1.chainId],
		["network.rollupVersion", t.network.rollupVersion, m.l2.rollupVersion],
		["contracts.portal", t.contracts.portal, m.l1.portal],
		["contracts.router", t.contracts.router, m.l1.router],
		["contracts.token", t.contracts.token, m.l2.token.address],
		["contracts.bridge", t.contracts.bridge, m.l2.bridge.address],
	]
	return pairs.filter(([, a, b]) => !same(String(a), String(b))).map(([name, a, b]) => `${name} ${a} (manifest ${b})`)
}

/** The tour header a recording of this deployment starts from. */
export const tourHeader = (m: BridgeManifest): Omit<Tour, "steps"> => ({
	version: 1,
	network: { l1ChainId: m.l1.chainId, rollupVersion: m.l2.rollupVersion },
	contracts: { portal: m.l1.portal, router: m.l1.router, token: m.l2.token.address, bridge: m.l2.bridge.address },
})
