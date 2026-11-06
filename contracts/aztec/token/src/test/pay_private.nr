// pay_private: a private transfer under a payment reference whose recipient note and PaymentReceived event travel
// offchain. The recipient's balance moves only once it feeds the tx's messages to `offchain_receive`, and the event it
// then holds names the reference and the amount.
use crate::{test::utils::{self, mint_amount, MerchantWorld}, Token};
use aztec::{
    event::{event_interface::EventInterface, EventSelector},
    messages::processing::offchain::{MAX_OFFCHAIN_MESSAGES_PER_RECEIVE_CALL, OffchainMessage},
    protocol::{address::AztecAddress, traits::ToField},
    test::helpers::{authwit as authwit_cheatcodes, test_environment::TestEnvironment, txe_oracles},
};
use generic_proxy::GenericProxy;
use merchant_stamp::paid_ref;

global AMOUNT: u128 = 100;
global REF: Field = 0x5eed;
global DAY: u64 = 86400;

// aztec-nr keeps its TXE event oracle crate-private; this is the same oracle, its bounds copied from txe_oracles.nr.
#[oracle(aztec_txe_getPrivateEvents)]
unconstrained fn get_private_events(
    selector: EventSelector,
    contract_address: AztecAddress,
    scope: AztecAddress,
) -> BoundedVec<BoundedVec<Field, 10>, 5> {}

// The messages the last call emitted, as one receive batch.
unconstrained fn last_messages(env: TestEnvironment) -> BoundedVec<OffchainMessage, MAX_OFFCHAIN_MESSAGES_PER_RECEIVE_CALL> {
    let messages = env.offchain_messages();
    let mut batch = BoundedVec::new();
    for i in 0..messages.len() {
        batch.push(messages.get(i));
    }
    batch
}

unconstrained fn receive(
    env: TestEnvironment,
    token: AztecAddress,
    batch: BoundedVec<OffchainMessage, MAX_OFFCHAIN_MESSAGES_PER_RECEIVE_CALL>,
) {
    env.execute_utility(Token::at(token).offchain_receive(batch));
}

unconstrained fn payments_seen_by(
    env: TestEnvironment,
    token: AztecAddress,
    account: AztecAddress,
) -> BoundedVec<BoundedVec<Field, 10>, 5> {
    // A utility call first: it syncs `account`'s inbox before the events are read.
    let _ = utils::get_private_balance(env, token, account);
    get_private_events(Token::PaymentReceived::get_event_type_id(), token, account)
}

unconstrained fn pay(w: MerchantWorld, from: AztecAddress, to: AztecAddress, amount: u128, payment_ref: Field) {
    w.env.call_private(from, Token::at(w.token).pay_private(from, to, amount, payment_ref, 0));
}

#[test]
unconstrained fn a_merchant_receives_a_payment_only_through_its_offchain_messages() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    let batch = last_messages(w.env);
    // The recipient's note and its event; the payer's change is delivered onchain to itself.
    assert_eq(batch.len(), 2);
    for i in 0..batch.len() {
        assert_eq(batch.get(i).recipient, w.m1);
    }
    utils::check_private_balance(w.env, w.token, w.alice, mint_amount - AMOUNT);
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount);
    assert_eq(payments_seen_by(w.env, w.token, w.m1).len(), 0);

    receive(w.env, w.token, batch);
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount + AMOUNT);
    let events = payments_seen_by(w.env, w.token, w.m1);
    assert_eq(events.len(), 1);
    assert_eq(events.get(0), BoundedVec::from_array([REF, AMOUNT as Field]));
}

#[test]
unconstrained fn receiving_the_same_messages_twice_counts_the_payment_once() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    let batch = last_messages(w.env);
    receive(w.env, w.token, batch);
    receive(w.env, w.token, batch);
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount + AMOUNT);
    assert_eq(payments_seen_by(w.env, w.token, w.m1).len(), 1);
}

// Messages fed to the wrong account decrypt to nothing: neither the bystander nor the recipient gains from them.
#[test]
unconstrained fn another_account_cannot_take_in_a_payment_meant_for_a_merchant() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    let mut batch = last_messages(w.env);
    for i in 0..batch.len() {
        let mut message = batch.get(i);
        message.recipient = w.m2;
        batch.set(i, message);
    }
    receive(w.env, w.token, batch);
    utils::check_private_balance(w.env, w.token, w.m2, mint_amount);
    assert_eq(payments_seen_by(w.env, w.token, w.m2).len(), 0);
}

// A flipped field of the encrypted body (past the ephemeral key, before the random padding) corrupts the plaintext,
// and the PXE accepts a note or an event only if its hash or commitment is in the named tx.
#[test]
unconstrained fn an_altered_message_is_dropped() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    let mut batch = last_messages(w.env);
    for i in 0..batch.len() {
        let mut message = batch.get(i);
        let mut ciphertext = message.ciphertext;
        ciphertext.set(2, ciphertext.get(2) + 1);
        message.ciphertext = ciphertext;
        batch.set(i, message);
    }
    receive(w.env, w.token, batch);
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount);
    assert_eq(payments_seen_by(w.env, w.token, w.m1).len(), 0);
}

#[test]
unconstrained fn messages_naming_another_tx_are_dropped() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    let paid = last_messages(w.env);
    pay(w, w.alice, w.m1, AMOUNT, REF + 1);
    let other_tx = last_messages(w.env).get(0).tx_hash;
    let mut batch = paid;
    for i in 0..batch.len() {
        let mut message = batch.get(i);
        message.tx_hash = other_tx;
        batch.set(i, message);
    }
    receive(w.env, w.token, batch);
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount);
    assert_eq(payments_seen_by(w.env, w.token, w.m1).len(), 0);
}

