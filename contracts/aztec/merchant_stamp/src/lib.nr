// The merchant token's cross-toolchain constants: the request stamp, the paid marker and the hint capsule slots.
// Mirrored in packages/bridge-core/src/stamp.ts and pinned against it by the keystone.
//
// A request (a partial note's commitment `c`) opened for a merchant recipient pushes `stamp(c, b)`, `b` being the hour
// its anchor block falls in; one a merchant opens for a user pushes `pad(c)` instead, so both publish one nullifier and
// an observer without `c` cannot tell them apart. A payment into `c` pushes `paid(c)`, so a request takes one. The token
// pushes all three unsiloed and the kernel silos them with its address, so no other contract can forge one.
use aztec::protocol::{address::AztecAddress, hash::poseidon2_hash_with_separator, traits::ToField};

// poseidon2_hash_bytes("dom_sep__merchant_token_stamp[_pad]") and ("dom_sep__merchant_token_request_paid") as u32,
// pinned as literals; the keystone re-derives all three and asserts they differ from each other, from every protocol
// and aztec-nr separator, and from the claim secret's.
pub global DOM_SEP__MERCHANT_STAMP: u32 = 1404036670;
pub global DOM_SEP__MERCHANT_STAMP_PAD: u32 = 3491815610;
pub global DOM_SEP__MERCHANT_REQUEST_PAID: u32 = 3533394975;
// poseidon2_hash_bytes("dom_sep__merchant_token_ref_paid") as u32, pinned and checked by the keystone like the three above.
pub global DOM_SEP__MERCHANT_REF_PAID: u32 = 4001138992;

// poseidon2_hash_bytes("merchant_token_side_hint_capsule_slot"): where a tx's capsule tells the token which side of a
// restricted call to prove. Read at the global (zero) capsule scope, which the PXE allows every tx.
pub global MERCHANT_SIDE_SLOT: Field =
    0x0bfc6bf5b3874bc783b148cc9a19595a0ec8267dbf92d1ecd82ca70f441668ef;

// poseidon2_hash_bytes("merchant_token_stamp_bucket_capsule_slot"): where a tx's capsule tells a payment which
// bucket its request's stamp is in, sparing the token's hint the search. Same scope as the side capsule.
pub global STAMP_BUCKET_SLOT: Field =
    0x2781e8e10232a75d18a5d66dda25e487067dcf360eb97ae2cfecc1166e4e946c;

// poseidon2_hash_bytes("merchant_token_request_opened"): heads the offchain effect `[REQUEST_OPENED_EFFECT, c]` that
// tells the opener's client which commitment it opened. A sent tx returns no private return values, and `c` embeds
// randomness drawn while proving, so a simulation's return value is a different commitment.
pub global REQUEST_OPENED_EFFECT: Field =
    0x2c0264a3f3d089a68139762c50b6f5f68e6cc5d8662de00195b492d228a73f73;

/// Seconds per stamp bucket.
pub global STAMP_BUCKET: u64 = 3600;

/// How many buckets hold a stamp that is still payable: the current one and the 24 before it.
pub global STAMP_LIVE_BUCKETS: u64 = 25;

pub fn stamp_bucket(timestamp: u64) -> u64 {
    timestamp / STAMP_BUCKET
}

/// The last second a payment relying on a stamp of `bucket` may be included: at least 24 h, and less than 25 h, after
/// any timestamp in the bucket.
pub fn stamp_deadline(bucket: u64) -> u64 {
    (bucket + STAMP_LIVE_BUCKETS) * STAMP_BUCKET - 1
}

/// A payment anchored before this is at least 23 h short of the deadline, the lifetime the kernel leaves a tx that
/// reads nothing once the wallet has rounded it, so capping its expiry at the deadline does not single it out. It is
/// more than an hour after any timestamp in the bucket.
pub fn stamp_unmarked_until(bucket: u64) -> u64 {
    (bucket + 2) * STAMP_BUCKET
}

pub fn stamp(commitment: Field, bucket: u64) -> Field {
    poseidon2_hash_with_separator([commitment, bucket as Field], DOM_SEP__MERCHANT_STAMP)
}

pub fn pad(commitment: Field) -> Field {
    poseidon2_hash_with_separator([commitment], DOM_SEP__MERCHANT_STAMP_PAD)
}

pub fn paid(commitment: Field) -> Field {
    poseidon2_hash_with_separator([commitment], DOM_SEP__MERCHANT_REQUEST_PAID)
}

/// The nullifier a `pay_private` into `merchant` under `payment_ref` pushes, so a reference takes one payment per merchant.
/// The reference is a random field the merchant hands out, so the nullifier names neither party to anyone without it.
pub fn paid_ref(merchant: AztecAddress, payment_ref: Field) -> Field {
    poseidon2_hash_with_separator([merchant.to_field(), payment_ref], DOM_SEP__MERCHANT_REF_PAID)
}
