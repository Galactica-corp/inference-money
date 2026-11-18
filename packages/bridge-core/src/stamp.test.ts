import { describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { poseidon2HashBytes } from "@aztec-labs/foundation/crypto/sync"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import {
	DOM_SEP__MERCHANT_REF_PAID,
	DOM_SEP__MERCHANT_REQUEST_PAID,
	DOM_SEP__MERCHANT_STAMP,
	DOM_SEP__MERCHANT_STAMP_PAD,
	liveBuckets,
	MERCHANT_SIDE_SLOT,
	pad,
	paid,
	paidRef,
	REQUEST_OPENED_EFFECT,
	STAMP_BUCKET_SLOT,
	stamp,
	stampBucket,
	stampDeadline,
	stampUnmarkedUntil,
} from "./stamp"

// The same literals as contracts/aztec/keystone: a drift makes every payment into a stamped request unprovable.
describe("merchant stamps (cross-toolchain vectors)", () => {
	const hash = (s: string) => poseidon2HashBytes(Buffer.from(s))
	const u32 = (s: string) => Number(hash(s).toBigInt() & 0xffff_ffffn)

	it("the separators, the capsule slots and the effect tag equal their runtime derivations", () => {
		expect(DOM_SEP__MERCHANT_STAMP).toBe(u32("dom_sep__merchant_token_stamp"))
		expect(DOM_SEP__MERCHANT_STAMP_PAD).toBe(u32("dom_sep__merchant_token_stamp_pad"))
		expect(DOM_SEP__MERCHANT_REQUEST_PAID).toBe(u32("dom_sep__merchant_token_request_paid"))
		expect(DOM_SEP__MERCHANT_REF_PAID).toBe(u32("dom_sep__merchant_token_ref_paid"))
		expect(MERCHANT_SIDE_SLOT.equals(hash("merchant_token_side_hint_capsule_slot"))).toBe(true)
		expect(STAMP_BUCKET_SLOT.equals(hash("merchant_token_stamp_bucket_capsule_slot"))).toBe(true)
		expect(REQUEST_OPENED_EFFECT.equals(hash("merchant_token_request_opened"))).toBe(true)
	})

	it.each([
		[0n, 0n, "0x137ffc4aa5d99bec8def2f15df0916cf4008642a87a04cfe93c5115c097e42e3"],
		[0x1234n, 0x5eedn, "0x0502a4dd9739d00939202ac3d254c480d9d73ebe93707d82b0a6f0f1628267a3"],
	] as const)("paidRef(%p, %p) matches the keystone", (merchant, ref, expected) => {
		expect(paidRef(AztecAddress.fromBigIntUnsafe(merchant), new Fr(ref)).toString()).toBe(expected)
	})

	it.each([
		[
			0n,
			0n,
			"0x0246f351a2d862ef1a0b26087a58b567c43c6b71e1ffdee3846e0970b5b93eb7",
			"0x250314702e0895fb86c6891bf980397f03d9b03867023ad8e3772a6221f3a23a",
			"0x145475d2e73acabbba12ef12c76dca11fc59f50172069a0cc519d0f53bc0a61c",
		],
		[
			0x1234n,
			494_000n,
			"0x1de43c3f6d595d0365d1e86c4a907b099f093cdbbfb4a7e25ba3418054187fcd",
			"0x23662d79d573c0597e92623a6bfc4d11dcb41fd3c0d34b54bff4eadaafdc3c9b",
			"0x10eaeca867df48fca9c59f06812fe5a5dcd008d5ef5dedb4ee3c4955c086b1af",
		],
	] as const)("stamp, pad and paid of %d (bucket %d) match the keystone", (c, b, s, p, d) => {
		expect(stamp(new Fr(c), b).toString()).toBe(s)
		expect(pad(new Fr(c)).toString()).toBe(p)
		expect(paid(new Fr(c)).toString()).toBe(d)
	})

	it("the bucket arithmetic matches the keystone", () => {
		expect([stampBucket(1_778_403_599n), stampBucket(1_778_403_600n)]).toEqual([494_000n, 494_001n])
		expect(stampDeadline(494_000n)).toBe(1_778_489_999n)
		expect(stampUnmarkedUntil(494_000n)).toBe(1_778_407_200n)
	})
})

describe("liveBuckets", () => {
	it("lists the 25 buckets a stamp is live in, newest first, and none before bucket 0", () => {
		const live = liveBuckets(stampDeadline(494_000n))
		expect([live.length, live[0], live.at(-1)]).toEqual([25, 494_024n, 494_000n])
		expect(liveBuckets(stampDeadline(494_000n) + 1n).at(-1)).toBe(494_001n)
		expect(liveBuckets(7_199n)).toEqual([1n, 0n])
	})
})
