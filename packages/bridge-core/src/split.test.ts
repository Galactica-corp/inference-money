import { describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, type Log, pad } from "viem"
import { TOKEN_PORTAL_ABI } from "./abi"
import { claim, messageNullifier } from "./claim"
import type { ClaimTicket } from "./deposit"
import type { MerchantEntry, MerchantList } from "./merchants"
import { returnDeposit } from "./return"
import {
	changeOf,
	DENOMINATIONS,
	DenominationError,
	prepareSplitDeposit,
	SPLIT_CONFIRMATIONS,
	type SplitProof,
	SplitProofRefusedError,
	splitClaimOf,
	splitMessageNullifier,
	splitProofOf,
	USDC_UNIT,
	verifySplitDeposit,
} from "./split"
import { splitChangeCommitment, splitSecretHash } from "./split-secret"
import { a, MANIFEST as M } from "./test/fixtures"

const NOW = 1_800_000_000n
const MERCHANT = AztecAddress.fromBigIntUnsafe(0x1234n)
const BUYER = AztecAddress.fromBigIntUnsafe(0xb0bn)
const REF = new Fr(0x5eedn)
const PRICE = 370_000n
const TEN = 10n * USDC_UNIT
const DEPOSITOR = a(0xd0) as Address
const TX = pad("0x7a", { size: 32 })

const on: MerchantEntry = { off: false, scheduledOff: false, changeAt: 0n, delay: undefined, scheduledDelay: undefined, delayChangeAt: 0n }
const listWith = (entries: [AztecAddress, MerchantEntry][]): MerchantList => ({
	block: 7,
	at: NOW,
	entries: new Map(entries.map(([account, e]) => [account.toString(), e])),
})
const LIST = listWith([[MERCHANT, on]])
const intent = { amount: TEN, merchant: MERCHANT, price: PRICE, paymentRef: REF, buyer: BUYER }

async function sentDraft() {
	const d = await prepareSplitDeposit(intent, M, () => NOW, LIST)
	d.l1TxHash = TX
	return d
}

