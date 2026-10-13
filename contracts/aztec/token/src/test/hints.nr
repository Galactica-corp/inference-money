// The side hint: the probe's three rules against real list state, a capsule's precedence, and why a lying hint can
// only fail. TXE serves the contract's oracles itself, so a test cannot make the probe lie; a capsule is the same
// unconstrained input to the same proof, so the lying-capsule cases cover a lying probe too.
use crate::{
    hints::{
        FIRST, MERCHANT_MAX_DELAY, MERCHANT_MIN_DELAY, merchant_horizon, merchant_side_hint,
        MerchantList, NEITHER, payment_side_hint, SECOND,
    },
    test::utils::{self, MerchantWorld, mint_amount, switch_off},
    Token,
};
use aztec::{
    context::PrivateContext,
    oracle::capsules,
    protocol::{address::AztecAddress, storage::map::derive_storage_slot_in_map},
    state_vars::{DelayedPublicMutable, StateVariable},
    test::helpers::test_environment::TestEnvironment,
};
use merchant_stamp::{
    MERCHANT_SIDE_SLOT, stamp_bucket, STAMP_BUCKET_SLOT, stamp_deadline, stamp_unmarked_until,
};

global AMOUNT: u128 = 100;
global HOUR: u64 = 3600;

unconstrained fn list_at_anchor(env: TestEnvironment, token: AztecAddress) -> MerchantList {
    env.private_context_at(token, |context| {
        MerchantList {
            this: token,
            anchor: context.get_anchor_block_header(),
            merchants_slot: Token::storage_layout().merchants.slot,
            merchant_off_slot: Token::storage_layout().merchant_off.slot,
        }
    })
}

unconstrained fn side(
    w: MerchantWorld,
    first: AztecAddress,
    second: AztecAddress,
    keep_first: bool,
) -> u8 {
    let list = list_at_anchor(w.env, w.token);
    w.env.private_context_at(w.token, |_| merchant_side_hint(list, first, second, keep_first))
}

// Both measured from the anchor: the horizon the hint compares, and the expiry cap the token's own read of the entry
// sets (aztec-nr's `get_current_value`), which the hint must mirror.
unconstrained fn horizon_and_cap(w: MerchantWorld, account: AztecAddress) -> (u64, u64) {
    let list = list_at_anchor(w.env, w.token);
    let anchor = list.anchor.timestamp();
    let horizon = w.env.private_context_at(w.token, |_| merchant_horizon(list, account));
    let cap = w.env.private_context_at(w.token, |context| {
        let slot = derive_storage_slot_in_map(Token::storage_layout().merchant_off.slot, account);
        let entry: DelayedPublicMutable<bool, MERCHANT_MIN_DELAY, &mut PrivateContext> =
            StateVariable::new(context, slot);
        let _ = entry.get_current_value();
        context.finish().expiration_timestamp
    });
    (horizon - anchor, cap - anchor)
}

unconstrained fn assert_horizon(w: MerchantWorld, account: AztecAddress, expected: u64) {
    assert_eq(horizon_and_cap(w, account), (expected, expected));
}

/// Schedules a decrease of `merchant`'s delay to the hour; returns when it lands (DelayedPublicMutable waits old - new).
unconstrained fn shorten_delay(w: MerchantWorld, merchant: AztecAddress) -> u64 {
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(MERCHANT_MIN_DELAY));
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(merchant));
    t0 + MERCHANT_MAX_DELAY - MERCHANT_MIN_DELAY
}

unconstrained fn payment_side(
    w: MerchantWorld,
    commitment: Field,
    from: AztecAddress,
) -> (u8, u64) {
    let list = list_at_anchor(w.env, w.token);
    w.env.private_context_at(w.token, |_| payment_side_hint(list, commitment, from))
}

// Stands in for the capsule bridge-core attaches to a tx: TXE takes none per call, but the PXE falls back from a
// tx's capsules to the contract's stored ones, so a stored capsule reaches every later call.
unconstrained fn store_capsule(w: MerchantWorld, slot: Field, value: Field) {
    w.env.private_context_at(w.token, |context| {
        capsules::store(context.this_address(), slot, value, AztecAddress::zero())
    });
}

unconstrained fn store_side_capsule(w: MerchantWorld, value: Field) {
    store_capsule(w, MERCHANT_SIDE_SLOT, value);
}

unconstrained fn store_bucket_capsule(w: MerchantWorld, bucket: u64) {
    store_capsule(w, STAMP_BUCKET_SLOT, bucket as Field);
}

/// A request for `m1` that alice may pay, with the bucket of its stamp.
unconstrained fn stamped_request(w: MerchantWorld) -> (Field, u64) {
    let bucket = stamp_bucket(w.env.last_block_timestamp());
    let c = w.env.call_private(
        w.alice,
        Token::at(w.token).initialize_transfer_commitment(w.m1, w.alice),
    );
    (c, bucket)
}

