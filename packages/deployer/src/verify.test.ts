import { describe, expect, it } from "bun:test"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { MerchantEntry } from "@inference-money/bridge-core"
import { type Address, type Hex, type PublicClient, TransactionNotFoundError } from "viem"
import { MANIFEST } from "../../bridge-core/src/test/fixtures"
import type { Check } from "./preflight"
import type { DelayReads, DelayState } from "./token-reads"
import { type CreationWant, createdAsBuilt, creationCheck, delayPolicyChecks, verifyEnvironment } from "./verify"

const DEPLOYER: Address = "0x00000000000000000000000000000000000000d0"
const CREATED: Address = "0x00000000000000000000000000000000000000c0"
const WANT: CreationWant = { deployer: DEPLOYER, input: "0x6080aa", address: CREATED, block: 5n }
const HASH: Hex = `0x${"ab".repeat(32)}`
const TX: { hash: Hex; to: Address | null; from: Address; input: Hex } = { hash: HASH, to: null, from: DEPLOYER, input: "0x6080aa" }
const RECEIPT: { status: "success" | "reverted"; contractAddress: Address; blockNumber: bigint } = {
	status: "success",
	contractAddress: CREATED,
	blockNumber: 5n,
}

describe("creationCheck", () => {
	it("passes the deployer's plain create of the fresh build's init code, at the manifest's address and block", () => {
		expect(creationCheck("c", TX, RECEIPT, WANT)).toEqual({ name: "c", ok: true, detail: HASH })
	})

	it.each<[string, Partial<typeof TX>, Partial<typeof RECEIPT>, string]>([
		["a call through another contract", { to: "0x00000000000000000000000000000000000000f0" }, {}, "not a creation"],
		["another sender", { from: "0x00000000000000000000000000000000000000e0" }, {}, "sent by"],
		["other init code with the same runtime", { input: "0x6080aa00" }, {}, "init code differs"],
		["a reverted create", {}, { status: "reverted" }, "reverted"],
		["another created address", {}, { contractAddress: "0x00000000000000000000000000000000000000c1" }, "created 0x"],
		["a block other than the recorded one", {}, { blockNumber: 6n }, "mined in 6, not 5"],
	])("fails %s, and says what differs", (_, tx, receipt, says) => {
		const c = creationCheck("c", { ...TX, ...tx }, { ...RECEIPT, ...receipt }, WANT)
		expect([c.ok, c.detail]).toEqual([false, expect.stringContaining(says)])
	})
})

describe("createdAsBuilt", () => {
	const unread = {} as PublicClient

	it("warns, and reads nothing, when the manifest records no creation tx", async () => {
		expect(await createdAsBuilt(unread, "portal", undefined, WANT)).toMatchObject({ ok: true, warn: true })
	})

	it("fails a creation tx the endpoint cannot find, naming the flag that picks another endpoint", async () => {
		const pruned = {
			getTransaction: async () => {
				throw new TransactionNotFoundError({ hash: HASH })
			},
			getTransactionReceipt: async () => RECEIPT,
		} as unknown as PublicClient
		const c = await createdAsBuilt(pruned, "portal", HASH, WANT)
		expect([c.ok, c.detail]).toEqual([false, expect.stringContaining("--l1-rpc")])
	})

	const OTHER: Hex = `0x${"cd".repeat(32)}`
	it.each<[string, Hex | undefined, Hex | undefined]>([
		["tx", OTHER, HASH],
		["receipt", HASH, OTHER],
		["tx without a hash, beside a receipt", undefined, OTHER],
		["receipt without a hash", HASH, undefined],
	])("fails a %s the endpoint answers for another hash, though it describes a matching create", async (_, txHash, receiptHash) => {
		const answering = {
			getTransaction: async () => ({ ...TX, hash: txHash }),
			getTransactionReceipt: async () => ({ ...RECEIPT, transactionHash: receiptHash }),
		} as unknown as PublicClient
		const c = await createdAsBuilt(answering, "portal", HASH, WANT)
		expect([c.ok, c.detail]).toEqual([false, `the L1 endpoint answered tx ${txHash} and receipt ${receiptHash} for ${HASH}`])
	})
})