// Onchain, the payment is a change note for the payer, the payer's nullifiers and the reference's marker: no log for
// the recipient, so no amount and no handshake naming it.
#[test]
unconstrained fn a_payment_publishes_no_log_for_its_recipient() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    let effects = txe_oracles::get_last_tx_effects();
    assert_eq(effects.private_logs.len(), 1);
    let marker = aztec::protocol::hash::compute_siloed_nullifier(w.token, paid_ref(w.m1, REF));
    assert(effects.nullifiers.any(|n| n == marker));
}

#[test]
unconstrained fn a_payment_moves_no_supply() {
    let w = utils::setup_merchant_world(false);
    let supply = utils::get_total_supply(w.env, w.token);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    receive(w.env, w.token, last_messages(w.env));
    utils::check_total_supply(w.env, w.token, supply);
}

#[test]
unconstrained fn a_merchant_pays_a_user_and_another_merchant() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.m1, w.bob, AMOUNT, REF);
    receive(w.env, w.token, last_messages(w.env));
    pay(w, w.m1, w.m2, AMOUNT, REF);
    receive(w.env, w.token, last_messages(w.env));
    utils::check_private_balance(w.env, w.token, w.bob, AMOUNT);
    utils::check_private_balance(w.env, w.token, w.m2, mint_amount + AMOUNT);
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount - 2 * AMOUNT);
}

#[test(should_fail_with = "Transfer refused: neither sender nor recipient is a merchant")]
unconstrained fn a_user_cannot_pay_a_user() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.bob, AMOUNT, REF);
}

#[test(should_fail_with = "Transfer refused: neither sender nor recipient is a merchant")]
unconstrained fn a_switched_off_merchant_cannot_be_paid_by_a_user() {
    let w = utils::setup_merchant_world(false);
    utils::anchor_at(w.env, utils::switch_off(w, w.m1));
    pay(w, w.alice, w.m1, AMOUNT, REF);
}

#[test]
unconstrained fn a_merchant_being_switched_off_is_paid_before_the_delay() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    utils::anchor_at(w.env, t0 + DAY - 1000);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    receive(w.env, w.token, last_messages(w.env));
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount + AMOUNT);
}

#[test(should_fail_with = "Payment refused: the amount is zero")]
unconstrained fn a_zero_payment_is_refused() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, 0, REF);
}

#[test(should_fail_with = "Payment refused: the payer is the recipient")]
unconstrained fn a_payment_to_oneself_is_refused() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.m1, w.m1, AMOUNT, REF);
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn a_payment_beyond_the_balance_is_refused() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, mint_amount + 1, REF);
}

#[test(should_fail_with = "Payment refused: the reference is already paid")]
unconstrained fn a_reference_takes_one_payment_per_merchant() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    pay(w, w.m2, w.m1, AMOUNT, REF);
}

#[test]
unconstrained fn one_reference_pays_two_merchants() {
    let w = utils::setup_merchant_world(false);
    pay(w, w.alice, w.m1, AMOUNT, REF);
    receive(w.env, w.token, last_messages(w.env));
    pay(w, w.alice, w.m2, AMOUNT, REF);
    receive(w.env, w.token, last_messages(w.env));
    utils::check_private_balance(w.env, w.token, w.m1, mint_amount + AMOUNT);
    utils::check_private_balance(w.env, w.token, w.m2, mint_amount + AMOUNT);
}

#[test]
unconstrained fn a_delegated_payment_with_an_authwit_lands_with_the_merchant() {
    let w = utils::setup_merchant_world(true);
    let mut env = w.env;
    let proxy = env.deploy("@generic_proxy/GenericProxy").without_initializer();
    let call = Token::at(w.token).pay_private(w.alice, w.m1, AMOUNT, REF, 1);
    authwit_cheatcodes::add_private_authwit_from_call(env, w.alice, proxy, call);
    env.call_private(
        w.alice,
        GenericProxy::at(proxy).forward_private_5(call.target_contract, call.selector, call.args),
    );
    receive(env, w.token, last_messages(env));
    utils::check_private_balance(env, w.token, w.alice, mint_amount - AMOUNT);
    utils::check_private_balance(env, w.token, w.m1, mint_amount + AMOUNT);
}

#[test(should_fail_with = "Unknown auth witness for message hash")]
unconstrained fn a_delegated_payment_without_an_authwit_is_refused() {
    let w = utils::setup_merchant_world(true);
    let mut env = w.env;
    let proxy = env.deploy("@generic_proxy/GenericProxy").without_initializer();
    let call = Token::at(w.token).pay_private(w.alice, w.m1, AMOUNT, REF, 1);
    env.call_private(
        w.alice,
        GenericProxy::at(proxy).forward_private_5(call.target_contract, call.selector, call.args),
    );
}

#[test]
unconstrained fn authorization_hook_called_on_pay_private() {
    let (env, token, owner, recipient, _, auth_contract) = utils::setup_and_mint_to_private_with_auth(false);
    let call = Token::at(token).pay_private(owner, recipient, AMOUNT, REF, 0);
    env.call_private(owner, call);
    utils::assert_auth_call(env, auth_contract, owner, AMOUNT, call.selector.to_field(), false);
}
