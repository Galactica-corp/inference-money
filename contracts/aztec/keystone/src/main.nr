// KEYSTONE: proves the Noir content-hashes equal the L1 (Solidity) ones for
// fixed vectors. The matching L1 assertions live in contracts/evm
// (test/ContentHash.t.sol) against the SAME constants. Equality across both
// toolchains is the one cross-chain boundary guard the TXE can't provide: if a
// selector or arg order ever drifts, a deposit's L1->L2 message becomes
// unconsumable and funds strand. Run: scripts/run-txe-tests.sh --crate keystone.

use aztec::hash::compute_secret_hash;
use aztec::messages::offchain_messages::OFFCHAIN_MESSAGE_IDENTIFIER;
use aztec::protocol::address::{AztecAddress, EthAddress};
use aztec::protocol::constants as protocol;
use aztec::protocol::hash::poseidon2_hash_bytes;
use aztec::protocol::traits::{Deserialize, FromField};
use claim_secret_lib::{derive_claim_secret, DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET};
use merchant_stamp::{
    DOM_SEP__MERCHANT_REQUEST_PAID, DOM_SEP__MERCHANT_STAMP, DOM_SEP__MERCHANT_STAMP_PAD,
    MERCHANT_SIDE_SLOT, pad, paid, REQUEST_OPENED_EFFECT, stamp, stamp_bucket, STAMP_BUCKET_SLOT,
    stamp_deadline, stamp_unmarked_until,
};
use portal_messages::{mint_to_private_content_hash, mint_to_public_content_hash, withdraw_content_hash};

fn main() {}

global DEPOSITOR: EthAddress = EthAddress::from_field(0xD0D0);
// The top bit of every word set: an encoder that truncates an address or amount still matches the low vectors.
global HIGH_DEPOSITOR: EthAddress = EthAddress::from_field(0x8000000000000000000000000000000000000001);

#[test]
fn mint_to_public_matches_l1() {
    let to = AztecAddress::from_field(0x1234);
    let h = mint_to_public_content_hash(to, 1_000_000, DEPOSITOR);
    assert(h == 0x00dbc90158731bb184636b606f4a34496eb320d1215f259c4c53afeea7629e23);
}

#[test]
fn mint_to_private_matches_l1() {
    let h = mint_to_private_content_hash(1_000_000, DEPOSITOR);
    assert(h == 0x006bfc126e408142a4cc801b6780b5c8c7ad7bfc7cb23d1a2cbb731a958c2a07);
}

#[test]
fn mint_to_public_matches_l1_at_high_bits() {
    let to = AztecAddress::from_field(0x1234);
    let h = mint_to_public_content_hash(to, 0x80000000000000000000000000000000, HIGH_DEPOSITOR);
    assert(h == 0x00c92584ad559f46de9851f17d4c3d591df8dd99278eaa8dd7d568af0b076685);
}

#[test]
fn mint_to_private_matches_l1_at_high_bits() {
    let h = mint_to_private_content_hash(0xffffffffffffffffffffffffffffffff, HIGH_DEPOSITOR);
    assert(h == 0x0027e4159023e23580ae653c0c0cc3ea532ec740f7f9cee719433a8674acd365);
}

#[test]
fn withdraw_matches_l1() {
    let recipient = EthAddress::from_field(0xBEEF);
    let caller = EthAddress::zero();
    let h = withdraw_content_hash(recipient, 1_000_000, caller);
    assert(h == 0x00ac390e12f1097130e1a7c2e5eea30780cd11d12002b8de22d608cf10a60775);
}

// An ABI-decoded EthAddress may hold any field; a withdraw takes only what Solidity's `address` can, up to its widest.
global BEYOND_ADDRESS: EthAddress = EthAddress::deserialize([0x10000000000000000000000000000000000000000]);

#[test(should_fail_with = "A withdraw names only 20-byte Ethereum addresses")]
fn withdraw_refuses_a_wider_recipient() {
    let _ = withdraw_content_hash(BEYOND_ADDRESS, 1, EthAddress::zero());
}