describe("delayPolicyChecks", () => {
	const AT = 1_000n
	const M = "0x0000000000000000000000000000000000000000000000000000000000000a01"
	const SETTLED: MerchantEntry = {
		off: false,
		scheduledOff: false,
		changeAt: 0n,
		delay: 86_400n,
		scheduledDelay: 86_400n,
		delayChangeAt: 0n,
	}
	const reads = (setting: bigint, entry: Partial<MerchantEntry> = {}, guardian: Partial<DelayState> = {}): DelayReads => ({
		setting,
		guardian: { current: setting, scheduled: setting, changeAt: 0n, ...guardian },
		list: { block: 9, at: AT, entries: new Map([[M, { ...SETTLED, ...entry }]]) },
	})
	const verdict = (c: Check | undefined) => c && (c.ok ? (c.warn ? "warn" : "ok") : "fail")
	const judged = (r: DelayReads, pinned: number | undefined, name: string) => {
		const [strict, allowing] = [false, true].map((allow) => delayPolicyChecks(r, pinned, allow).find((c) => c.name === name))
		return { strict: verdict(strict), allowing: verdict(allowing), detail: allowing?.detail }
	}
	const DECREASE = { delay: 86_400n, scheduledDelay: 7200n, delayChangeAt: AT + 500n }
	const LATER = "1970-01-01T00:25:00.000Z"

	it("passes a settled deployment, and fails a setting other than the manifest's with or without the flag", () => {
		expect(delayPolicyChecks(reads(86_400n), 86_400).every((c) => c.ok && !c.warn)).toBe(true)
		expect(judged(reads(7200n), 86_400, "merchant delay setting == manifest")).toMatchObject({ strict: "fail", allowing: "fail" })
	})

	it("prints the guardian slot's pending decrease as ok, with its time, with or without the flag", () => {
		const r = reads(7200n, { scheduledDelay: 7200n }, { current: 86_400n, changeAt: AT + 500n })
		expect(judged(r, 7200, "guardian slot delay change pending")).toEqual({
			strict: "ok",
			allowing: "ok",
			detail: `86400s until ${LATER}, then 7200s`,
		})
	})

	it("fails an entry's pending change to the manifest's delay, which the flag turns into a warning with its time", () => {
		expect(judged(reads(7200n, DECREASE), 7200, `merchant ${M} delay change pending`)).toEqual({
			strict: "fail",
			allowing: "warn",
			detail: `86400s until ${LATER}, then 7200s`,
		})
	})

	it("fails an entry's pending change to any other delay, with or without the flag", () => {
		const r = reads(7200n, { ...DECREASE, scheduledDelay: 3600n })
		expect(judged(r, 7200, `merchant ${M} delay change pending`)).toMatchObject({ strict: "fail", allowing: "fail" })
		expect(judged(r, 7200, `merchant ${M} delay == setting`)).toMatchObject({ strict: "fail", allowing: "fail" })
	})

	it("fails a pending switch, and an entry only marked, strict; the flag warns, saying which", () => {
		const off = judged(reads(86_400n, { scheduledOff: true, changeAt: AT + 500n }), 86_400, `merchant ${M} switch pending`)
		expect(off).toEqual({ strict: "fail", allowing: "warn", detail: `switches off at ${LATER}` })
		const marked = judged(reads(86_400n, { changeAt: AT + 500n }), 86_400, `merchant ${M} switch pending`)
		expect(marked).toEqual({ strict: "fail", allowing: "warn", detail: `marked, no switch at ${LATER}` })
	})

	it("warns on a manifest without the delay, never waives an entry's delay change for it, and still waives a switch", () => {
		expect(judged(reads(7200n), undefined, "merchant delay setting")).toMatchObject({ strict: "warn", allowing: "warn" })
		expect(judged(reads(7200n, DECREASE), undefined, `merchant ${M} delay change pending`)).toMatchObject({ allowing: "fail" })
		const r = reads(86_400n, { scheduledOff: true, changeAt: AT + 500n })
		expect(judged(r, undefined, `merchant ${M} switch pending`)).toMatchObject({ strict: "fail", allowing: "warn" })
	})
})

const publishedEverywhere = { getContract: async () => ({}) } as unknown as AztecNode
const sponsorCheck = async (network: "local" | "testnet") => {
	const m = { ...MANIFEST, network, l2: { ...MANIFEST.l2, sponsoredFpc: undefined } }
	return (await verifyEnvironment(publishedEverywhere, m)).find((c) => c.name === "SponsoredFPC")
}

describe("verifyEnvironment", () => {
	it("fails a manifest with no fee sponsor anywhere but a local network", async () => {
		expect(await sponsorCheck("testnet")).toMatchObject({ ok: false, detail: expect.stringMatching(/fee payer/) })
		expect(await sponsorCheck("local")).toMatchObject({ ok: true })
	})
})
