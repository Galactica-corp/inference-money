import { describe, expect, it } from "bun:test"
import {
	BindConsentRequiredError,
	claim,
	claimBinding,
	depositFate,
	exitTicketFromTx,
	fundingAddress,
	NotFundingAddressError,
	waitClaimable,
} from "@galactica-net/inference-money-core"
import { type Address, isAddressEqual } from "viem"
import {
	claimable,
	claimFor,
	deposit,
	l1Actor,
	l2Actor,
	l2Balances,
	openBooks,
	returnable,
	returnFor,
	sentDuring,
	USDC,
	usdcOf,
	withdraw,
} from "./actors"
import { harness, INTEGRATION, sendTogether } from "./harness"

/** The losing claim's binding repeats the winner's initialization nullifier. */
const LOST_RACE = /nullifier/i

const boundTo = async (account: Parameters<typeof fundingAddress>[2]): Promise<Address | undefined> =>
	fundingAddress(harness().wallet, harness().manifest, account)

describe.skipIf(!INTEGRATION)("funding-address binding", () => {
	it("[A23] the first private claim binds the account to its depositor; later deposits claim only from there", async () => {
		const { wallet, manifest: m, node, outbox } = harness()
		const [l1, other, bob] = await Promise.all([l1Actor(), l1Actor(), l2Actor()])
		const books = await openBooks()
		expect(await boundTo(bob)).toBeUndefined()

		const first = books.deposit(await deposit(l1, "private", bob, 2n * USDC))
		expect(await depositFate(first, node, m)).toEqual({ consumed: false })
		await claimable(first, bob)
		expect(await claimBinding(wallet, m, bob, first.depositor), "the app warns before this claim").toBe("binds")
		const unconsented = await sentDuring(async () => {
			await expect(claim(first, node, wallet, m, { from: bob })).rejects.toBeInstanceOf(BindConsentRequiredError)
			await expect(waitClaimable(first, node, wallet, m, bob)).rejects.toBeInstanceOf(BindConsentRequiredError)
		})
		expect(unconsented, "refused without consent before anything is proven").toEqual([])
		expect(await claimFor(first)).toBe("claimed")
		expect(await depositFate(first, node, m)).toMatchObject({ consumed: true, withdrawal: false })
		const bound = await boundTo(bob)
		expect(bound !== undefined && isAddressEqual(bound, l1.account)).toBe(true)

		const again = books.deposit(await deposit(l1, "private", bob, USDC))
		await claimable(again, bob)
		expect(await claimFor(again)).toBe("claimed")

		// Refused by the preflight before any proof; the bridge refuses the same claim on chain (TXE binding suite).
		const stranger = books.deposit(await deposit(other, "private", bob, USDC))
		await expect(claimable(stranger, bob)).rejects.toBeInstanceOf(NotFundingAddressError)
		await expect(claimFor(stranger)).rejects.toBeInstanceOf(NotFundingAddressError)
		expect((await l2Balances(bob)).private).toBe(3n * USDC)
		await returnable(stranger)
		await returnFor(stranger)
		// Bob keeps the return's hash; the stranger finds its payout from its own deposit ticket and collects it on L1.
		const fate = await depositFate(stranger, node, m)
		if (!(fate.consumed && fate.withdrawal)) throw new Error(`the refused deposit reads ${JSON.stringify(fate)}`)
		const payout = await exitTicketFromTx(fate.l2TxHash, other.account, USDC, node, outbox, m)
		if (typeof payout === "string") throw new Error(`the return's withdrawal reads ${payout}`)
		books.withdrawal(payout)
		const before = await usdcOf(other.account)
		await withdraw(payout, other)
		expect(await usdcOf(other.account)).toBe(before + USDC)
		await books.settle()
	})

	it("[A23] a first-claim race: two first claims from different depositors both prove, one binds, the other is returned", async () => {
		const [a, b, bob] = await Promise.all([l1Actor(), l1Actor(), l2Actor()])
		const books = await openBooks()
		const ta = books.deposit(await deposit(a, "private", bob, USDC))
		const tb = books.deposit(await deposit(b, "private", bob, 2n * USDC))
		await Promise.all([claimable(ta, bob), claimable(tb, bob)])

		// Both claims bind (the account is unbound when each is proven), and both reach the node.
		const { sent } = harness()
		const before = sent.length
		const outcomes = await sendTogether([() => claimFor(ta), () => claimFor(tb)])
		expect(sent.length - before, "both claims were proven and submitted").toBe(2)
		const won = outcomes.flatMap((o, i) => (o.status === "fulfilled" && o.value === "claimed" ? [i] : []))
		expect(won, JSON.stringify(outcomes.map((o) => o.status))).toHaveLength(1)
		const lost = outcomes[1 - (won[0] ?? 0)]
		expect(lost?.status === "rejected" && String(lost.reason)).toMatch(LOST_RACE)
		const [winner, loser] = won[0] === 0 ? [ta, tb] : [tb, ta]
		const bound = await boundTo(bob)
		expect(bound !== undefined && isAddressEqual(bound, winner.depositor)).toBe(true)
		expect((await l2Balances(bob)).private).toBe(winner.draft.intent.amount)

		await expect(claimFor(loser)).rejects.toBeInstanceOf(NotFundingAddressError)
		const payout = books.withdrawal(await returnFor(loser))
		expect(isAddressEqual(payout.recipient, loser.depositor)).toBe(true)
		await books.settle()
	})
})
