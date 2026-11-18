import { beforeAll, describe, expect, it } from "bun:test"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Capsule } from "@aztec-labs/stdlib/tx"
import {
	bucketCapsule,
	completionCount,
	MERCHANT_MAX_DELAY,
	MERCHANT_MIN_DELAY,
	openRequest,
	payRequest,
	requestStamp,
	Side,
	STAMP_BUCKET,
	STANDARD_TX_LIFETIME,
	sideCapsule,
	stampBucket,
	stampDeadline,
	stampUnmarkedUntil,
	TOKEN_REFUSALS,
} from "@galactica-net/inference-money-core"
import type { SentTx } from "@galactica-net/inference-money-deployer"
import { funded, l1Actor, l2Actor, sentDuring, USDC } from "../test/actors"
import { committedExpiry, lifetime } from "../test/expiry"
import { harness, holdSends, INTEGRATION, latestTimestamp, warpTo } from "../test/harness"
import { as, asAdmin, blockTimestamp, listMerchant, merchantList, sponsored, token, tokenAddress } from "../test/token"

const AMOUNT = USDC / 10n

type Request = { commitment: Fr; bucket: bigint }

/** Opens a request `to` takes and `completer` pays, with the bucket its stamp is in: its anchor's. */
async function openStamped(to: AztecAddress, completer: AztecAddress): Promise<Request> {
	const { wallet, node } = harness()
	const intent = { from: to, to, completer }
	let commitment = Fr.ZERO
	const [tx] = await sentDuring(async () => {
		;({ commitment } = await openRequest(wallet, node, tokenAddress(), intent, { list: await merchantList(), fee: sponsored() }))
	})
	const bucket = stampBucket(tx!.anchorTs)
	expect((await requestStamp(node, tokenAddress(), commitment))?.bucket).toBe(bucket)
	return { commitment, bucket }
}

const pay = async (from: AztecAddress, commitment: Fr, kind: "private" | "public" = "private") => {
	const { gate, wallet } = harness()
	const intent = { from, commitment, amount: AMOUNT, kind }
	return payRequest(gate, wallet, tokenAddress(), intent, { list: await merchantList(), fee: sponsored() })
}

/** A payment straight to the token, past payments.ts, with whichever capsules are given. */
const payPrivately = (from: AztecAddress, commitment: Fr, capsules: Capsule[] = []) =>
	token().methods.transfer_private_to_commitment!(from, commitment, AMOUNT, 0).with({ capsules }).send(as(from))

const publicPayment = (from: AztecAddress, commitment: Fr) => token().methods.transfer_public_to_commitment!(from, commitment, AMOUNT, 0)

/** The public payment's simulated L2 gas, which the token's search for a live stamp grows with the stamp's age. */
async function publicGas(from: AztecAddress, commitment: Fr): Promise<bigint> {
	const { gasUsed } = await publicPayment(from, commitment).simulate({ ...as(from), includeMetadata: true })
	return BigInt(gasUsed!.totalGas.l2Gas)
}

