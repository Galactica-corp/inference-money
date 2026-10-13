// The request rule: opening a request needs a merchant on one side, and records which with a stamp or a pad; a user
// may pay only into a request whose stamp is still live (opened for a merchant, within the last day), a merchant into
// any; and a request takes one payment.
use crate::{test::utils::{self, MerchantWorld, mint_amount}, Token};
use aztec::{
    protocol::address::AztecAddress,
    test::helpers::{authwit as authwit_cheatcodes, txe_oracles::get_last_call_offchain_effects},
};
use generic_proxy::GenericProxy;
use merchant_stamp::{pad, REQUEST_OPENED_EFFECT, stamp, stamp_bucket, stamp_deadline};

global AMOUNT: u128 = 100;

unconstrained fn has_nullifier(w: MerchantWorld, nullifier: Field) -> bool {
    w.env.public_context(|context| context.nullifier_exists_unsafe(nullifier, w.token))
}

// TXE's clock moves only when a test moves it, so the next private call anchors in this bucket.
unconstrained fn bucket_now(w: MerchantWorld) -> u64 {
    stamp_bucket(w.env.last_block_timestamp())
}

unconstrained fn assert_stamped(w: MerchantWorld, commitment: Field, bucket: u64) {
    assert(
        has_nullifier(w, stamp(commitment, bucket)),
        "request should be stamped in its anchor's bucket",
    );
    assert(!has_nullifier(w, pad(commitment)), "a stamped request should not be padded");
}

unconstrained fn assert_padded(w: MerchantWorld, commitment: Field, bucket: u64) {
    assert(has_nullifier(w, pad(commitment)), "request should be padded");
    assert(!has_nullifier(w, stamp(commitment, bucket)), "a padded request should not be stamped");
}

/// A request for `m1` that `completer` may pay, with the bucket of its stamp.
unconstrained fn stamped_request(w: MerchantWorld, completer: AztecAddress) -> (Field, u64) {
    let bucket = bucket_now(w);
    let c = w.env.call_private(
        completer,
        Token::at(w.token).initialize_transfer_commitment(w.m1, completer),
    );
    (c, bucket)
}

#[test]
unconstrained fn a_request_a_user_opens_for_a_merchant_is_stamped() {
    let w = utils::setup_merchant_world(false);
    let (c, bucket) = stamped_request(w, w.alice);
    assert_stamped(w, c, bucket);
}

#[test]
unconstrained fn a_request_a_merchant_opens_for_a_user_is_padded() {
    let w = utils::setup_merchant_world(false);
    let bucket = bucket_now(w);
    let c =
        w.env.call_private(w.m1, Token::at(w.token).initialize_transfer_commitment(w.alice, w.m1));
    assert_padded(w, c, bucket);
}

// A merchant recipient is always proven when opening, so a merchant's request is never padded.
#[test]
unconstrained fn a_request_a_merchant_opens_for_a_merchant_is_stamped() {
    let w = utils::setup_merchant_world(false);
    let bucket = bucket_now(w);
    let c = w.env.call_private(w.m1, Token::at(w.token).initialize_transfer_commitment(w.m2, w.m1));
    assert_stamped(w, c, bucket);
}

// The last call's request effects: how many, and the commitment the last one carries.
unconstrained fn request_effects() -> (u32, Field) {
    let effects = get_last_call_offchain_effects();
    let mut found = 0;
    let mut carried = 0;
    for i in 0..effects.len() {
        let e = effects.get(i);
        if (e.len() == 2) & (e.get(0) == REQUEST_OPENED_EFFECT) {
            carried = e.get(1);
            found += 1;
        }
    }
    (found, carried)
}

// A sent tx returns no private return values, so the opener's client learns the commitment from this effect alone.
unconstrained fn assert_handed_over(commitment: Field) {
    assert_eq(
        request_effects(),
        (1, commitment),
        "one opening should emit one effect carrying its commitment",
    );
}

