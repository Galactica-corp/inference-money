// The minter-only calls behind split deposits, and the proof that an account is not a merchant. The bridge's TXE suite
// drives them end to end; here each one's own rule and its effect on the supply and on balances.
use crate::{test::utils::{self, MerchantWorld}, Token};

global DAY: u64 = 86400;

#[test]
unconstrained fn a_split_mint_counts_the_whole_deposit_and_mints_the_price() {
    let (env, token, owner, recipient, minter) = utils::setup_with_minter(false);
    env.call_private(minter, Token::at(token).mint_split_to_private(owner, 300, 1_000, false));
    utils::check_private_balance(env, token, owner, 300);
    utils::check_private_balance(env, token, recipient, 0);
    utils::check_total_supply(env, token, 1_000);
}

#[test]
unconstrained fn a_self_sent_split_mint_reaches_its_recipient() {
    let (env, token, owner, _recipient, minter) = utils::setup_with_minter(false);
    env.call_private(minter, Token::at(token).mint_split_to_private(minter, 300, 1_000, true));
    utils::check_private_balance(env, token, minter, 300);
    utils::check_private_balance(env, token, owner, 0);
}

#[test]
unconstrained fn a_reserved_mint_moves_no_supply_and_a_release_lowers_it() {
    let (env, token, owner, _recipient, minter) = utils::setup_with_minter(false);
    env.call_private(minter, Token::at(token).mint_split_to_private(owner, 300, 1_000, false));
    env.call_private(minter, Token::at(token).mint_reserved_to_private(minter, 500));
    utils::check_private_balance(env, token, minter, 500);
    utils::check_total_supply(env, token, 1_000);
    env.call_public(minter, Token::at(token).release_reserved(200));
    utils::check_total_supply(env, token, 800);
}

#[test(should_fail_with = "Mint refused: the amount exceeds the supply increase")]
unconstrained fn a_split_mint_never_mints_more_than_it_counts() {
    let (env, token, owner, _recipient, minter) = utils::setup_with_minter(false);
    env.call_private(minter, Token::at(token).mint_split_to_private(owner, 1_001, 1_000, false));
}

#[test(should_fail_with = "caller is not minter")]
unconstrained fn only_the_minter_split_mints() {
    let (env, token, owner, _recipient, _minter) = utils::setup_with_minter(false);
    env.call_private(owner, Token::at(token).mint_split_to_private(owner, 1, 1, true));
}

#[test(should_fail_with = "caller is not minter")]
unconstrained fn only_the_minter_mints_reserved_change() {
    let (env, token, owner, _recipient, _minter) = utils::setup_with_minter(false);
    env.call_private(owner, Token::at(token).mint_reserved_to_private(owner, 1));
}

#[test(should_fail_with = "caller is not minter")]
unconstrained fn only_the_minter_releases_reserved_change() {
    let (env, token, owner, _recipient, minter) = utils::setup_with_minter(false);
    env.call_private(minter, Token::at(token).mint_split_to_private(owner, 1, 10, false));
    env.call_public(owner, Token::at(token).release_reserved(9));
}

#[test]
unconstrained fn an_account_never_listed_is_proven_not_a_merchant() {
    let w = utils::setup_merchant_world(false);
    w.env.view_private(w.bob, Token::at(w.token).prove_not_merchant(w.alice));
}

#[test]
unconstrained fn a_switched_off_merchant_is_proven_not_a_merchant() {
    let w = utils::setup_merchant_world(false);
    utils::anchor_at(w.env, utils::switch_off(w, w.m1));
    w.env.view_private(w.bob, Token::at(w.token).prove_not_merchant(w.m1));
}

#[test(should_fail_with = "Not provable: the account is a merchant")]
unconstrained fn a_merchant_is_not_proven_not_a_merchant() {
    let w = utils::setup_merchant_world(false);
    w.env.view_private(w.bob, Token::at(w.token).prove_not_merchant(w.m1));
}

#[test(should_fail_with = "Not provable: the account is a merchant")]
unconstrained fn a_merchant_being_switched_off_is_still_one() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    utils::anchor_at(w.env, t0 + DAY - 1000);
    w.env.view_private(w.bob, Token::at(w.token).prove_not_merchant(w.m1));
}

#[test(should_fail_with = "Not provable: the account is a merchant")]
unconstrained fn a_merchant_switched_back_on_is_one_again() {
    let w = utils::setup_merchant_world(false);
    unswitch(w, w.m1);
    w.env.view_private(w.bob, Token::at(w.token).prove_not_merchant(w.m1));
}

unconstrained fn unswitch(w: MerchantWorld, merchant: aztec::protocol::address::AztecAddress) {
    utils::anchor_at(w.env, utils::switch_off(w, merchant));
    let t = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(merchant, false));
    utils::anchor_at(w.env, t + DAY);
}
