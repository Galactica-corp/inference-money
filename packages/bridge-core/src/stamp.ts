/**
 * The merchant token's request stamps, paid marker, hint capsule slots and request effect: the TS mirror of
 * `contracts/aztec/merchant_stamp`.
 *
 * Opening a request (a partial note's commitment `c`) pushes `stamp(c, b)`, `b` the hour its anchor block falls in, when
 * the recipient is proven a merchant, and `pad(c)` otherwise. A user may pay only into a request whose stamp is still
 * live, at most until its deadline a day later; every payment pushes `paid(c)`, so a request takes one. The token
 * pushes all three unsiloed, so on chain each appears siloed with the token's address.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/sync"
import { Capsule } from "@aztec-labs/stdlib/tx"

/**
 * `poseidon2_hash_bytes("dom_sep__merchant_token_stamp[_pad]")` and `("dom_sep__merchant_token_request_paid")` as u32,
 * equal to the Noir constants. Literals, not computed at import: poseidon at module load crashes browser test
 * environments before Barretenberg initializes.
 */
export const DOM_SEP__MERCHANT_STAMP = 1404036670
export const DOM_SEP__MERCHANT_STAMP_PAD = 3491815610
export const DOM_SEP__MERCHANT_REQUEST_PAID = 3533394975
/** `poseidon2_hash_bytes("dom_sep__merchant_token_ref_paid")` as u32: the separator of `paidRef`. */
export const DOM_SEP__MERCHANT_REF_PAID = 4001138992

/** `poseidon2_hash_bytes("merchant_token_side_hint_capsule_slot")`: where a tx tells the token which side to prove. */
export const MERCHANT_SIDE_SLOT = new Fr(0x0bfc6bf5b3874bc783b148cc9a19595a0ec8267dbf92d1ecd82ca70f441668efn)

/** `poseidon2_hash_bytes("merchant_token_stamp_bucket_capsule_slot")`: where a tx tells a payment its stamp's bucket. */
export const STAMP_BUCKET_SLOT = new Fr(0x2781e8e10232a75d18a5d66dda25e487067dcf360eb97ae2cfecc1166e4e946cn)

/** `poseidon2_hash_bytes("merchant_token_request_opened")`: heads the offchain effect `[tag, c]` an opening emits. */
export const REQUEST_OPENED_EFFECT = new Fr(0x2c0264a3f3d089a68139762c50b6f5f68e6cc5d8662de00195b492d228a73f73n)

/**
 * The expiry the PXE commits for a tx the kernel caps at its default update horizon (anchor + 86 399 s): rounded down
 * to whole hours. Every tx that reads no shorter-lived state commits it, so it marks nothing.
 */
export const STANDARD_TX_LIFETIME = 82_800n

/** Seconds per stamp bucket. */
export const STAMP_BUCKET = 3600n
/** How many buckets hold a stamp still payable: the current one and the 24 before it. */
export const STAMP_LIVE_BUCKETS = 25n

export const stampBucket = (timestamp: bigint): bigint => timestamp / STAMP_BUCKET

/** The last second a payment relying on a stamp of `bucket` may be included: 24 h to 25 h after the opening's anchor. */
export const stampDeadline = (bucket: bigint): bigint => (bucket + STAMP_LIVE_BUCKETS) * STAMP_BUCKET - 1n

/**
 * A private payment through the stamp anchored before this commits the expiry every tx gets (anchor + 23 h, once the
 * PXE rounds it); anchored later, its shortened expiry tells an observer the stamp's age.
 */
export const stampUnmarkedUntil = (bucket: bigint): bigint => (bucket + 2n) * STAMP_BUCKET

export const stamp = (commitment: Fr, bucket: bigint): Fr =>
	poseidon2HashWithSeparator([commitment, new Fr(bucket)], DOM_SEP__MERCHANT_STAMP)
export const pad = (commitment: Fr): Fr => poseidon2HashWithSeparator([commitment], DOM_SEP__MERCHANT_STAMP_PAD)
export const paid = (commitment: Fr): Fr => poseidon2HashWithSeparator([commitment], DOM_SEP__MERCHANT_REQUEST_PAID)
/** The marker a `pay_private` into `merchant` under `paymentRef` pushes, unsiloed: a reference takes one payment there. */
export const paidRef = (merchant: AztecAddress, paymentRef: Fr): Fr =>
	poseidon2HashWithSeparator([merchant.toField(), paymentRef], DOM_SEP__MERCHANT_REF_PAID)

/** A request's stamp as a payer finds it at some block: its bucket, and the times that bound paying through it. */
export interface RequestStamp {
	bucket: bigint
	/** A private payment through it anchored before this commits the standard expiry. */
	unmarkedUntil: bigint
	/** Its deadline: no payment through it is included after this. */
	expiresAt: bigint
	/** At that block: "fresh" before `unmarkedUntil`, else "live" (it was found among the live buckets). */
	state: "fresh" | "live"
	/** That block's timestamp, the anchor a payment proven now reads at. */
	at: bigint
}

export function requestStampAt(bucket: bigint, at: bigint): RequestStamp {
	const unmarkedUntil = stampUnmarkedUntil(bucket)
	return { bucket, unmarkedUntil, expiresAt: stampDeadline(bucket), state: at < unmarkedUntil ? "fresh" : "live", at }
}

/** The buckets whose stamps are live at `timestamp`, newest first. */
export function liveBuckets(timestamp: bigint): bigint[] {
	const newest = stampBucket(timestamp)
	const count = newest + 1n < STAMP_LIVE_BUCKETS ? newest + 1n : STAMP_LIVE_BUCKETS
	return Array.from({ length: Number(count) }, (_, i) => newest - BigInt(i))
}

/** The capsule that tells a private payment which bucket its request's stamp is in, sparing the token's search. */
export const bucketCapsule = (token: AztecAddress, bucket: bigint): Capsule => new Capsule(token, STAMP_BUCKET_SLOT, [new Fr(bucket)])