#[test]
unconstrained fn an_opening_hands_the_commitment_to_the_opener() {
    let w = utils::setup_merchant_world(false);
    let c = w.env.call_private(
        w.alice,
        Token::at(w.token).initialize_transfer_commitment(w.m1, w.alice),
    );
    assert_handed_over(c);
}

#[test(should_fail_with = "Request refused: neither creator nor recipient is a merchant")]
unconstrained fn a_user_cannot_open_a_request_for_a_user() {
    let w = utils::setup_merchant_world(false);
    let _ = w.env.call_private(
        w.alice,
        Token::at(w.token).initialize_transfer_commitment(w.bob, w.alice),
    );
}

// A refund commitment is the payer's and opens no request: no stamp, no pad, no effect. Its completer refunds it
// from a merchant.
#[test]
unconstrained fn a_merchant_refunds_a_users_commitment_unstamped() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let bucket = bucket_now(w);
    let c = w.env.call_private(
        w.alice,
        token.transfer_private_to_public_with_commitment(w.alice, w.m1, AMOUNT, 0),
    );
    assert_eq(request_effects().0, 0, "a refund commitment should emit no request effect");
    assert(!has_nullifier(w, stamp(c, bucket)), "a refund commitment should not be stamped");
    assert(!has_nullifier(w, pad(c)), "a refund commitment should not be padded");
    let refund = AMOUNT / 4;
    let give_back = token.transfer_public_to_commitment(w.m1, c, refund, 0);
    authwit_cheatcodes::add_public_authwit_from_call(w.env, w.m1, w.alice, give_back);
    w.env.call_public(w.alice, give_back);
    utils::check_private_balance(w.env, w.token, w.alice, mint_amount - AMOUNT + refund);
    utils::check_public_balance(w.env, w.token, w.m1, mint_amount + AMOUNT - refund);
}

/// Carol opens a free refund commitment through Bob's proxy, which so becomes its completer: were it stamped,
/// Bob could pay Carol through it, user to user.
unconstrained fn a_free_refund_commitment(
    w: MerchantWorld,
    carol: AztecAddress,
    proxy: AztecAddress,
) -> Field {
    let open = Token::at(w.token).transfer_private_to_public_with_commitment(carol, w.m1, 0, 0);
    authwit_cheatcodes::add_private_authwit_from_call(w.env, carol, proxy, open);
    let c: Field = w.env.call_private(
        carol,
        GenericProxy::at(proxy).forward_private_4_and_return(
            open.target_contract,
            open.selector,
            open.args,
        ),
    );
    c
}

#[test(should_fail_with = "Payment refused: users may only pay into requests opened for a merchant")]
unconstrained fn a_user_cannot_pay_into_a_users_refund_commitment() {
    let mut w = utils::setup_merchant_world(true);
    let (carol, bob) = (w.alice, w.bob);
    let proxy = w.env.deploy("@generic_proxy/GenericProxy").without_initializer();
    let c = a_free_refund_commitment(w, carol, proxy);
    w.env.call_public(w.minter, Token::at(w.token).mint_to_public(bob, mint_amount));
    let pay = Token::at(w.token).transfer_public_to_commitment(bob, c, AMOUNT, 0);
    authwit_cheatcodes::add_public_authwit_from_call(w.env, bob, proxy, pay);
    w.env.call_public(
        bob,
        GenericProxy::at(proxy).forward_public_4(pay.target_contract, pay.selector, pay.args),
    );
}

#[test(should_fail_with = "Payment refused: users may only pay into requests opened for a merchant")]
unconstrained fn a_user_cannot_pay_into_a_users_refund_commitment_privately() {
    let mut w = utils::setup_merchant_world(true);
    let (carol, bob) = (w.alice, w.bob);
    let proxy = w.env.deploy("@generic_proxy/GenericProxy").without_initializer();
    let c = a_free_refund_commitment(w, carol, proxy);
    utils::mint_to_private(w.env, w.token, bob, mint_amount, w.minter);
    let pay = Token::at(w.token).transfer_private_to_commitment(bob, c, AMOUNT, 0);
    authwit_cheatcodes::add_private_authwit_from_call(w.env, bob, proxy, pay);
    w.env.call_private(
        bob,
        GenericProxy::at(proxy).forward_private_4(pay.target_contract, pay.selector, pay.args),
    );
}

