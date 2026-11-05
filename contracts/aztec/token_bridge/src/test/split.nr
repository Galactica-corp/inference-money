// Split deposits: one private deposit whose secret commits to a merchant, a price, a payment reference and the buyer's
// change commitment. claim_split pays the price to the merchant and leaves the rest as an IOU; claim_change hands the
// IOU to the account behind the commitment; return_split and return_change send what cannot be paid back to the
// depositor. The supply counts the whole deposit from the split claim on, whether or not the change is collected yet.

use super::utils::{self, Split};
use crate::TokenBridge;
use aztec::{protocol::address::{AztecAddress, EthAddress}, test::helpers::test_environment::TestEnvironment};
use token::Token;

global AMOUNT: u128 = 10_000_000;
global PRICE: u128 = 370_000;
global DAY: u64 = 86400;

struct World {
    env: TestEnvironment,
    admin: AztecAddress,
    token: AztecAddress,
    bridge: AztecAddress,
    merchant: AztecAddress,
    buyer: AztecAddress,
    split: Split,
}

unconstrained fn world() -> World {
    let (mut env, admin, _proxy, token, bridge) = utils::setup();
    let merchant = utils::merchant(&mut env, admin, token);
    let buyer = env.create_contract_account();
    let split = Split {
        amount: AMOUNT,
        depositor: utils::depositor(),
        merchant,
        price: PRICE,
        payment_ref: 0x5eed,
        buyer,
        change_salt: 0xc4a,
        salt: 0x5a17,
    };
    World { env, admin, token, bridge, merchant, buyer, split }
}

#[test]
unconstrained fn the_merchant_claims_the_price_and_the_buyer_collects_the_change() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);

    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    assert_eq(utils::private_balance(w.env, w.token, w.merchant), PRICE);
    assert_eq(utils::private_balance(w.env, w.token, w.buyer), 0);
    // The change is counted from the split claim on, though no one holds it yet.
    assert_eq(utils::total_supply(w.env, w.token), AMOUNT);

    utils::claim_change(w.env, w.split, leaf, w.bridge);
    assert_eq(utils::private_balance(w.env, w.token, w.buyer), AMOUNT - PRICE);
    assert_eq(utils::private_balance(w.env, w.token, w.merchant), PRICE);
    assert_eq(utils::total_supply(w.env, w.token), AMOUNT);
    assert_eq(
        w.env.execute_utility(TokenBridge::at(w.bridge).get_funding_address(w.buyer)),
        utils::depositor(),
    );
}

#[test]
unconstrained fn the_buyer_can_claim_the_split_for_the_merchant() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.buyer, w.split, leaf, w.bridge);
    assert_eq(utils::private_balance(w.env, w.token, w.merchant), PRICE);
    utils::claim_change(w.env, w.split, leaf, w.bridge);
    assert_eq(utils::private_balance(w.env, w.token, w.buyer), AMOUNT - PRICE);
}

#[test]
unconstrained fn a_bystander_holding_the_terms_can_only_pay_the_merchant() {
    let mut w = world();
    let bystander = w.env.create_contract_account();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, bystander, w.split, leaf, w.bridge);
    assert_eq(utils::private_balance(w.env, w.token, w.merchant), PRICE);
    assert_eq(utils::private_balance(w.env, w.token, bystander), 0);
}

#[test(should_fail_with = "No such change to collect")]
unconstrained fn a_deposit_of_exactly_the_price_leaves_no_change() {
    let mut w = world();
    w.split.price = AMOUNT;
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    assert_eq(utils::private_balance(w.env, w.token, w.merchant), AMOUNT);
    assert_eq(utils::total_supply(w.env, w.token), AMOUNT);
    w.env.call_private(
        w.buyer,
        TokenBridge::at(w.bridge).claim_change(1, w.split.depositor, leaf, w.split.secret(), w.split.change_salt, true),
    );
}

#[test(should_fail_with = "The price exceeds the deposit")]
unconstrained fn a_price_above_the_deposit_is_refused() {
    let mut w = world();
    w.split.price = AMOUNT + 1;
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "Price must be greater than zero")]
unconstrained fn a_zero_price_is_refused() {
    let mut w = world();
    w.split.price = 0;
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "Split deposits pay listed merchants only")]
unconstrained fn a_split_to_a_user_is_refused() {
    let mut w = world();
    w.split.merchant = w.buyer;
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.buyer, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "Split deposits pay listed merchants only")]
unconstrained fn a_split_to_a_switched_off_merchant_is_refused() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    switch_off(w);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "Bridge is paused")]
unconstrained fn a_split_claim_is_refused_while_paused() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.env.call_public(w.admin, TokenBridge::at(w.bridge).set_paused(true));
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No non-nullified L1 to L2 message found")]
unconstrained fn a_split_deposit_is_claimed_once() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

