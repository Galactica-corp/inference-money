import { beforeAll, describe, expect, it } from "bun:test"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { MERCHANT_MAX_DELAY, MERCHANT_MIN_DELAY, merchantSide, Side, sideCapsule, TOKEN_REFUSALS } from "@inference-money/bridge-core"
import { funded, l1Actor, l2Actor, l2Balances, sentDuring, USDC } from "./actors"
import { committedExpiry, lifetime } from "./expiry"
import { harness, INTEGRATION } from "./harness"
import { as, asAdmin, blockTimestamp, listMerchant, merchantList, token, tokenAddress } from "./token"

const AMOUNT = USDC / 10n

/** A private transfer from `from`, with a side capsule when `side` is given. */
function transfer(from: AztecAddress, to: AztecAddress, side?: Side) {
	const call = token().methods.transfer_private_to_private!(from, to, AMOUNT, 0)
	return (side === undefined ? call : call.with({ capsules: [sideCapsule(tokenAddress(), side)] })).send(as(from))
}

describe.skipIf(!INTEGRATION)("transfers under the merchant rule", () => {
	let alice: AztecAddress
	let bob: AztecAddress
	let m1: AztecAddress

	beforeAll(async () => {
		const l1 = await l1Actor()
		;[alice, bob, m1] = await Promise.all([l2Actor(), l2Actor(), l2Actor()])
		await listMerchant(m1)
		await funded(l1, "private", alice, USDC)
	}, 900_000)

	it("[A21] a user pays a merchant with the SDK's capsule or with none; user to user and forged capsules fail before sending", async () => {
		const side = merchantSide(await merchantList(), m1, alice, false)
		expect(side).toBe(Side.First)
		await transfer(alice, m1, side)
		await transfer(alice, m1)
		const refused = await sentDuring(async () => {
			await expect(transfer(alice, bob)).rejects.toThrow(TOKEN_REFUSALS.transfer)
			// Each capsule names a side that is no merchant, so its read cannot be proven.
			await expect(transfer(alice, m1, Side.Second)).rejects.toThrow(/uninitialized PublicImmutable/)
			await expect(transfer(alice, bob, Side.First)).rejects.toThrow(/uninitialized PublicImmutable/)
		})
		expect(refused).toEqual([])
		expect((await l2Balances(m1)).private).toBe(2n * AMOUNT)
	})

	it("[A21] a user sends privately to itself, proving no side", async () => {
		const before = (await l2Balances(alice)).private
		await transfer(alice, alice, Side.Neither)
		expect((await l2Balances(alice)).private).toBe(before)
	})

	it("[A21] expiry: a settled 24 h entry leaves a tx's lifetime as a tx that reads nothing; 1 h, or a pending switch-off, shortens it", async () => {
		const plain = () =>
			SetPublicAuthwitContractInteraction.create(harness().wallet, alice, Fr.random(), false).then((c) => c.send(as(alice)))
		const [[reading], [notReading]] = [await sentDuring(() => transfer(alice, m1, Side.First)), await sentDuring(plain)]
		expect(lifetime(reading!)).toBe(lifetime(notReading!))

		// A merchant added while the setting is 1 h starts at the floor, which the setting's restore does not touch.
		const m3 = await l2Actor()
		await token().methods.set_merchant_delay!(MERCHANT_MIN_DELAY).send(asAdmin())
		await listMerchant(m3)
		await token().methods.set_merchant_delay!(MERCHANT_MAX_DELAY).send(asAdmin())
		try {
			const [short] = await sentDuring(() => transfer(alice, m3, Side.First))
			expect(short!.expiresAt).toBe(committedExpiry(short!, short!.anchorTs + MERCHANT_MIN_DELAY - 1n))
			expect(lifetime(short!)).toBeLessThan(lifetime(notReading!))

			const { receipt } = await token().methods.schedule_merchant_off!(m3, true).send(asAdmin())
			const changeAt = (await blockTimestamp(receipt)) + MERCHANT_MIN_DELAY
			const [pending] = await sentDuring(() => transfer(alice, m3, Side.First))
			expect(pending!.expiresAt).toBe(committedExpiry(pending!, changeAt - 1n))
		} finally {
			// An increase applies at once: no later verify of this shared deployment meets an entry off the setting.
			await token().methods.sync_merchant_delay!(m3).send(asAdmin())
		}
	})
})