#[test]
unconstrained fn a_user_pays_a_merchants_request_privately() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let c = w.env.call_private(w.alice, token.initialize_transfer_commitment(w.m1, w.alice));
    w.env.call_private(w.alice, token.transfer_private_to_commitment(w.alice, c, AMOUNT, 0));
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount + AMOUNT);
    utils::check_private_balance(w.env, w.token, w.alice, mint_amount - AMOUNT);
}

// A merchant cannot open a request for Carol that Bob, a user, then pays: Bob paying Carol is user to user.
#[test(should_fail_with = "Payment refused: users may only pay into requests opened for a merchant")]
unconstrained fn a_user_cannot_pay_a_request_opened_for_a_user() {
    let w = utils::setup_merchant_world(false);
    let (carol, bob) = (w.alice, w.bob);
    utils::mint_to_private(w.env, w.token, bob, mint_amount, w.minter);
    let token = Token::at(w.token);
    let c = w.env.call_private(w.m1, token.initialize_transfer_commitment(carol, bob));
    w.env.call_private(bob, token.transfer_private_to_commitment(bob, c, AMOUNT, 0));
}

#[test]
unconstrained fn a_merchant_pays_an_unstamped_request() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let c = w.env.call_private(w.m1, token.initialize_transfer_commitment(w.bob, w.m2));
    w.env.call_private(w.m2, token.transfer_private_to_commitment(w.m2, c, AMOUNT, 0));
    utils::check_private_balance(w.env, w.token, w.bob, AMOUNT);
}

#[test]
unconstrained fn a_user_pays_a_merchants_request_publicly() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let c = w.env.call_private(w.alice, token.initialize_transfer_commitment(w.m1, w.alice));
    w.env.call_public(w.alice, token.transfer_public_to_commitment(w.alice, c, AMOUNT, 0));
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount + AMOUNT);
    utils::check_public_balance(w.env, w.token, w.alice, mint_amount - AMOUNT);
}

#[test(should_fail_with = "Payment refused: users may only pay into requests opened for a merchant")]
unconstrained fn a_user_cannot_pay_a_request_opened_for_a_user_publicly() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let c = w.env.call_private(w.m1, token.initialize_transfer_commitment(w.bob, w.alice));
    w.env.call_public(w.alice, token.transfer_public_to_commitment(w.alice, c, AMOUNT, 0));
}

#[test]
unconstrained fn a_merchant_pays_an_unstamped_request_publicly() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let c = w.env.call_private(w.m1, token.initialize_transfer_commitment(w.bob, w.m2));
    w.env.call_public(w.m2, token.transfer_public_to_commitment(w.m2, c, AMOUNT, 0));
    utils::check_private_balance(w.env, w.token, w.bob, AMOUNT);
}

// A stamp records who the request was opened for at the time, so switching that merchant off does not revoke it; it
// ends with the stamp, at an anchor one second past its deadline.
#[test]
unconstrained fn a_request_stamped_for_a_merchant_stays_payable_after_its_switch_off_until_its_stamp_expires() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let (c, bucket) = stamped_request(w, w.alice);
    w.env.call_public(w.admin, token.schedule_merchant_off(w.m1, true));
    utils::anchor_at(w.env, stamp_deadline(bucket));
    assert(!w.env.view_public(token.is_merchant(w.m1)));
    w.env.call_private(w.alice, token.transfer_private_to_commitment(w.alice, c, AMOUNT, 0));
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount + AMOUNT);
}

