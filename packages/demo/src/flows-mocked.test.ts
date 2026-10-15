import { describe, expect, it, mock } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import * as core from "@galactica-net/inference-money-core"

/** Every Permit2 approval castDeposit asked for; nothing past it runs, since the signer cannot read a block. */
const approvals: bigint[] = []
/** The private recipient's funding address; none until its first claim. */
let bound: `0x${string}` | undefined
/** The tip each claim read asked for, the wait each claim was given, and the consent its wait and claim each got. */
const reads: string[] = []
const claimWaits: unknown[] = []
const consents: unknown[] = []
const ONE = "0x0000000000000000000000000000000000000001"
/** castDeposit past its approval: the reader's verdict on a prior draft, and each step taken, in order. */
const flow = { verdict: "not-deposited" as unknown, events: [] as string[] }
mock.module("@galactica-net/inference-money-core", () => ({
	...core,
	syncMerchantList: async () => ({ block: 1, at: 0n, entries: new Map() }),
	fundingAddress: async () => bound,
	ensurePermit2Allowance: async (a: { needed: bigint }) => {
		approvals.push(a.needed)
		flow.events.push("approve")
	},
	reconcileDeposit: async () => flow.verdict,
	prepareDeposit: async () => ({}),
	submitDeposit: async (d: { l1TxHash?: string }, _l1: unknown, _m: unknown, _n: unknown, on?: (stage: string) => void) => {
		on?.("depositing")
		flow.events.push("send")
		d.l1TxHash = "0x7e"
		return d.l1TxHash
	},
	confirmDeposit: async (d: unknown) => ({ draft: d }),
	isClaimConsumed: async (_t: unknown, _n: unknown, _m: unknown, at: string) => {
		reads.push(at)
		return false
	},
	waitClaimable: async (...args: unknown[]) => {
		consents.push((args[6] as { allowBind?: boolean }).allowBind)
	},
	claim: async (_t: unknown, _n: unknown, _w: unknown, _m: unknown, opts: { wait: unknown; allowBind?: boolean }) => {
		claimWaits.push(opts.wait)
		consents.push(opts.allowBind)
		return "claimed"
	},
	sponsoredPayment: () => undefined,
	transferPrivate: async () => TxHash.random(),
}))
const { castClaim, castDeposit, sendPrivate } = await import("./flows")

describe("castDeposit", () => {
	it("refuses a deposit that could only be returned before any approval, and lets one the recipient can claim on", async () => {
		const signer = {
			account: { address: "0x0000000000000000000000000000000000000001" },
			publicClient: {
				getBlock: () => Promise.reject(new Error("past the approval")),
			},
		} as never
		const s = { m: { l2: { token: { address: AztecAddress.ZERO.toString() } } }, node: {} } as never
		const to = await AztecAddress.random()
		const plan = (kind: "public" | "private") => ({ from: "alice", to, kind, amount: 5n }) as const
		await expect(castDeposit(s, signer, plan("public"), undefined, () => {})).rejects.toBeInstanceOf(core.PublicDepositToUserError)
		bound = "0x0000000000000000000000000000000000000002"
		await expect(castDeposit(s, signer, plan("private"), undefined, () => {})).rejects.toBeInstanceOf(core.NotFundingAddressError)
		expect(approvals).toEqual([])
		bound = undefined
		await expect(castDeposit(s, signer, plan("private"), undefined, () => {})).rejects.toThrow("past the approval")
		bound = "0x0000000000000000000000000000000000000001"
		await expect(castDeposit(s, signer, plan("private"), undefined, () => {})).rejects.toThrow("past the approval")
		expect(approvals).toEqual([5n, 5n])
	})

	it("keeps a prior the reader calls never sent before it deposits anew, and stores the new draft again with its hash", async () => {
		const signer = { account: { address: ONE }, publicClient: { getBlock: async () => ({ timestamp: 1n }) } } as never
		const s = { m: { l2: { token: { address: AztecAddress.ZERO.toString() } } }, node: {} } as never
		const plan = { from: "alice", to: await AztecAddress.random(), kind: "private", amount: 5n } as const
		const persist = (d: { l1TxHash?: string }) => flow.events.push(`persist ${d.l1TxHash ?? "unsent"}`)
		const prior = (abandon: () => void) => ({ draft: {} as never, abandon })
		bound = ONE
		flow.events = []
		await castDeposit(
			s,
			signer,
			plan,
			prior(() => flow.events.push("abandon")),
			persist,
		)
		expect(flow.events).toEqual(["abandon", "approve", "persist unsent", "send", "persist 0x7e"])

		flow.events = []
		const disk = () => {
			throw new Error("disk full")
		}
		await expect(castDeposit(s, signer, plan, prior(disk), persist)).rejects.toThrow("disk full")
		const ticket = { messageHash: "0x01" }
		flow.verdict = ticket
		expect(await castDeposit(s, signer, plan, prior(disk), persist)).toBe(ticket as never)
		expect(flow.events, "nothing approved, stored or sent past an unkept or a found prior").toEqual([])
		flow.verdict = "not-deposited"
		bound = undefined
	})
})

describe("castClaim and sendPrivate", () => {
	it("read and wait at the session's tip: the proposed block when it asks for one, a checkpoint otherwise", async () => {
		const to = await AztecAddress.random()
		const t = { draft: { intent: { recipient: to } } } as never
		const proposed = {
			getTxReceipt: async () => ({
				status: TxStatus.PROPOSED,
				isPending: () => false,
				isDropped: () => false,
				isMined: () => true,
				hasExecutionSucceeded: () => true,
			}),
		}
		const session = (wait?: core.L2Wait) =>
			({ m: { l2: { token: { address: to.toString() } } }, node: proposed, wallet: {}, wait }) as never
		expect(await castClaim(session(core.L2_PROPOSED), t)).toBe("claimed")
		await castClaim(session(), t, undefined, { allowBind: true })
		expect(reads).toEqual(["proposed", "checkpointed"])
		expect(claimWaits).toEqual([core.L2_PROPOSED, core.L2_DONE])
		expect(consents, "forwarded to the wait and the claim, never defaulted").toEqual([undefined, undefined, true, true])
		// A checkpoint wait never returns here: the receipt stays proposed.
		expect(await sendPrivate(session(core.L2_PROPOSED), to, to, 1n)).toBeInstanceOf(TxHash)
	})
})