#[test]
unconstrained fn the_probe_finds_the_one_merchant_side_or_neither() {
    let w = utils::setup_merchant_world(false);
    assert_eq(side(w, w.m1, w.alice, false), FIRST);
    assert_eq(side(w, w.alice, w.m1, false), SECOND);
    assert_eq(side(w, w.alice, w.bob, false), NEITHER);
    assert_eq(side(w, w.alice, w.bob, true), NEITHER);
}

#[test]
unconstrained fn between_two_settled_merchants_the_probe_proves_the_recipient() {
    let w = utils::setup_merchant_world(false);
    assert_eq(side(w, w.m1, w.m2, false), FIRST);
}

#[test]
unconstrained fn of_two_merchants_the_probe_proves_the_one_with_the_later_cap() {
    let w = utils::setup_merchant_world(false);
    let _ = switch_off(w, w.m1);
    // A second on, m1's read still leaves the standard expiry, so it is proven without asking about m2.
    utils::anchor_at(w.env, w.env.last_block_timestamp() + 1);
    assert_eq(side(w, w.m1, w.m2, false), FIRST);
    // Four hours on, m1's read shortens the tx and m2's, settled, does not.
    utils::anchor_at(w.env, w.env.last_block_timestamp() + 4 * HOUR);
    assert_eq(side(w, w.m1, w.m2, false), SECOND);
    // A kept side is proven whatever its cap, so a merchant's request is stamped.
    assert_eq(side(w, w.m1, w.m2, true), FIRST);
    // m2's switch-off lands later than m1's; four hours on, both reads shorten the tx, m2's less.
    let _ = switch_off(w, w.m2);
    utils::anchor_at(w.env, w.env.last_block_timestamp() + 4 * HOUR);
    assert_eq(side(w, w.m1, w.m2, false), SECOND);
    assert_eq(side(w, w.m2, w.m1, false), FIRST);
}

// A shortened delay caps a read earlier from the moment it is synced, not only once it lands.
#[test]
unconstrained fn of_two_merchants_a_shortened_delay_is_proven_last() {
    let w = utils::setup_merchant_world(false);
    let lands = shorten_delay(w, w.m1);
    utils::anchor_at(w.env, w.env.last_block_timestamp() + 2 * HOUR);
    assert_eq(side(w, w.m1, w.m2, false), SECOND);
    assert_eq(side(w, w.m2, w.m1, false), FIRST);
    utils::anchor_at(w.env, lands);
    assert_eq(side(w, w.m1, w.m2, false), SECOND);
    assert_eq(side(w, w.m2, w.m1, false), FIRST);
}

#[test]
unconstrained fn a_merchant_read_caps_expiry_at_the_entrys_horizon() {
    let w = utils::setup_merchant_world(false);
    assert_horizon(w, w.m1, MERCHANT_MAX_DELAY - 1);
    // A switch-off pending: just before it lands.
    let _ = switch_off(w, w.m1);
    utils::anchor_at(w.env, w.env.last_block_timestamp() + 1);
    assert_horizon(w, w.m1, MERCHANT_MAX_DELAY - 2);
    // A decrease to the hour synced at t: the old delay still bounds it from t, two hours in.
    let t = w.env.last_block_timestamp();
    let lands = shorten_delay(w, w.m2);
    utils::anchor_at(w.env, t + 2 * HOUR);
    assert_horizon(w, w.m2, MERCHANT_MAX_DELAY - 2 * HOUR - 1);
    // A second before the decrease lands, the earliest change is a second plus an hour away; from the landing, an hour.
    utils::anchor_at(w.env, lands - 1);
    assert_horizon(w, w.m2, MERCHANT_MIN_DELAY);
    utils::anchor_at(w.env, lands);
    assert_horizon(w, w.m2, MERCHANT_MIN_DELAY - 1);
    utils::anchor_at(w.env, lands + 1);
    assert_horizon(w, w.m2, MERCHANT_MIN_DELAY - 1);
    // An unlisted account is never read, so it has no horizon.
    let list = list_at_anchor(w.env, w.token);
    assert_eq(w.env.private_context_at(w.token, |_| merchant_horizon(list, w.bob)), 0);
}

// A cancel schedules the current value, a change aztec-nr's horizon ignores: the read caps as a settled entry's does.
#[test]
unconstrained fn a_cancelled_entry_reads_unmarked() {
    let w = utils::setup_merchant_world(false);
    let _ = switch_off(w, w.m1);
    w.env.call_public(w.admin, Token::at(w.token).cancel_merchant_change(w.m1));
    utils::anchor_at(w.env, w.env.last_block_timestamp() + 1);
    assert_horizon(w, w.m1, MERCHANT_MAX_DELAY - 1);
}