#[test(should_fail_with = "A withdraw names only 20-byte Ethereum addresses")]
fn withdraw_refuses_a_wider_caller() {
    let _ = withdraw_content_hash(EthAddress::from_field(0xBEEF), 1, BEYOND_ADDRESS);
}

#[test]
fn withdraw_takes_the_widest_address() {
    let widest = EthAddress::from_field(0xffffffffffffffffffffffffffffffffffffffff);
    let _ = withdraw_content_hash(widest, 1, widest);
}

// A deposit's content must commit to every bit of its depositor: flipping any one of the 160 must move both hashes,
// or a claim could present a neighbouring address.
#[test]
fn fuzz_deposit_hashes_bind_the_depositor(high: u32, low: u128, bit: u8, amount: u128, to: Field) {
    let two_128 = 0x100000000000000000000000000000000;
    let k = bit % 160;
    let (flipped_high, flipped_low) = if k < 128 {
        (high, low ^ ((1 as u128) << (k as u128)))
    } else {
        (high ^ ((1 as u32) << ((k - 128) as u32)), low)
    };
    let depositor = EthAddress::from_field(high as Field * two_128 + low as Field);
    let neighbour = EthAddress::from_field(flipped_high as Field * two_128 + flipped_low as Field);
    assert(
        mint_to_private_content_hash(amount, depositor) != mint_to_private_content_hash(amount, neighbour),
        "the private deposit hash ignores the depositor",
    );
    let recipient = AztecAddress::from_field(to);
    assert(
        mint_to_public_content_hash(recipient, amount, depositor)
            != mint_to_public_content_hash(recipient, amount, neighbour),
        "the public deposit hash ignores the depositor",
    );
}

// ─── Recipient-committed private-claim secret derivation ─────────────
// The keystone's second cross-toolchain boundary: derive_claim_secret + compute_secret_hash
// must byte-match the TS mirror (packages/bridge-core/src/claim-secret.test.ts) for the SAME
// (salt, recipient) vectors — a drift strands every private deposit.
// The TS test asserts the identical literals.

// poseidon2_hash_bytes("nulo_dom_sep__token_bridge_private_claim_secret") as u32. Distinct from the
// FPC fuel separator (3952304070) — the cross-protocol-secret-reuse tripwire.
#[test]
fn claim_secret_dom_sep_is_pinned() {
    assert(DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET == 3140354885);
    assert(DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET != 3952304070);
}

#[test]
fn claim_secret_vectors_match_ts() {
    // (salt, recipient) -> derived secret
    let s0 = derive_claim_secret(0, AztecAddress::from_field(0));
    assert(s0 == 0x1bcb2e97aaeb9788f9b23d331c90b0e138b8fa84890f1fb045c4c260b26e1a4f);
    let s1 = derive_claim_secret(1, AztecAddress::from_field(2));
    assert(s1 == 0x12e754c717173c3dd6f22932580bf8332274034b2c4a6a8ec8d682b482e104a5);
    let s2 = derive_claim_secret(0x1234567890abcdef, AztecAddress::from_field(0xdeadbeef));
    assert(s2 == 0x02c856f2079a8e1cc126d02e81cd409c7ee02e0c4c7cd2dd9450edaa8c681e7d);
}

#[test]
fn claim_secret_hash_vectors_match_ts() {
    // L1 commits to poseidon2_hash_with_separator([derive_claim_secret(salt, recipient)], DOM_SEP__SECRET_HASH).
    let h0 = compute_secret_hash([derive_claim_secret(0, AztecAddress::from_field(0))]);
    assert(h0 == 0x087647b3c1976bde1cf12bfa5213c1d619f4f0b9a0bae6e1000d7030fcb9d5fc);
    let h1 = compute_secret_hash([derive_claim_secret(1, AztecAddress::from_field(2))]);
    assert(h1 == 0x23d9fa16980e66c10886f09780ea412bd1c942a0a6e588d838ea05d7228c6754);
    let h2 = compute_secret_hash([derive_claim_secret(
        0x1234567890abcdef,
        AztecAddress::from_field(0xdeadbeef),
    )]);
    assert(h2 == 0x2a636f84225eec69e412ed5dffd735f1ac8ff6d28b24dac5d796f0c2a648ac1c);
}