// One network whose clock only moves forward, so the cases run in order and share their requests. A warp lands on a
// slot boundary, not on the second asked for: every case reads the actual anchor and inclusion timestamps and asserts
// relations between them. Exact-second boundaries are the TXE suite's.
describe.skipIf(!INTEGRATION)("request stamps over a day", () => {
	let alice: AztecAddress
	let m1: AztecAddress
	let shortDelay: AztecAddress
	/** Refused as stale, then paid publicly; paid privately past payments.ts; paid publicly in its last hour; held. */
	let stale: Request
	let direct: Request
	let lastHour: Request
	let held: Request
	let heldPayment: Promise<unknown>
	let heldRecord: SentTx
	let release: () => Promise<void>

	beforeAll(async () => {
		const l1 = await l1Actor()
		;[alice, m1, shortDelay] = await Promise.all([l2Actor(), l2Actor(), l2Actor()])
		await listMerchant(m1)
		// Listed while the setting is 1 h, its switch-off lands an hour after it is scheduled.
		await token().methods.set_merchant_delay!(MERCHANT_MIN_DELAY).send(asAdmin())
		await listMerchant(shortDelay)
		await token().methods.set_merchant_delay!(MERCHANT_MAX_DELAY).send(asAdmin())
		await funded(l1, "private", alice, USDC)
		await funded(l1, "public", m1, USDC)
		// A user holds a public balance only by a merchant's public transfer.
		await token().methods.transfer_public_to_public!(m1, alice, 3n * AMOUNT, 0).send(as(m1))
	}, 900_000)

	it("[A21] a tx that reads nothing commits anchor + 82 800 s, and so does a payment into a request opened in the previous hour", async () => {
		const plain = () =>
			SetPublicAuthwitContractInteraction.create(harness().wallet, alice, Fr.random(), false).then((c) => c.send(as(alice)))
		const [notReading] = await sentDuring(plain)
		expect(lifetime(notReading!)).toBe(STANDARD_TX_LIFETIME)

		await warpTo((stampBucket(await latestTimestamp()) + 1n) * STAMP_BUCKET - 120n)
		const late = await openStamped(m1, alice)
		const [payment] = await sentDuring(async () => {
			await warpTo((late.bucket + 1n) * STAMP_BUCKET)
			await pay(alice, late.commitment)
		})
		expect(stampBucket(payment!.anchorTs), `anchored at ${payment!.anchorTs}`).toBe(late.bucket + 1n)
		expect(lifetime(payment!)).toBe(STANDARD_TX_LIFETIME)
	})

	it("once a stamp is no longer fresh, payRequest refuses a user's private payment as stale and pays it publicly; a direct one commits the deadline", async () => {
		stale = await openStamped(m1, alice)
		direct = await openStamped(m1, alice)
		lastHour = await openStamped(shortDelay, alice)
		await token().methods.schedule_merchant_off!(shortDelay, true).send(asAdmin())
		held = await openStamped(shortDelay, alice)

		await warpTo(stampUnmarkedUntil(held.bucket))
		await expect(pay(alice, stale.commitment)).rejects.toEqual(
			expect.objectContaining({ name: "PaymentRefusedError", reason: "stale" }),
		)
		await pay(alice, stale.commitment, "public")
		expect(await completionCount(harness().node, tokenAddress(), stale.commitment)).toBe(1)

		const [payment] = await sentDuring(() => payPrivately(alice, direct.commitment))
		expect(payment!.expiresAt).toBe(committedExpiry(payment!, stampDeadline(direct.bucket)))
		expect(lifetime(payment!)).toBeLessThan(STANDARD_TX_LIFETIME)
	})

	it("in a stamp's last hour, after its merchant switched off, a user still pays publicly and proves a private payment, held", async () => {
		const youngest = await publicGas(alice, held.commitment)
		await warpTo((lastHour.bucket + 24n) * STAMP_BUCKET)
		expect((await token().methods.is_merchant!(shortDelay).simulate({ from: alice })).result).toBe(false)
		const oldest = await publicGas(alice, lastHour.commitment)
		console.log(`[clock] public payment, l2 gas: stamp 2 buckets back ${youngest}, 24 buckets back ${oldest}`)
		const { receipt } = await publicPayment(alice, lastHour.commitment).send(as(alice))
		expect(stampBucket(await blockTimestamp(receipt))).toBe(lastHour.bucket + 24n)
		expect(await completionCount(harness().node, tokenAddress(), lastHour.commitment)).toBe(1)

		const sends = holdSends()
		release = sends.release
		const before = harness().sent.length
		let settled = false
		heldPayment = payPrivately(alice, held.commitment)
			.then(
				() => "landed",
				(e: unknown) => e,
			)
			.finally(() => {
				settled = true
			})
		while (sends.queued() === 0) {
			if (settled) throw new Error(`the private payment ended before it was sent: ${await heldPayment}`)
			await Bun.sleep(500)
		}
		heldRecord = harness().sent[before]!
		expect(heldRecord.expiresAt).toBe(committedExpiry(heldRecord, stampDeadline(held.bucket)))
	})

	it("past the deadline the node refuses the held payment, and the token a new one through either path", async () => {
		await warpTo(stampDeadline(held.bucket) + 1n)
		await release()
		expect(await heldPayment).toBeInstanceOf(Error)
		expect(heldRecord.refused).toBe(true)
		expect(await completionCount(harness().node, tokenAddress(), held.commitment)).toBe(0)

		const named = [sideCapsule(tokenAddress(), Side.First), bucketCapsule(tokenAddress(), held.bucket)]
		const refused = await sentDuring(async () => {
			await expect(payPrivately(alice, held.commitment)).rejects.toThrow(TOKEN_REFUSALS.payment)
			await expect(payPrivately(alice, held.commitment, named)).rejects.toThrow(TOKEN_REFUSALS.expired)
			await expect(publicPayment(alice, held.commitment).send(as(alice))).rejects.toThrow(TOKEN_REFUSALS.payment)
		})
		expect(refused).toEqual([])
	})
})