// The call publishes its sender, so a merchant sender is proven even while the hidden recipient's read would cap later.
// TXE cannot see which entry a real call read; check-stamp-constraint.sh pins the call's `(from, to, true)`.
#[test]
unconstrained fn public_to_private_proves_a_merchant_sender_not_the_hidden_recipient() {
    let w = utils::setup_merchant_world(false);
    let _ = switch_off(w, w.m1);
    // Two hours on, the sender's read no longer leaves the standard expiry, so only keeping it picks it.
    utils::anchor_at(w.env, w.env.last_block_timestamp() + 2 * HOUR);
    assert_eq(side(w, w.m1, w.m2, false), SECOND);
    assert_eq(side(w, w.m1, w.m2, true), FIRST);
    w.env.call_private(
        w.m1,
        Token::at(w.token).transfer_public_to_private(w.m1, w.m2, AMOUNT, 0),
    );
    utils::check_private_balance(w.env, w.token, w.m2, mint_amount + AMOUNT);
}

#[test]
unconstrained fn private_to_public_proves_a_merchant_recipient_not_the_hidden_sender() {
    let w = utils::setup_merchant_world(false);
    let _ = switch_off(w, w.m1);
    utils::anchor_at(w.env, w.env.last_block_timestamp() + 2 * HOUR);
    assert_eq(side(w, w.m1, w.m2, false), SECOND);
    assert_eq(side(w, w.m1, w.m2, true), FIRST);
    w.env.call_private(
        w.m2,
        Token::at(w.token).transfer_private_to_public(w.m2, w.m1, AMOUNT, 0),
    );
    utils::check_public_balance(w.env, w.token, w.m1, mint_amount + AMOUNT);
}

#[test]
unconstrained fn a_switched_off_merchant_is_never_picked() {
    let w = utils::setup_merchant_world(false);
    let off_at = switch_off(w, w.m1);
    utils::anchor_at(w.env, off_at);
    assert_eq(side(w, w.m1, w.alice, false), NEITHER);
    assert_eq(side(w, w.m1, w.m2, true), SECOND);
}

// A stamp still unmarked, else a settled merchant payer, else a live stamp, else neither.
#[test]
unconstrained fn the_payment_probe_follows_its_order() {
    let w = utils::setup_merchant_world(false);
    let (stamped, bucket) = stamped_request(w);
    let padded =
        w.env.call_private(w.m1, Token::at(w.token).initialize_transfer_commitment(w.bob, w.m2));
    assert_eq(payment_side(w, padded, w.m2), (SECOND, 0));
    assert_eq(payment_side(w, padded, w.alice), (NEITHER, 0));

    utils::anchor_at(w.env, stamp_unmarked_until(bucket) - 1);
    assert_eq(payment_side(w, stamped, w.m2), (FIRST, bucket));
    assert_eq(payment_side(w, stamped, w.alice), (FIRST, bucket));

    utils::anchor_at(w.env, stamp_unmarked_until(bucket));
    assert_eq(payment_side(w, stamped, w.m2), (SECOND, bucket));
    assert_eq(payment_side(w, stamped, w.alice), (FIRST, bucket));

    utils::anchor_at(w.env, stamp_deadline(bucket));
    assert_eq(payment_side(w, stamped, w.alice), (FIRST, bucket));

    utils::anchor_at(w.env, stamp_deadline(bucket) + 1);
    assert_eq(payment_side(w, stamped, w.m2), (SECOND, 0));
    assert_eq(payment_side(w, stamped, w.alice), (NEITHER, 0));
}

// A payer whose pending switch-off shortens the tx would name itself by the change's public time, so the live stamp,
// whose cap tells only the request's hour, is proven, even where the payer's cap is the later one; a payer settled at
// 24 h marks nothing and is proven.
#[test]
unconstrained fn a_marked_merchant_payer_pays_through_a_live_stamp() {
    let w = utils::setup_merchant_world(false);
    let (stamped, bucket) = stamped_request(w);
    utils::anchor_at(w.env, w.env.last_block_timestamp() + 5 * HOUR);
    let off_at = switch_off(w, w.m2);
    let anchor = stamp_deadline(bucket) - 6 * HOUR;
    utils::anchor_at(w.env, anchor);
    assert_horizon(w, w.m2, off_at - 1 - anchor);
    assert(off_at - 1 > stamp_deadline(bucket));
    assert_eq(payment_side(w, stamped, w.m2), (FIRST, bucket));
    assert_eq(payment_side(w, stamped, w.m1), (SECOND, bucket));
}

