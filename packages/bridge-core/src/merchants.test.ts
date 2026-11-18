import { describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SimulationError } from "@aztec-labs/stdlib/errors"
import { tokenBridgeArtifact } from "./artifacts"
import {
	contractEvent,
	MERCHANT_MAX_DELAY as DAY,
	MERCHANT_MIN_DELAY as HOUR,
	ListRefusal,
	type MerchantEntry,
	type MerchantList,
	merchantHorizon,
	merchantSide,
	merchantStatus,
	paymentSide,
	Side,
	sideCapsule,
	tokenEvent,
	withFreshList,
} from "./merchants"
import { TOKEN_REFUSALS } from "./rules"
import { MERCHANT_SIDE_SLOT, requestStampAt, STANDARD_TX_LIFETIME, stampBucket } from "./stamp"

const NOW = 1_000_000n
const [m1, m2, alice, bob] = await Promise.all([AztecAddress.random(), AztecAddress.random(), AztecAddress.random(), AztecAddress.random()])

const entry = (e: Partial<MerchantEntry> = {}): MerchantEntry => ({
	off: false,
	scheduledOff: false,
	changeAt: 0n,
	delay: DAY,
	scheduledDelay: DAY,
	delayChangeAt: 0n,
	...e,
})
const on = entry()
const switchingOff = entry({ scheduledOff: true, changeAt: NOW + HOUR })
// A switch-off cancelled, or switched back on, before it landed: the current value scheduled again.
const cancelled = entry({ changeAt: NOW + HOUR })
// A decrease to the hour, synced two hours before NOW.
const shortening = entry({ scheduledDelay: HOUR, delayChangeAt: NOW - 2n * HOUR + DAY - HOUR })
const list = (entries: [AztecAddress, MerchantEntry][]): MerchantList => ({
	block: 7,
	at: NOW,
	entries: new Map(entries.map(([a, e]) => [a.toString(), e])),
})

describe("merchant status", () => {
	it("is the old value before the change and the scheduled one from it on", () => {
		const l = list([[m1, switchingOff]])
		expect(merchantStatus(l, m1)).toEqual({ merchant: true, pending: true })
		expect(merchantStatus(l, m1, switchingOff.changeAt - 1n)).toEqual({ merchant: true, pending: true })
		expect(merchantStatus(l, m1, switchingOff.changeAt)).toEqual({ merchant: false, pending: false })
		expect(merchantStatus(l, alice)).toEqual({ merchant: false, pending: false })
		expect(merchantStatus(list([[m1, cancelled]]), m1)).toEqual({ merchant: true, pending: false })
	})
})

// The literal offsets the token's TXE suite pins for the same cases (a_merchant_read_caps_expiry_at_the_entrys_horizon).
describe("a merchant's horizon, from the read's anchor", () => {
	const offset = (e: MerchantEntry, at = NOW) => merchantHorizon(list([[m1, e]]), m1, at) - at

	it("is the delay - 1 when settled, unset meaning the hour, and just before a pending switch-off", () => {
		expect(offset(on)).toBe(DAY - 1n)
		expect(offset(entry({ delay: HOUR, scheduledDelay: HOUR }))).toBe(HOUR - 1n)
		expect(offset(entry({ delay: undefined, scheduledDelay: undefined }))).toBe(HOUR - 1n)
		expect(offset(entry({ scheduledOff: true, changeAt: NOW + DAY - 1n }))).toBe(DAY - 2n)
	})

	it("ignores a change scheduled to the current value (a_cancelled_entry_reads_unmarked)", () => {
		expect(offset(cancelled)).toBe(DAY - 1n)
	})

	it("is bounded by the old delay while a decrease is pending, and by the new one from its landing", () => {
		expect(offset(shortening)).toBe(DAY - 2n * HOUR - 1n)
		const lands = shortening.delayChangeAt
		expect([offset(shortening, lands - 1n), offset(shortening, lands), offset(shortening, lands + 1n)]).toEqual([
			HOUR,
			HOUR - 1n,
			HOUR - 1n,
		])
	})

	it("is 0 for an unlisted account", () => expect(merchantHorizon(list([]), alice)).toBe(0n))
})