// ─── Fuzz properties (nargo runs parameterized tests with random inputs) ───
// The recipient-commitment property needs derive_claim_secret to be injective ENOUGH that a
// different (salt, recipient) never collides onto the committed secret; these random-input
// assertions pin the two one-bit-flip neighbors across the whole field domain.

#[test]
fn fuzz_derive_changes_with_salt(salt: Field, recipient_field: Field) {
    let r = AztecAddress::from_field(recipient_field);
    assert(
        derive_claim_secret(salt, r) != derive_claim_secret(salt + 1, r),
        "salt neighbor collision in derive_claim_secret",
    );
}

#[test]
fn fuzz_derive_changes_with_recipient(salt: Field, recipient_field: Field) {
    let r0 = AztecAddress::from_field(recipient_field);
    let r1 = AztecAddress::from_field(recipient_field + 1);
    assert(
        derive_claim_secret(salt, r0) != derive_claim_secret(salt, r1),
        "recipient neighbor collision in derive_claim_secret",
    );
}

// ─── Merchant token: request stamps, the paid marker and the hint capsule slots ───
// The token pushes stamp(c, b) or pad(c) when a request opens and paid(c) when it is paid, and a payment proves the
// stamp; the TS mirror (packages/bridge-core/src/stamp.ts) computes all three to predict and check them. A separator
// shared with a protocol or aztec-nr one could let another nullifier the token emits pass as one of them, so every
// known separator is excluded.

#[test]
fn merchant_stamp_separators_are_derived_and_pinned() {
    let derived = poseidon2_hash_bytes("dom_sep__merchant_token_stamp".as_bytes()) as u32;
    assert(DOM_SEP__MERCHANT_STAMP == derived);
    let derived_pad = poseidon2_hash_bytes("dom_sep__merchant_token_stamp_pad".as_bytes()) as u32;
    assert(DOM_SEP__MERCHANT_STAMP_PAD == derived_pad);
    let derived_paid =
        poseidon2_hash_bytes("dom_sep__merchant_token_request_paid".as_bytes()) as u32;
    assert(DOM_SEP__MERCHANT_REQUEST_PAID == derived_paid);
    assert(DOM_SEP__MERCHANT_STAMP == 1404036670);
    assert(DOM_SEP__MERCHANT_STAMP_PAD == 3491815610);
    assert(DOM_SEP__MERCHANT_REQUEST_PAID == 3533394975);
}

