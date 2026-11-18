import { describe, expect, it } from "bun:test"
import { BRIDGE_REFUSALS, fundingAddress } from "@galactica-net/inference-money-core"
import { isAddressEqual } from "viem"
import {
	claimable,
	claimFor,
	deposit,
	l1Actor,
	l2Actor,
	merchantActor,
	openBooks,
	returnable,
	returnFor,
	setPaused,
	totalSupply,
	USDC,
	usdcOf,
	withdraw,
} from "./actors"
import { harness, INTEGRATION } from "./harness"

describe.skipIf(!INTEGRATION)("returns", () => {
	it("[A25] an unclaimed private deposit goes back to its depositor on L1, minting nothing and binding nothing", async () => {
		const { wallet, manifest: m } = harness()
		const [l1, bob] = await Promise.all([l1Actor(), l2Actor()])
		const books = await openBooks()
		const t = books.deposit(await deposit(l1, "private", bob, 3n * USDC))
		await claimable(t, bob)
		const supply = await totalSupply()

		const payout = books.withdrawal(await returnFor(t))
		expect(isAddressEqual(payout.recipient, l1.account)).toBe(true)
		expect(payout.amount).toBe(3n * USDC)
		expect(await totalSupply()).toBe(supply)
		expect(await fundingAddress(wallet, m, bob)).toBeUndefined()
		expect(await claimFor(t), "consumed by the return, never reported as a mint").toBe("consumed-unknown")

		const before = await usdcOf(l1.account)
		await withdraw(payout, l1)
		expect(await usdcOf(l1.account)).toBe(before + 3n * USDC)
		await books.settle()
	})

	it("[A25] a public deposit to a user can only be returned; one to a merchant can only be claimed", async () => {
		const [l1, bob, shop] = await Promise.all([l1Actor(), l2Actor(), merchantActor()])
		const books = await openBooks()
		const toUser = books.deposit(await deposit(l1, "public", bob, 2n * USDC))
		const toShop = books.deposit(await deposit(l1, "public", shop, USDC))
		await Promise.all([returnable(toUser), claimable(toShop, shop)])

		await expect(claimFor(toUser)).rejects.toThrow(BRIDGE_REFUSALS.publicClaimToUser)
		books.withdrawal(await returnFor(toUser))
		await expect(returnFor(toShop)).rejects.toThrow(BRIDGE_REFUSALS.merchantDepositReturn)
		expect(await claimFor(toShop)).toBe("claimed")
		await books.settle()
	})

	it("[A25] a claim and a return exclude each other, and a paused bridge refuses returns", async () => {
		const [l1, bob] = await Promise.all([l1Actor(), l2Actor()])
		const books = await openBooks()
		const claimed = books.deposit(await deposit(l1, "private", bob, USDC))
		await claimable(claimed, bob)
		expect(await claimFor(claimed)).toBe("claimed")
		await expect(returnFor(claimed)).rejects.toThrow(/No non-nullified L1 to L2 message/)

		const held = books.deposit(await deposit(l1, "private", bob, USDC))
		await claimable(held, bob)
		await setPaused(true)
		try {
			await expect(returnFor(held)).rejects.toThrow(BRIDGE_REFUSALS.paused)
		} finally {
			await setPaused(false)
		}
		books.withdrawal(await returnFor(held))
		await books.settle()
	})
})