// Every term is bound by the secret: changing any one of them names another message, which was never sent.
#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn another_merchant_cannot_claim_the_split() {
    let mut w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    let other = utils::merchant(&mut w.env, w.admin, w.token);
    w.split.merchant = other;
    utils::claim_split(w.env, other, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn a_lower_price_cannot_be_claimed() {
    let mut w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.split.price = PRICE - 1;
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn a_higher_price_cannot_be_claimed() {
    let mut w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.split.price = PRICE + 1;
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn another_reference_cannot_be_claimed() {
    let mut w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.split.payment_ref = w.split.payment_ref + 1;
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn another_change_owner_cannot_be_claimed() {
    let mut w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.split.buyer = w.merchant;
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn another_salt_cannot_be_claimed() {
    let mut w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.split.salt = w.split.salt + 1;
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn another_amount_cannot_be_claimed() {
    let mut w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.split.amount = AMOUNT + 1;
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn another_depositor_cannot_be_claimed() {
    let mut w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.split.depositor = EthAddress::from_field(0xBAD);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

// A split secret is never a plain claim secret, and the other way round: each consumer re-derives its own.
#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn claim_private_cannot_consume_a_split_deposit() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.env.call_private(
        w.merchant,
        TokenBridge::at(w.bridge).claim_private(w.merchant, AMOUNT, w.split.salt, leaf, utils::depositor(), true),
    );
}

#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn return_deposit_private_cannot_consume_a_split_deposit() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.env.call_private(
        w.buyer,
        TokenBridge::at(w.bridge).return_deposit_private(w.merchant, AMOUNT, w.split.salt, leaf, utils::depositor()),
    );
}

#[test(should_fail_with = "No L1 to L2 message found for message hash")]
unconstrained fn claim_split_cannot_consume_a_plain_deposit() {
    let w = world();
    let leaf = utils::send_mint_to_private_message_from(w.env, w.merchant, AMOUNT, w.split.salt, utils::depositor(), w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test]
unconstrained fn two_deposits_with_the_same_terms_are_both_claimed_and_collected() {
    let w = world();
    let first = utils::send_split_message(w.env, w.split, w.bridge);
    let second = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, first, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, second, w.bridge);
    utils::claim_change(w.env, w.split, first, w.bridge);
    utils::claim_change(w.env, w.split, second, w.bridge);
    assert_eq(utils::private_balance(w.env, w.token, w.merchant), 2 * PRICE);
    assert_eq(utils::private_balance(w.env, w.token, w.buyer), 2 * (AMOUNT - PRICE));
    assert_eq(utils::total_supply(w.env, w.token), 2 * AMOUNT);
}

#[test(should_fail_with = "The change is already collected")]
unconstrained fn the_change_is_collected_once() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    utils::claim_change(w.env, w.split, leaf, w.bridge);
    utils::claim_change(w.env, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No such change to collect")]
unconstrained fn the_change_cannot_be_collected_before_the_split_is_claimed() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_change(w.env, w.split, leaf, w.bridge);
}

// The commitment opens to the buyer's address: anyone else rebuilds another IOU, which does not exist.
#[test(should_fail_with = "No such change to collect")]
unconstrained fn only_the_buyer_collects_the_change() {
    let mut w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    let thief = w.env.create_contract_account();
    w.env.call_private(
        thief,
        TokenBridge::at(w.bridge).claim_change(
            AMOUNT - PRICE,
            w.split.depositor,
            leaf,
            w.split.secret(),
            w.split.change_salt,
            true,
        ),
    );
}

#[test(should_fail_with = "No such change to collect")]
unconstrained fn the_merchant_cannot_collect_the_change() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    w.env.call_private(
        w.merchant,
        TokenBridge::at(w.bridge).claim_change(
            AMOUNT - PRICE,
            w.split.depositor,
            leaf,
            w.split.secret(),
            w.split.change_salt,
            false,
        ),
    );
}

#[test(should_fail_with = "No such change to collect")]
unconstrained fn more_change_than_owed_cannot_be_collected() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    w.env.call_private(
        w.buyer,
        TokenBridge::at(w.bridge).claim_change(
            AMOUNT - PRICE + 1,
            w.split.depositor,
            leaf,
            w.split.secret(),
            w.split.change_salt,
            true,
        ),
    );
}

#[test(should_fail_with = "No such change to collect")]
unconstrained fn another_change_salt_cannot_collect() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    w.env.call_private(
        w.buyer,
        TokenBridge::at(w.bridge).claim_change(
            AMOUNT - PRICE,
            w.split.depositor,
            leaf,
            w.split.secret(),
            w.split.change_salt + 1,
            true,
        ),
    );
}

#[test(should_fail_with = "Amount must be greater than zero")]
unconstrained fn a_zero_change_is_refused() {
    let w = world();
    w.env.call_private(
        w.buyer,
        TokenBridge::at(w.bridge).claim_change(0, w.split.depositor, 0, w.split.secret(), w.split.change_salt, true),
    );
}

#[test]
unconstrained fn a_bound_buyer_collects_change_from_its_funding_address() {
    let w = world();
    utils::fund_private(w.env, w.buyer, 1_000, 0x77, w.bridge);
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    utils::claim_change(w.env, w.split, leaf, w.bridge);
    assert_eq(utils::private_balance(w.env, w.token, w.buyer), 1_000 + AMOUNT - PRICE);
}

#[test(should_fail_with = "Deposit is not from this account's funding address")]
unconstrained fn a_buyer_bound_elsewhere_cannot_collect_the_change() {
    let mut w = world();
    utils::fund_private(w.env, w.buyer, 1_000, 0x77, w.bridge);
    w.split.depositor = EthAddress::from_field(0xBEEF);
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    utils::claim_change(w.env, w.split, leaf, w.bridge);
}

#[test]
unconstrained fn a_buyer_bound_elsewhere_returns_the_change_to_its_depositor() {
    let mut w = world();
    utils::fund_private(w.env, w.buyer, 1_000, 0x77, w.bridge);
    w.split.depositor = EthAddress::from_field(0xBEEF);
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    assert_eq(utils::total_supply(w.env, w.token), 1_000 + AMOUNT);
    return_change(w, leaf);
    // The change leaves for L1, so the supply drops by it; the merchant keeps the price.
    assert_eq(utils::total_supply(w.env, w.token), 1_000 + PRICE);
    assert_eq(utils::private_balance(w.env, w.token, w.merchant), PRICE);
    assert_eq(utils::private_balance(w.env, w.token, w.buyer), 1_000);
}

#[test(should_fail_with = "The change is already collected")]
unconstrained fn returned_change_cannot_be_collected() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    return_change(w, leaf);
    utils::claim_change(w.env, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "The change is already collected")]
