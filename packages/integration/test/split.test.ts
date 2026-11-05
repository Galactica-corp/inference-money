import { beforeAll, describe, expect, it } from "bun:test"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import {
	type ClaimTicket,
	changeOf,
	changeState,
	claimChange,
	claimSplit,
	confirmDeposit,
	DENOMINATIONS,
	type L1Ctx,
	type MerchantList,
	NotFundingAddressError,
	newPaymentRef,
	prepareSplitDeposit,
	returnChange,
	returnSplit,
	type SplitChange,
	type SplitClaim,
	splitProofOf,
	submitDeposit,
	verifySplitDeposit,
	waitSplitClaimable,
} from "@galactica-net/inference-money-core"
import { funded, l1Actor, l1Now, l2Actor, l2Balances, merchantActor, openBooks, totalSupply, USDC } from "./actors"
import { harness, INTEGRATION } from "./harness"
import { merchantList } from "./token"

const TEN = DENOMINATIONS[2]!
const PRICE = 370_000n

/** Prepares, signs and sends a split deposit from `l1`, and returns its confirmed ticket. */
async function splitDeposit(
	l1: L1Ctx,
	merchant: AztecAddress,
	buyer: AztecAddress,
	paymentRef: Fr,
	list?: MerchantList,
): Promise<ClaimTicket> {
	const { manifest: m, node } = harness()
	const d = await prepareSplitDeposit(
		{ amount: TEN, merchant, price: PRICE, paymentRef, buyer },
		m,
		await l1Now(),
		list ?? (await merchantList()),
	)
	await submitDeposit(d, l1, m, node)
	return confirmDeposit(d, l1, m)
}

/** What the merchant does with the buyer's proof: check it on L1 (two blocks deep), then claim once it can. */
async function verified(t: ClaimTicket, merchant: AztecAddress, paymentRef: Fr): Promise<SplitClaim> {
	const { manifest: m, l1 } = harness()
	await l1.test.mine({ blocks: 1 })
	return verifySplitDeposit(l1.publicClient, m, merchant, splitProofOf(t.draft), { paymentRef, price: PRICE })
}

async function claimed(c: SplitClaim, from: AztecAddress): Promise<void> {
	const { manifest: m, node, wallet } = harness()
	await waitSplitClaimable(c, node, wallet, m, from, undefined, { pollMs: 1_000, attempts: 600 })
	expect(await claimSplit(c, node, wallet, m, { from })).toBe("claimed")
}

const changeOwed = (t: ClaimTicket): SplitChange => {
	const ch = changeOf(t)
	if (!ch) throw new Error("the deposit owes no change")
	return ch
}