#[test]
unconstrained fn a_capsule_overrides_the_probe() {
    let w = utils::setup_merchant_world(false);
    store_side_capsule(w, SECOND as Field);
    assert_eq(side(w, w.m1, w.m2, false), SECOND);
    assert_eq(side(w, w.alice, w.bob, false), SECOND);
}

// The hint is unconstrained, so a side outside FIRST/SECOND/NEITHER must still prove something: the second side.
#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn an_out_of_range_side_proves_the_sender() {
    let w = utils::setup_merchant_world(false);
    store_side_capsule(w, 3);
    w.env.call_private(
        w.alice,
        Token::at(w.token).transfer_private_to_private(w.alice, w.m1, AMOUNT, 0),
    );
}

#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn an_out_of_range_side_proves_the_payer_not_the_stamp() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let stamped = w.env.call_private(w.alice, token.initialize_transfer_commitment(w.m1, w.alice));
    store_side_capsule(w, 3);
    w.env.call_private(w.alice, token.transfer_private_to_commitment(w.alice, stamped, AMOUNT, 0));
}

// The capsule is honoured on a real transfer: naming the merchant sender instead of the merchant recipient still
// proves a merchant, so the transfer goes through.
#[test]
unconstrained fn a_transfer_proves_the_side_its_capsule_names() {
    let w = utils::setup_merchant_world(false);
    store_side_capsule(w, SECOND as Field);
    w.env.call_private(w.m1, Token::at(w.token).transfer_private_to_private(w.m1, w.m2, AMOUNT, 0));
    utils::check_private_balance(w.env, w.token, w.m2, mint_amount + AMOUNT);
}

#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn a_capsule_naming_a_user_fails_the_proof() {
    let w = utils::setup_merchant_world(false);
    store_side_capsule(w, FIRST as Field);
    w.env.call_private(
        w.alice,
        Token::at(w.token).transfer_private_to_private(w.alice, w.bob, AMOUNT, 0),
    );
}

#[test(should_fail_with = "Merchant is switched off")]
unconstrained fn a_capsule_naming_a_switched_off_merchant_fails_the_proof() {
    let w = utils::setup_merchant_world(false);
    let off_at = switch_off(w, w.m1);
    utils::anchor_at(w.env, off_at);
    store_side_capsule(w, FIRST as Field);
    w.env.call_private(
        w.alice,
        Token::at(w.token).transfer_private_to_private(w.alice, w.m1, AMOUNT, 0),
    );
}

#[test(should_fail_with = "Payment refused: users may only pay into requests opened for a merchant")]
unconstrained fn a_capsule_claiming_a_missing_stamp_fails_the_payment() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let padded = w.env.call_private(w.m1, token.initialize_transfer_commitment(w.bob, w.alice));
    store_side_capsule(w, FIRST as Field);
    w.env.call_private(w.alice, token.transfer_private_to_commitment(w.alice, padded, AMOUNT, 0));
}

// The bucket named feeds the deadline enforced, so a true stamp past its deadline is refused in the circuit, whatever
// the hint says.
#[test(should_fail_with = "Payment refused: the request's stamp has expired")]
unconstrained fn a_capsule_naming_an_expired_stamp_fails_the_payment() {
    let w = utils::setup_merchant_world(false);
    let (stamped, bucket) = stamped_request(w);
    utils::anchor_at(w.env, stamp_deadline(bucket) + 1);
    store_side_capsule(w, FIRST as Field);
    store_bucket_capsule(w, bucket);
    w.env.call_private(
        w.alice,
        Token::at(w.token).transfer_private_to_commitment(w.alice, stamped, AMOUNT, 0),
    );
}

// A later bucket would buy a later deadline, but the stamp proven is that bucket's, and there is none.
#[test(should_fail_with = "Payment refused: users may only pay into requests opened for a merchant")]
unconstrained fn a_capsule_naming_another_bucket_fails_the_payment() {
    let w = utils::setup_merchant_world(false);
    let (stamped, bucket) = stamped_request(w);
    store_bucket_capsule(w, bucket + 1);
    w.env.call_private(
        w.alice,
        Token::at(w.token).transfer_private_to_commitment(w.alice, stamped, AMOUNT, 0),
    );
}

#[test]
unconstrained fn try_prove_merchant_proves_a_merchant_and_only_claims_a_user() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    assert(w.env.view_private(w.alice, token.try_prove_merchant(w.m1)));
    assert(!w.env.view_private(w.alice, token.try_prove_merchant(w.bob)));
    let off_at = switch_off(w, w.m1);
    utils::anchor_at(w.env, off_at);
    assert(!w.env.view_private(w.alice, token.try_prove_merchant(w.m1)));
}
