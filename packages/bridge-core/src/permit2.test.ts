import { describe, expect, it } from "bun:test"
import { type Address, domainSeparator, getAddress, type Hex, hashTypedData, pad } from "viem"
import {
	DEPOSIT_PERMIT_TYPES,
	DEPOSIT_WITNESS_TYPE,
	DEPOSIT_WITNESS_TYPEHASH,
	type DepositPermit,
	type DepositWitness,
	depositPermitTypedData,
	ensurePermit2Allowance,
	hashDepositWitness,
	PERMIT_DEADLINE_SECONDS,
} from "./permit2"

// The literals of contracts/evm/test/WitnessHash.t.sol, computed there independently with `cast`.
const TYPEHASH = "0x5676d1bb485b72587e53291dacdbc15a10cc4eedbfd053b48bdad670cfd28e76"
const WITNESS_PUBLIC = "0xf0c082e1a17894595ba224fea1dba89d9049398a98100c74ad85b4f0a3daa037"
const WITNESS_PRIVATE = "0x5b14eb81e077a6bd008a7df9f4dfce6cad8ec55bddfb64cc42da98179685fbaa"
const SEPOLIA_PERMIT2_DOMAIN = "0x94c1dec87927751697bfc9ebf6fc4ca506bed30308b518f0e9d6c5f74bbafdb8"
const DIGEST_PUBLIC = "0x17ea9ea7bf5e727ebf675ad104f7c747c08bde28d6bc0e36e1d466a6b3d254e2"

const RECIPIENT = pad("0x1234")
const SECRET_HASH = pad("0x5ec7e7")
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
const USDC: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
const OTHER = getAddress("0x000000000000000000000000000000000000beef")

const base: { chainId: number; permit2: Address; permit: DepositPermit; witness: DepositWitness } = {
	chainId: 11_155_111,
	permit2: PERMIT2,
	permit: {
		token: USDC,
		amount: 1_000_000n,
		spender: getAddress("0x00000000000000000000000000000000000000a0"),
		nonce: 7n,
		deadline: 1_800_000_000n,
	},
	witness: { aztecRecipient: RECIPIENT, secretHash: SECRET_HASH, isPrivate: false },
}

const digest = (c: typeof base): Hex => hashTypedData(depositPermitTypedData(c.permit, c.witness, c.permit2, c.chainId))

describe("Permit2 deposit witness (pinned to the router)", () => {
	it("type string, typehash and struct members agree", () => {
		expect(DEPOSIT_WITNESS_TYPEHASH).toBe(TYPEHASH)
		const members = DEPOSIT_WITNESS_TYPE.slice("DepositWitness(".length, -1)
			.split(",")
			.map((f) => {
				const [type, name] = f.split(" ")
				return { name, type }
			})
		expect(members).toEqual([...DEPOSIT_PERMIT_TYPES.DepositWitness])
	})

	it("witness hashes and the full digest equal the Solidity vectors", () => {
		expect(hashDepositWitness(base.witness)).toBe(WITNESS_PUBLIC)
		expect(hashDepositWitness({ aztecRecipient: pad("0x0"), secretHash: SECRET_HASH, isPrivate: true })).toBe(WITNESS_PRIVATE)
		expect(domainSeparator({ domain: { name: "Permit2", chainId: base.chainId, verifyingContract: PERMIT2 } })).toBe(
			SEPOLIA_PERMIT2_DOMAIN,
		)
		expect(digest(base)).toBe(DIGEST_PUBLIC)
	})

	const mutations: [string, (c: typeof base) => typeof base][] = [
		["chain id", (c) => ({ ...c, chainId: 1 })],
		["Permit2 address", (c) => ({ ...c, permit2: OTHER })],
		["token", (c) => ({ ...c, permit: { ...c.permit, token: OTHER } })],
		["amount", (c) => ({ ...c, permit: { ...c.permit, amount: c.permit.amount + 1n } })],
		["spender", (c) => ({ ...c, permit: { ...c.permit, spender: OTHER } })],
		["nonce", (c) => ({ ...c, permit: { ...c.permit, nonce: c.permit.nonce + 1n } })],
		["deadline", (c) => ({ ...c, permit: { ...c.permit, deadline: c.permit.deadline + 1n } })],
		["recipient", (c) => ({ ...c, witness: { ...c.witness, aztecRecipient: pad(OTHER) } })],
		["secret hash", (c) => ({ ...c, witness: { ...c.witness, secretHash: pad(OTHER) } })],
		["public/private", (c) => ({ ...c, witness: { ...c.witness, isPrivate: true } })],
	]
	it.each(mutations)("the %s is bound by the signature", (_, mutate) => {
		expect(digest(mutate(base))).not.toBe(DIGEST_PUBLIC)
	})

	it("the deadline window is bounded", () => {
		expect(PERMIT_DEADLINE_SECONDS).toBeGreaterThanOrEqual(60n)
		expect(PERMIT_DEADLINE_SECONDS).toBeLessThanOrEqual(1800n)
	})
})

describe("ensurePermit2Allowance", () => {
	const HASH: Hex = "0xabc"

	it("sends nothing when the allowance suffices", async () => {
		let approvals = 0
		const r = await ensurePermit2Allowance({
			allowance: async () => 100n,
			approveMax: async () => {
				approvals++
				return HASH
			},
			waitReceipt: async () => ({ status: "success" }),
			needed: 50n,
		})
		expect(r).toEqual({ approved: false })
		expect(approvals).toBe(0)
	})

	it("approves, waits and re-reads", async () => {
		const reads = [0n, 2n ** 256n - 1n]
		const statuses: string[] = []
		const r = await ensurePermit2Allowance({
			allowance: async () => reads.shift() ?? 0n,
			approveMax: async () => HASH,
			waitReceipt: async () => ({ status: "success" }),
			needed: 50n,
			onStatus: (s) => statuses.push(s),
		})
		expect(r).toEqual({ approved: true, txHash: HASH })
		expect(statuses).toEqual(["approving", "waiting", "approved"])
	})

	it("reads a short allowance back again after the receipt before it counts", async () => {
		const reads = [0n, 0n, 0n, 50n]
		const waits: number[] = []
		const r = await ensurePermit2Allowance({
			allowance: async () => reads.shift() ?? 0n,
			approveMax: async () => HASH,
			waitReceipt: async () => ({ status: "success" }),
			needed: 50n,
			readBack: { waitMs: async (ms) => void waits.push(ms) },
		})
		expect(r).toEqual({ approved: true, txHash: HASH })
		expect(waits).toEqual([2_000, 2_000])
	})

	it("fails closed on a reverted approval and on an allowance still short after every read-back", async () => {
		let reads = 0
		const deps = {
			allowance: async () => {
				reads++
				return 0n
			},
			approveMax: async () => HASH,
			needed: 1n,
			readBack: { waitMs: async () => {} },
		}
		await expect(ensurePermit2Allowance({ ...deps, waitReceipt: async () => ({ status: "reverted" }) })).rejects.toThrow(/reverted/)
		reads = 0
		await expect(ensurePermit2Allowance({ ...deps, waitReceipt: async () => ({ status: "success" }) })).rejects.toThrow(/still short/)
		expect(reads).toBe(1 + 15)
	})
})