#[test]
fn merchant_stamp_separators_are_distinct_from_every_known_one() {
    assert(DOM_SEP__MERCHANT_STAMP != DOM_SEP__MERCHANT_STAMP_PAD);
    assert(DOM_SEP__MERCHANT_STAMP != DOM_SEP__MERCHANT_REQUEST_PAID);
    assert(DOM_SEP__MERCHANT_STAMP_PAD != DOM_SEP__MERCHANT_REQUEST_PAID);
    // After the protocol's: aztec-nr's crate-private ones (authwit and tx nullifiers, initialization nullifier,
    // single-use claim, partial-note commitment and completion tag, constrained-message nullifier, ECDH subkey and
    // mask, note randomness), then the claim secret's and the FPC fuel's.
    let others: [u32; 76] = [
        protocol::DOM_SEP__NOTE_HASH,
        protocol::DOM_SEP__SILOED_NOTE_HASH,
        protocol::DOM_SEP__UNIQUE_NOTE_HASH,
        protocol::DOM_SEP__NOTE_HASH_NONCE,
        protocol::DOM_SEP__NOTE_NULLIFIER,
        protocol::DOM_SEP__SILOED_NULLIFIER,
        protocol::DOM_SEP__MESSAGE_NULLIFIER,
        protocol::DOM_SEP__EVENT_LOG_TAG,
        protocol::DOM_SEP__UNCONSTRAINED_MSG_LOG_TAG,
        protocol::DOM_SEP__CONSTRAINED_MSG_LOG_TAG,
        protocol::DOM_SEP__CONSTRAINED_MSG_SENDER_SECRET,
        protocol::DOM_SEP__NON_INTERACTIVE_HANDSHAKE_LOG_TAG,
        protocol::DOM_SEP__INTERACTIVE_HANDSHAKE_SIGNATURE,
        protocol::DOM_SEP__HANDSHAKE_FORGERY_PROTECTION,
        protocol::DOM_SEP__PRIVATE_LOG_FIRST_FIELD,
        protocol::DOM_SEP__PUBLIC_LEAF_SLOT,
        protocol::DOM_SEP__PUBLIC_STORAGE_MAP_SLOT,
        protocol::DOM_SEP__MERKLE_HASH,
        protocol::DOM_SEP__NULLIFIER_MERKLE,
        protocol::DOM_SEP__PUBLIC_DATA_MERKLE,
        protocol::DOM_SEP__WRITTEN_SLOTS_MERKLE,
        protocol::DOM_SEP__RETRIEVED_BYTECODES_MERKLE,
        protocol::DOM_SEP__INBOX_ROLLING_HASH,
        protocol::DOM_SEP__PRIVATE_FUNCTION_LEAF,
        protocol::DOM_SEP__PUBLIC_BYTECODE,
        protocol::DOM_SEP__CONTRACT_CLASS_ID,
        protocol::DOM_SEP__SALTED_INITIALIZATION_HASH,
        protocol::DOM_SEP__INITIALIZER,
        protocol::DOM_SEP__NHK_M,
        protocol::DOM_SEP__IVSK_M,
        protocol::DOM_SEP__OVSK_M,
        protocol::DOM_SEP__TSK_M,
        protocol::DOM_SEP__MSSK_M,
        protocol::DOM_SEP__FBSK_M,
        protocol::DOM_SEP__PUBLIC_KEYS_HASH,
        protocol::DOM_SEP__SINGLE_PUBLIC_KEY_HASH,
        protocol::DOM_SEP__PARTIAL_ADDRESS,
        protocol::DOM_SEP__CONTRACT_ADDRESS_V3,
        protocol::DOM_SEP__BLOCK_HEADER_HASH,
        protocol::DOM_SEP__PROTOCOL_NULLIFIER,
        protocol::DOM_SEP__PUBLIC_TX_HASH,
        protocol::DOM_SEP__PRIVATE_TX_HASH,
        protocol::DOM_SEP__TX_EFFECT_CATEGORY_HASH,
        protocol::DOM_SEP__TX_EFFECT_CATEGORIES_HASH,
        protocol::DOM_SEP__TX_EFFECTS_TREE_LEAF,
        protocol::DOM_SEP__TX_EFFECTS_TREE,
        protocol::DOM_SEP__PUBLIC_CALLDATA,
        protocol::DOM_SEP__FUNCTION_ARGS,
        protocol::DOM_SEP__PROTOCOL_CONTRACTS,
        protocol::DOM_SEP__EVENT_COMMITMENT,
        protocol::DOM_SEP__AUTHWIT_INNER,
        protocol::DOM_SEP__AUTHWIT_OUTER,
        protocol::DOM_SEP__APP_SILOED_ECDH_SHARED_SECRET,
        protocol::DOM_SEP__PARTIAL_NOTE_VALIDITY_COMMITMENT,
        protocol::DOM_SEP__PUBLIC_INITIALIZATION_NULLIFIER,
        protocol::DOM_SEP__PRIVATE_INITIALIZATION_NULLIFIER,
        protocol::DOM_SEP__SECRET_HASH,
        protocol::DOM_SEP__SIGNATURE_PAYLOAD,
        protocol::DOM_SEP__BLOCK_HEADERS_HASH,
        protocol::DOM_SEP__BLOB_HASHED_Y_LIMBS,
        protocol::DOM_SEP__BLOB_CHALLENGE_Z,
        protocol::DOM_SEP__BLOB_Z_ACC,
        protocol::DOM_SEP__BLOB_GAMMA_ACC,
        protocol::DOM_SEP__BLOB_GAMMA_FINAL,
        1239150694,
        1025801951,
        1653084894,
        1465998995,
        568912195,
        3372669888,
        3723577546,
        4277646631,
        190532684,
        2943528854,
        DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET,
        3952304070,
    ];
    for other in others {
        assert(DOM_SEP__MERCHANT_STAMP != other);
        assert(DOM_SEP__MERCHANT_STAMP_PAD != other);
        assert(DOM_SEP__MERCHANT_REQUEST_PAID != other);
    }
}