describe.skipIf(!INTEGRATION)("[A33] split deposits: one L1 deposit pays a merchant and leaves change", () => {
	let l1: L1Ctx
	let merchant: AztecAddress
	let buyer: AztecAddress

	beforeAll(async () => {
		l1 = await l1Actor(10_000n * USDC)
		;[merchant, buyer] = await Promise.all([merchantActor(), l2Actor()])
	}, 900_000)

	it("the merchant verifies the deposit on L1 and claims the price; the buyer collects the change; the books balance", async () => {
		const { manifest: m, node, wallet } = harness()
		const books = await openBooks()
		const ref = newPaymentRef()
		const t = books.deposit(await splitDeposit(l1, merchant, buyer, ref))
		const c = await verified(t, merchant, ref)
		expect(c.amount).toBe(TEN)
		expect(c.depositor.toLowerCase()).toBe(l1.account.toLowerCase())

		const before = await l2Balances(merchant)
		const supply = await totalSupply()
		await claimed(c, merchant)
		expect((await l2Balances(merchant)).private).toBe(before.private + PRICE)
		// The whole deposit is counted from the split claim on; the change is owed, not yet held.
		expect(await totalSupply()).toBe(supply + TEN)
		const ch = changeOwed(t)
		expect(ch.amount).toBe(TEN - PRICE)
		expect(await changeState(ch, node, m)).toBe("owed")

		await claimChange(ch, node, wallet, m, { allowBind: true })
		expect((await l2Balances(buyer)).private).toBe(TEN - PRICE)
		expect(await totalSupply()).toBe(supply + TEN)
		expect(await changeState(ch, node, m)).toBe("settled")
		await books.settle()
	}, 900_000)

	it("anyone holding the terms (the buyer here) can claim for an absent merchant; the price still lands with it", async () => {
		const ref = newPaymentRef()
		const t = await splitDeposit(l1, merchant, buyer, ref)
		const before = (await l2Balances(merchant)).private
		await claimed(await verified(t, merchant, ref), buyer)
		expect((await l2Balances(merchant)).private).toBe(before + PRICE)
		const { manifest: m, node, wallet } = harness()
		await claimChange(changeOwed(t), node, wallet, m, { allowBind: true })
	}, 900_000)

	it("a merchant refuses the proof before it is confirmed, for another merchant, and at another price", async () => {
		const { manifest: m, l1: chain } = harness()
		const ref = newPaymentRef()
		const t = await splitDeposit(l1, merchant, buyer, ref)
		const proof = splitProofOf(t.draft)
		await expect(
			verifySplitDeposit(chain.publicClient, m, merchant, proof, { paymentRef: ref, price: PRICE }, { confirmations: 100 }),
		).rejects.toMatchObject({
			reason: "unconfirmed",
		})
		const other = await l2Actor()
		await expect(
			verifySplitDeposit(chain.publicClient, m, other, proof, { paymentRef: ref, price: PRICE }, { confirmations: 1 }),
		).rejects.toMatchObject({
			reason: "not-found",
		})
		await expect(
			verifySplitDeposit(chain.publicClient, m, merchant, proof, { paymentRef: ref, price: PRICE + 1n }, { confirmations: 1 }),
		).rejects.toMatchObject({
			reason: "malformed",
		})
		await claimed(await verified(t, merchant, ref), merchant)
	}, 900_000)

	it("a split to an account that is no merchant goes back to its depositor and mints nothing", async () => {
		const { manifest: m, node, wallet } = harness()
		const books = await openBooks()
		const user = await l2Actor()
		// The SDK refuses such a deposit; a list claiming `user` is a merchant stands in for a hand-built one.
		const list = await merchantList()
		const forged: MerchantList = {
			...list,
			entries: new Map([...list.entries, [user.toString(), list.entries.get(merchant.toString())!]]),
		}
		const ref = newPaymentRef()
		const t = books.deposit(await splitDeposit(l1, user, buyer, ref, forged))
		const c = await verified(t, user, ref)
		const supply = await totalSupply()
		await waitSplitClaimable(c, node, wallet, m, buyer, undefined, { pollMs: 1_000, attempts: 600 }).catch(() => undefined)
		await expect(claimSplit(c, node, wallet, m, { from: buyer })).rejects.toThrow("Split deposits pay listed merchants only")
		const exit = books.withdrawal(await returnSplit(c, wallet, node, m, { from: buyer }))
		expect(exit.amount).toBe(TEN)
		expect(exit.recipient.toLowerCase()).toBe(l1.account.toLowerCase())
		expect(await totalSupply()).toBe(supply)
		await books.settle()
	}, 900_000)

	it("a buyer bound to another address sends its change back to the depositor, which lowers the supply by it", async () => {
		const { manifest: m, node, wallet } = harness()
		const books = await openBooks()
		const bound = await l2Actor()
		await funded(await l1Actor(), "private", bound, USDC)
		const ref = newPaymentRef()
		const t = books.deposit(await splitDeposit(l1, merchant, bound, ref))
		await claimed(await verified(t, merchant, ref), merchant)
		const ch = changeOwed(t)
		await expect(claimChange(ch, node, wallet, m)).rejects.toBeInstanceOf(NotFundingAddressError)
		const supply = await totalSupply()
		const exit = books.withdrawal(await returnChange(ch, wallet, node, m, { from: bound }))
		expect(exit.amount).toBe(TEN - PRICE)
		expect(await totalSupply()).toBe(supply - (TEN - PRICE))
		expect(await changeState(ch, node, m)).toBe("settled")
		await books.settle()
	}, 900_000)
})
