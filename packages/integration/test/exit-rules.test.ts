import { describe, expect, it } from "bun:test"
import { BRIDGE_REFUSALS, ExitDestinationError, type ExitIntent, exitToL1, isBridgePaused } from "@galactica-net/inference-money-core"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
	claimable,
	claimFor,
	deposit,
	l1Actor,
	l2Actor,
	l2Balances,
	merchantActor,
	openBooks,
	payFor,
	setPaused,
	USDC,
	usdcOf,
	withdraw,
} from "./actors"
import { harness, INTEGRATION } from "./harness"

const exit = (e: ExitIntent) => exitToL1(e, harness().wallet, harness().node, harness().manifest, { fee: payFor(e.kind) })
const anywhere = () => privateKeyToAccount(generatePrivateKey()).address

describe.skipIf(!INTEGRATION)("exit rules", () => {
	it("[A24] a user withdraws only to its funding address: anywhere else, and every public exit, burns nothing", async () => {
		const [l1, bob] = await Promise.all([l1Actor(), l2Actor()])
		const books = await openBooks()
		const t = books.deposit(await deposit(l1, "private", bob, 5n * USDC))
		await claimable(t, bob)
		await claimFor(t)

		const elsewhere = anywhere()
		await expect(exit({ kind: "private", from: bob, recipientL1: elsewhere, amount: USDC })).rejects.toBeInstanceOf(
			ExitDestinationError,
		)
		// Without the preflight the bridge holds the line itself: a user claiming to be a merchant is refused on chain.
		await expect(exit({ kind: "private", from: bob, recipientL1: elsewhere, amount: USDC, asMerchant: true })).rejects.toThrow(
			BRIDGE_REFUSALS.exitDestination,
		)
		await expect(exit({ kind: "public", from: bob, recipientL1: l1.account, amount: USDC })).rejects.toThrow(
			BRIDGE_REFUSALS.publicExitByUser,
		)
		expect((await l2Balances(bob)).private).toBe(5n * USDC)

		const home = books.withdrawal(await exit({ kind: "private", from: bob, recipientL1: l1.account, amount: 2n * USDC }))
		const before = await usdcOf(l1.account)
		await withdraw(home, l1)
		expect(await usdcOf(l1.account)).toBe(before + 2n * USDC)
		await books.settle()
	})

	it("[A24] a merchant exits privately and publicly to any address", async () => {
		const [l1, shop] = await Promise.all([l1Actor(), merchantActor()])
		const books = await openBooks()
		for (const kind of ["private", "public"] as const) {
			const t = books.deposit(await deposit(l1, kind, shop, USDC))
			await claimable(t, shop)
			await claimFor(t)
		}
		const to = anywhere()
		const priv = books.withdrawal(await exit({ kind: "private", from: shop, recipientL1: to, amount: USDC, asMerchant: true }))
		const pub = books.withdrawal(await exit({ kind: "public", from: shop, recipientL1: to, amount: USDC }))
		await withdraw(priv, l1)
		await withdraw(pub, l1)
		expect(await usdcOf(to)).toBe(2n * USDC)
		await books.settle()
	})

	it("[A24][A6] an exit already made is redeemed on L1 while the bridge is paused: the pause holds L2 only", async () => {
		const { manifest: m, node } = harness()
		const [l1, bob] = await Promise.all([l1Actor(), l2Actor()])
		const books = await openBooks()
		const t = books.deposit(await deposit(l1, "private", bob, USDC))
		await claimable(t, bob)
		await claimFor(t)
		const out = books.withdrawal(await exit({ kind: "private", from: bob, recipientL1: l1.account, amount: USDC }))
		await setPaused(true)
		try {
			expect(await isBridgePaused(node, m)).toBe(true)
			const before = await usdcOf(l1.account)
			await withdraw(out, l1)
			expect(await usdcOf(l1.account)).toBe(before + USDC)
		} finally {
			await setPaused(false)
		}
		await books.settle()
	})
})
