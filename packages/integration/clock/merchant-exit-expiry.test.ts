import { beforeAll, describe, expect, it } from "bun:test"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import {
	type ExitTicket,
	ExitUnconfirmedError,
	exitToL1,
	type L1Ctx,
	MERCHANT_MAX_DELAY,
	MERCHANT_MIN_DELAY,
} from "@inference-money/bridge-core"
import type { SentTx } from "@inference-money/deployer"
import { funded, l1Actor, l2Actor, l2Balances, payFor, sentDuring, totalSupply, USDC } from "../test/actors"
import { committedExpiry } from "../test/expiry"
import { harness, holdSends, INTEGRATION, warpTo } from "../test/harness"
import { asAdmin, listMerchant, merchantList, token } from "../test/token"

const AMOUNT = USDC / 10n

// The merchant check reads its entry, which caps the exit's tx just before a scheduled switch-off. Listed while the
// setting is 1 h, the cap falls under the standard 82 800 s expiry; with 24 h it would not, and the held exit would be
// refused for the standard expiry alone.
describe.skipIf(!INTEGRATION)("a merchant's private exit across its switch-off", () => {
	let l1: L1Ctx
	let shop: AztecAddress
	let changeAt: bigint

	const exit = () =>
		exitToL1(
			{ kind: "private", from: shop, recipientL1: l1.account, amount: AMOUNT, asMerchant: true },
			harness().wallet,
			harness().sends,
			harness().manifest,
			{ fee: payFor("private") },
		)

	beforeAll(async () => {
		;[l1, shop] = await Promise.all([l1Actor(), l2Actor()])
		await token().methods.set_merchant_delay!(MERCHANT_MIN_DELAY).send(asAdmin())
		await listMerchant(shop)
		await token().methods.set_merchant_delay!(MERCHANT_MAX_DELAY).send(asAdmin())
		await funded(l1, "private", shop, 3n * AMOUNT)
		await token().methods.schedule_merchant_off!(shop, true).send(asAdmin())
		changeAt = (await merchantList()).entries.get(shop.toString())!.changeAt
	}, 900_000)

	it("[A5] while the switch-off is pending, the exit lands with its expiry capped just before it", async () => {
		let ticket: ExitTicket | undefined
		const [tx] = await sentDuring(async () => {
			ticket = await exit()
		})
		expect(ticket?.amount).toBe(AMOUNT)
		expect(tx!.expiresAt).toBe(committedExpiry(tx!, changeAt - 1n))
		expect((await l2Balances(shop)).private).toBe(2n * AMOUNT)
	})

	it("[A5] proven before the switch-off and sent after it, the exit is refused by the node and reported unconfirmed: nothing burns, no message", async () => {
		const supply = await totalSupply()
		const sends = holdSends()
		const before = harness().sent.length
		let settled = false
		const held = exit()
			.then(
				() => "landed",
				(e: unknown) => e,
			)
			.finally(() => {
				settled = true
			})
		while (sends.queued() === 0) {
			if (settled) throw new Error(`the exit ended before it was sent: ${await held}`)
			await Bun.sleep(500)
		}
		const record: SentTx = harness().sent[before]!
		expect(record.expiresAt).toBe(committedExpiry(record, changeAt - 1n))

		await warpTo(changeAt)
		await sends.release()
		const err = await held
		expect(err).toBeInstanceOf(ExitUnconfirmedError)
		expect(String((err as ExitUnconfirmedError).cause)).toContain("Invalid tx: Invalid expiration timestamp")
		expect((err as ExitUnconfirmedError).sent?.map((s) => String(s.txHash))).toEqual([record.hash])
		expect(record.refused).toBe(true)
		expect(await harness().node.getTxEffect(TxHash.fromString(record.hash))).toBeUndefined()
		expect((await l2Balances(shop)).private).toBe(2n * AMOUNT)
		expect(await totalSupply()).toBe(supply)
	})
})