#[test]
fn merchant_stamp_vectors_match_ts() {
    assert(stamp(0, 0) == 0x0246f351a2d862ef1a0b26087a58b567c43c6b71e1ffdee3846e0970b5b93eb7);
    assert(pad(0) == 0x250314702e0895fb86c6891bf980397f03d9b03867023ad8e3772a6221f3a23a);
    assert(paid(0) == 0x145475d2e73acabbba12ef12c76dca11fc59f50172069a0cc519d0f53bc0a61c);
    assert(
        stamp(0x1234, 494000) == 0x1de43c3f6d595d0365d1e86c4a907b099f093cdbbfb4a7e25ba3418054187fcd,
    );
    assert(pad(0x1234) == 0x23662d79d573c0597e92623a6bfc4d11dcb41fd3c0d34b54bff4eadaafdc3c9b);
    assert(paid(0x1234) == 0x10eaeca867df48fca9c59f06812fe5a5dcd008d5ef5dedb4ee3c4955c086b1af);
    // The last second of bucket 494000, and what the clients compute from it.
    assert(stamp_bucket(1778403599) == 494000);
    assert(stamp_bucket(1778403600) == 494001);
    assert(stamp_deadline(494000) == 1778489999);
    assert(stamp_unmarked_until(494000) == 1778407200);
}

#[test]
fn merchant_stamp_bucket_capsule_slot_is_derived_and_pinned() {
    let derived = poseidon2_hash_bytes("merchant_token_stamp_bucket_capsule_slot".as_bytes());
    assert(STAMP_BUCKET_SLOT == derived);
    assert(
        STAMP_BUCKET_SLOT == 0x2781e8e10232a75d18a5d66dda25e487067dcf360eb97ae2cfecc1166e4e946c,
    );
    assert(STAMP_BUCKET_SLOT != MERCHANT_SIDE_SLOT);
}

#[test]
fn merchant_side_capsule_slot_is_derived_and_pinned() {
    let derived = poseidon2_hash_bytes("merchant_token_side_hint_capsule_slot".as_bytes());
    assert(MERCHANT_SIDE_SLOT == derived);
    assert(
        MERCHANT_SIDE_SLOT == 0x0bfc6bf5b3874bc783b148cc9a19595a0ec8267dbf92d1ecd82ca70f441668ef,
    );
}

// The effect's head must differ from the offchain-message identifier, or the wallet would parse it as a message.
#[test]
fn merchant_request_effect_tag_is_derived_and_pinned() {
    let derived = poseidon2_hash_bytes("merchant_token_request_opened".as_bytes());
    assert(REQUEST_OPENED_EFFECT == derived);
    assert(
        REQUEST_OPENED_EFFECT == 0x2c0264a3f3d089a68139762c50b6f5f68e6cc5d8662de00195b492d228a73f73,
    );
    assert(REQUEST_OPENED_EFFECT != OFFCHAIN_MESSAGE_IDENTIFIER);
}