// The same three rules as the token's hint (contracts/aztec/token/src/hints.nr).
describe("the side a call proves", () => {
	const one = list([[m1, on]])
	const firstPending = list([
		[m1, switchingOff],
		[m2, on],
	])
	const bothPending = list([
		[m1, switchingOff],
		[m2, switchingOff],
	])

	it("keeps any merchant side, and is Neither only between users", () => {
		expect(merchantSide(one, m1, alice, false)).toBe(Side.First)
		expect(merchantSide(one, alice, m1, false)).toBe(Side.Second)
		expect(merchantSide(one, alice, bob, false)).toBe(Side.Neither)
		expect(merchantSide(bothPending, m1, m2, false)).toBe(Side.First)
	})

	it("proves the merchant whose read caps later, unless the first is kept or leaves the standard expiry", () => {
		expect(merchantSide(firstPending, m1, m2, false)).toBe(Side.Second)
		expect(merchantSide(firstPending, m1, m2, true)).toBe(Side.First)
		const firstFarOff = list([
			[m1, entry({ scheduledOff: true, changeAt: NOW + STANDARD_TX_LIFETIME + HOUR })],
			[m2, on],
		])
		expect(merchantSide(firstFarOff, m1, m2, false)).toBe(Side.First)
		const hourly = list([
			[m1, entry({ delay: HOUR, scheduledDelay: HOUR })],
			[m2, on],
		])
		expect([merchantSide(hourly, m1, m2, false), merchantSide(hourly, m2, m1, false)]).toEqual([Side.Second, Side.First])
		const decreasing = list([
			[m1, shortening],
			[m2, on],
		])
		expect([merchantSide(decreasing, m1, m2, false), merchantSide(decreasing, m2, m1, false)]).toEqual([Side.Second, Side.First])
	})

	it("proves a fresh stamp, else an unmarked merchant payer, else a live stamp, and refuses a user with no live stamp", () => {
		const [fresh, live] = [requestStampAt(stampBucket(NOW), NOW), requestStampAt(stampBucket(NOW) - 3n, NOW)]
		expect([paymentSide(one, fresh, m1), paymentSide(one, fresh, alice)]).toEqual([Side.First, Side.First])
		expect([paymentSide(one, live, m1), paymentSide(one, live, alice)]).toEqual([Side.Second, Side.First])
		expect([paymentSide(one, undefined, m1), paymentSide(one, undefined, alice)]).toEqual([Side.Second, Side.Neither])
		const offAt = (changeAt: bigint) => list([[m1, entry({ scheduledOff: true, changeAt })]])
		expect(paymentSide(offAt(live.expiresAt + HOUR), live, m1), "later than the stamp, still marked").toBe(Side.First)
		expect(paymentSide(offAt(NOW + STANDARD_TX_LIFETIME + 1n), live, m1)).toBe(Side.Second)
		expect(paymentSide(offAt(NOW + HOUR), undefined, m1)).toBe(Side.Second)
	})

	it("reads a merchant payer's status at the stamp's block, as its horizon: a switch-off between the two leaves the user side", () => {
		const later = NOW + 2n * HOUR
		const stampedLater = requestStampAt(stampBucket(later) - 3n, later)
		expect(paymentSide(list([[m1, switchingOff]]), stampedLater, m1)).toBe(Side.First)
	})

	it("is carried in the token's capsule slot", () => {
		const capsule = sideCapsule(m1, Side.Second)
		expect(capsule.contractAddress.equals(m1)).toBe(true)
		expect(capsule.storageSlot.equals(MERCHANT_SIDE_SLOT)).toBe(true)
		expect(capsule.data.map((f) => f.toBigInt())).toEqual([1n])
	})
})

describe("the fresh-list retry", () => {
	const rule = TOKEN_REFUSALS.transfer
	/** Runs an attempt that fails with `errors` in turn, then succeeds; returns how many attempts and resyncs ran. */
	async function run(...errors: Error[]) {
		const counts = { attempts: 0, resyncs: 0 }
		const resync = async () => {
			counts.resyncs++
			return list([])
		}
		const outcome = await withFreshList(list([]), resync, async () => {
			const e = errors[counts.attempts++]
			if (e) throw e
			return "sent"
		}).catch((e: Error) => e)
		return { outcome, ...counts }
	}

	it("runs again only on a stale-list rule refused before the send, and only once", async () => {
		const simulated = new SimulationError(rule, [])
		for (const [why, error, retried] of [
			["a node's reply, which may follow the send", new Error(`Invalid tx: ${rule}`), false],
			["a simulation refusal on another rule", new SimulationError(TOKEN_REFUSALS.zeroPayment, []), false],
			["the wallet's simulation", simulated, true],
			["a wrapper of it", new Error(rule, { cause: simulated }), true],
			["the client's own list", new ListRefusal(rule), true],
		] as const) {
			const r = await run(error)
			expect([r.outcome, r.attempts, r.resyncs], why).toEqual(retried ? ["sent", 2, 1] : [error, 1, 0])
		}
		const again = new ListRefusal(rule)
		expect(await run(new ListRefusal(rule), again)).toEqual({ outcome: again, attempts: 2, resyncs: 1 })
	})
})

describe("contract events", () => {
	// aztec-standards' codegen pins Transfer's selector; deriving it the same way proves the method for MerchantAdded.
	it("derive the selector aztec's codegen pins", async () => {
		expect((await tokenEvent("Transfer")).eventSelector.toString()).toBe("0x70a1894e")
		await expect(tokenEvent("Missing")).rejects.toThrow(/no Token::Missing event/)
	})

	// No independent source pins a bridge event's selector; the integration spec reads them off a real node.
	it("are found by their contract's name", async () => {
		expect((await contractEvent(tokenBridgeArtifact, "OwnershipTransferred")).fieldNames).toEqual(["previous_owner", "new_owner"])
		await expect(contractEvent(tokenBridgeArtifact, "Missing")).rejects.toThrow(/no TokenBridge::Missing event/)
	})
})