unconstrained fn collected_change_cannot_be_returned() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    utils::claim_change(w.env, w.split, leaf, w.bridge);
    return_change(w, leaf);
}

#[test(should_fail_with = "Bridge is paused")]
unconstrained fn the_change_is_not_collected_while_paused() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    w.env.call_public(w.admin, TokenBridge::at(w.bridge).set_paused(true));
    utils::claim_change(w.env, w.split, leaf, w.bridge);
}

// Returns: a split deposit goes back only when it cannot pay its merchant, and never once claimed.

#[test]
unconstrained fn a_split_to_a_user_is_returned_and_mints_nothing() {
    let mut w = world();
    w.split.merchant = w.buyer;
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::return_split(w.env, w.buyer, w.split, leaf, w.bridge);
    assert_eq(utils::total_supply(w.env, w.token), 0);
}

#[test]
unconstrained fn a_split_to_a_switched_off_merchant_is_returned() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    switch_off(w);
    utils::return_split(w.env, w.buyer, w.split, leaf, w.bridge);
    assert_eq(utils::total_supply(w.env, w.token), 0);
}

#[test]
unconstrained fn a_split_whose_price_exceeds_the_deposit_is_returned() {
    let mut w = world();
    w.split.price = AMOUNT + 1;
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::return_split(w.env, w.buyer, w.split, leaf, w.bridge);
    assert_eq(utils::total_supply(w.env, w.token), 0);
}

#[test(should_fail_with = "Not provable: the account is a merchant")]
unconstrained fn a_payable_split_is_not_returned() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::return_split(w.env, w.buyer, w.split, leaf, w.bridge);
}

// A merchant whose switch-off is scheduled but not yet effective is still one, so its deposit cannot be returned.
#[test(should_fail_with = "Not provable: the account is a merchant")]
unconstrained fn a_split_to_a_merchant_being_switched_off_is_not_returned() {
    let w = world();
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.merchant, true));
    w.env.mine_block_at(t0 + DAY - 1000);
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::return_split(w.env, w.buyer, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "No non-nullified L1 to L2 message found")]
unconstrained fn a_claimed_split_cannot_be_returned() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
    switch_off(w);
    utils::return_split(w.env, w.buyer, w.split, leaf, w.bridge);
}

// Returned while the merchant was off, the deposit stays returned when the merchant is switched back on.
#[test(should_fail_with = "No non-nullified L1 to L2 message found")]
unconstrained fn a_returned_split_cannot_be_claimed() {
    let w = world();
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    switch_off(w);
    utils::return_split(w.env, w.buyer, w.split, leaf, w.bridge);
    let t = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.merchant, false));
    w.env.mine_block_at(t + DAY);
    utils::claim_split(w.env, w.merchant, w.split, leaf, w.bridge);
}

#[test(should_fail_with = "Bridge is paused")]
unconstrained fn a_split_return_is_refused_while_paused() {
    let mut w = world();
    w.split.price = AMOUNT + 1;
    let leaf = utils::send_split_message(w.env, w.split, w.bridge);
    w.env.call_public(w.admin, TokenBridge::at(w.bridge).set_paused(true));
    utils::return_split(w.env, w.buyer, w.split, leaf, w.bridge);
}

unconstrained fn switch_off(w: World) {
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.merchant, true));
    w.env.mine_block_at(t0 + DAY);
}

unconstrained fn return_change(w: World, leaf: Field) {
    w.env.call_private(
        w.buyer,
        TokenBridge::at(w.bridge).return_change(
            w.buyer,
            w.split.amount - w.split.price,
            w.split.depositor,
            leaf,
            w.split.secret(),
            w.split.change_salt,
        ),
    );
}