function portalLog(o: { secretHash: Fr; amount?: bigint; address?: Address; index?: bigint }): Log {
	const topics = encodeEventTopics({ abi: TOKEN_PORTAL_ABI, eventName: "DepositToAztecPrivate", args: { depositor: DEPOSITOR } })
	const data = encodeAbiParameters(
		[{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
		[o.amount ?? TEN, o.secretHash.toString() as Hex, pad("0x4e7"), o.index ?? 42n],
	)
	return {
		address: o.address ?? M.l1.portal,
		topics: topics as [Hex, ...Hex[]],
		data,
		blockNumber: 120n,
		blockHash: pad("0xb"),
		transactionHash: TX,
		transactionIndex: 0,
		logIndex: 0,
		removed: false,
	}
}

const l1 = (logs: Log[], tip = 121n, status: "success" | "reverted" = "success") => ({
	getTransactionReceipt: async () => ({ status, logs, blockNumber: 120n }) as never,
	getBlockNumber: async () => tip,
})

describe("prepareSplitDeposit", () => {
	it("commits the terms and a change commitment the merchant cannot open into the deposit's secret hash", async () => {
		const d = await prepareSplitDeposit(intent, M, () => NOW, LIST)
		const s = d.split!
		expect(s.changeCommitment.equals(splitChangeCommitment(BUYER, s.changeSalt))).toBe(true)
		const expected = await splitSecretHash({
			merchant: MERCHANT,
			price: PRICE,
			paymentRef: REF,
			changeCommitment: s.changeCommitment,
			salt: d.secretOrSalt,
		})
		expect(d.secretHash.equals(expected)).toBe(true)
		expect(d.witness).toEqual({ aztecRecipient: pad("0x0"), secretHash: expected.toString() as Hex, isPrivate: true })
		expect(d.typedData.message.permitted.amount).toBe(TEN)
	})

	it("draws fresh salts for every deposit", async () => {
		const [x, y] = await Promise.all([prepareSplitDeposit(intent, M, () => NOW, LIST), prepareSplitDeposit(intent, M, () => NOW, LIST)])
		expect(x.secretOrSalt.equals(y.secretOrSalt)).toBe(false)
		expect(x.split!.changeSalt.equals(y.split!.changeSalt)).toBe(false)
	})

	it("offers exactly the eight fixed amounts", () => {
		expect(DENOMINATIONS.map((d) => d / USDC_UNIT)).toEqual([1n, 5n, 10n, 50n, 100n, 500n, 1000n, 5000n])
	})

	it.each([0n, PRICE, TEN + 1n, 3n * USDC_UNIT])("refuses %p base units, which is no denomination", async (amount) => {
		await expect(prepareSplitDeposit({ ...intent, amount }, M, () => NOW, LIST)).rejects.toBeInstanceOf(DenominationError)
	})

	it.each([0n, TEN + 1n])("refuses a price of %p", async (price) => {
		await expect(prepareSplitDeposit({ ...intent, price }, M, () => NOW, LIST)).rejects.toThrow("The price must be positive")
	})

	it("refuses a merchant that is not one, or whose switch-off is scheduled", async () => {
		await expect(prepareSplitDeposit(intent, M, () => NOW, listWith([]))).rejects.toThrow("is not a merchant")
		const leaving = { ...on, scheduledOff: true, changeAt: NOW + 3600n }
		await expect(prepareSplitDeposit(intent, M, () => NOW, listWith([[MERCHANT, leaving]]))).rejects.toThrow("is not a merchant")
	})
})

describe("verifySplitDeposit", () => {
	const expected = { paymentRef: REF, price: PRICE }

	it("accepts the one portal deposit committing to these terms, once confirmed", async () => {
		const d = await sentDraft()
		const c = await verifySplitDeposit(l1([portalLog({ secretHash: d.secretHash })]), M, MERCHANT, splitProofOf(d), expected)
		expect(c).toMatchObject({ amount: TEN, depositor: DEPOSITOR, leafIndex: 42n, price: PRICE })
		expect(c.merchant.equals(MERCHANT)).toBe(true)
		expect(c.changeCommitment.equals(d.split!.changeCommitment)).toBe(true)
	})

	it("refuses a deposit committing to another merchant", async () => {
		const d = await sentDraft()
		const other = AztecAddress.fromBigIntUnsafe(0x9999n)
		const refused = verifySplitDeposit(l1([portalLog({ secretHash: d.secretHash })]), M, other, splitProofOf(d), expected)
		await expect(refused).rejects.toMatchObject({ reason: "not-found" })
	})

	it("refuses a proof naming another price or reference than the merchant handed out", async () => {
		const d = await sentDraft()
		const logs = [portalLog({ secretHash: d.secretHash })]
		const cheaper: SplitProof = { ...splitProofOf(d), price: "1" }
		await expect(verifySplitDeposit(l1(logs), M, MERCHANT, cheaper, expected)).rejects.toMatchObject({ reason: "malformed" })
		await expect(
			verifySplitDeposit(l1(logs), M, MERCHANT, splitProofOf(d), { ...expected, paymentRef: new Fr(1n) }),
		).rejects.toMatchObject({
			reason: "malformed",
		})
	})

	it("counts only the manifest portal's events", async () => {
		const d = await sentDraft()
		const forged = [portalLog({ secretHash: d.secretHash, address: a(0xbad) as Address })]
		await expect(verifySplitDeposit(l1(forged), M, MERCHANT, splitProofOf(d), expected)).rejects.toMatchObject({ reason: "not-found" })
	})

	it("refuses an ambiguous tx holding two deposits with these terms", async () => {
		const d = await sentDraft()
		const twice = [portalLog({ secretHash: d.secretHash }), portalLog({ secretHash: d.secretHash, index: 43n })]
		await expect(verifySplitDeposit(l1(twice), M, MERCHANT, splitProofOf(d), expected)).rejects.toMatchObject({ reason: "not-found" })
	})

	it("refuses a deposit below the price, a reverted tx and an unconfirmed one", async () => {
		const d = await sentDraft()
		const proof = splitProofOf(d)
		const small = { paymentRef: REF, price: TEN + 1n }
		await expect(
			verifySplitDeposit(
				l1([portalLog({ secretHash: await splitSecretHash({ ...d.split!, price: TEN + 1n, salt: d.secretOrSalt }) })]),
				M,
				MERCHANT,
				{ ...proof, price: (TEN + 1n).toString() },
				small,
			),
		).rejects.toMatchObject({ reason: "underpaid" })
		await expect(verifySplitDeposit(l1([], 121n, "reverted"), M, MERCHANT, proof, expected)).rejects.toMatchObject({
			reason: "not-found",
		})
		const shallow = l1([portalLog({ secretHash: d.secretHash })], 120n + BigInt(SPLIT_CONFIRMATIONS) - 2n)
		await expect(verifySplitDeposit(shallow, M, MERCHANT, proof, expected)).rejects.toBeInstanceOf(SplitProofRefusedError)
		await expect(verifySplitDeposit(shallow, M, MERCHANT, proof, expected)).rejects.toMatchObject({ reason: "unconfirmed" })
	})
})

describe("a split deposit's ticket", () => {
	const ticket = async (): Promise<ClaimTicket> => ({
		draft: await sentDraft(),
		messageHash: pad("0x4e7"),
		leafIndex: 42n,
		depositor: DEPOSITOR,
	})

	it("owes the deposit less the price as change, and none when the price takes it all", async () => {
		const t = await ticket()
		expect(changeOf(t)?.amount).toBe(TEN - PRICE)
		t.draft.split!.price = TEN
		expect(changeOf(t)).toBeUndefined()
	})

	it("is refused by the plain claim and return, and its nullifier is the split one", async () => {
		const t = await ticket()
		const refusal = "This is a split deposit"
		await expect(claim(t, {} as never, {} as never, M, { from: BUYER })).rejects.toThrow(refusal)
		await expect(returnDeposit(t, {} as never, {} as never, M, { from: BUYER })).rejects.toThrow(refusal)
		expect((await messageNullifier(t, M)).equals(await splitMessageNullifier(splitClaimOf(t), M))).toBe(true)
	})
})