// The probe searches live buckets only, so an expired stamp reads as none.
#[test(should_fail_with = "Payment refused: users may only pay into requests opened for a merchant")]
unconstrained fn a_user_cannot_pay_a_stamped_request_privately_once_its_stamp_expired() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let (c, bucket) = stamped_request(w, w.alice);
    utils::anchor_at(w.env, stamp_deadline(bucket) + 1);
    w.env.call_private(w.alice, token.transfer_private_to_commitment(w.alice, c, AMOUNT, 0));
}

// At the deadline the stamp sits in the last bucket searched.
#[test]
unconstrained fn a_user_pays_a_stamped_request_publicly_from_its_oldest_live_bucket() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let (c, bucket) = stamped_request(w, w.alice);
    utils::anchor_at(w.env, stamp_deadline(bucket));
    w.env.call_public(w.alice, token.transfer_public_to_commitment(w.alice, c, AMOUNT, 0));
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount + AMOUNT);
}

#[test(should_fail_with = "Payment refused: users may only pay into requests opened for a merchant")]
unconstrained fn a_user_cannot_pay_a_stamped_request_publicly_once_its_stamp_expired() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let (c, bucket) = stamped_request(w, w.alice);
    utils::anchor_at(w.env, stamp_deadline(bucket) + 1);
    w.env.call_public(w.alice, token.transfer_public_to_commitment(w.alice, c, AMOUNT, 0));
}

// A merchant needs no stamp: with none live, the token proves the payer.
#[test]
unconstrained fn a_merchant_pays_a_request_whose_stamp_expired() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let (privately, bucket) = stamped_request(w, w.m2);
    let (publicly, _) = stamped_request(w, w.m2);
    utils::anchor_at(w.env, stamp_deadline(bucket) + 1);
    w.env.call_private(w.m2, token.transfer_private_to_commitment(w.m2, privately, AMOUNT, 0));
    w.env.call_public(w.m2, token.transfer_public_to_commitment(w.m2, publicly, AMOUNT, 0));
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount + 2 * AMOUNT);
}

#[test(should_fail_with = "Payment refused: the request is already paid")]
unconstrained fn a_request_paid_privately_cannot_be_paid_publicly() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let (c, _) = stamped_request(w, w.alice);
    w.env.call_private(w.alice, token.transfer_private_to_commitment(w.alice, c, AMOUNT, 0));
    w.env.call_public(w.alice, token.transfer_public_to_commitment(w.alice, c, AMOUNT, 0));
}

#[test(should_fail_with = "Payment refused: the request is already paid")]
unconstrained fn a_request_paid_publicly_cannot_be_paid_privately() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let (c, _) = stamped_request(w, w.alice);
    w.env.call_public(w.alice, token.transfer_public_to_commitment(w.alice, c, AMOUNT, 0));
    w.env.call_private(w.alice, token.transfer_private_to_commitment(w.alice, c, AMOUNT, 0));
}

// Upstream's private completion accepts zero, and a zero payment would spend the request's one payment.
#[test(should_fail_with = "Payment refused: the amount is zero")]
unconstrained fn a_private_payment_of_zero_is_refused() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let (c, _) = stamped_request(w, w.alice);
    w.env.call_private(w.alice, token.transfer_private_to_commitment(w.alice, c, 0, 0));
}

#[test(should_fail_with = "Payment refused: the amount is zero")]
unconstrained fn a_public_payment_of_zero_is_refused() {
    let w = utils::setup_merchant_world(false);
    let token = Token::at(w.token);
    let (c, _) = stamped_request(w, w.alice);
    w.env.call_public(w.alice, token.transfer_public_to_commitment(w.alice, c, 0, 0));
}

// An opening is judged on its creator and recipient: a merchant completer does not make it a merchant's request.
#[test(should_fail_with = "Request refused: neither creator nor recipient is a merchant")]
unconstrained fn naming_a_merchant_completer_does_not_let_a_user_open_for_a_user() {
    let w = utils::setup_merchant_world(false);
    let _ = w.env.call_private(
        w.alice,
        Token::at(w.token).initialize_transfer_commitment(w.bob, w.m1),
    );
}
