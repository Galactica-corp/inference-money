// The merchant list's admin surface: who may change it, and when each change takes effect.
use crate::{test::utils::{self, MerchantWorld}, Token};
use aztec::protocol::address::AztecAddress;

global DAY: u64 = 86400;
global HOUR: u64 = 3600;

unconstrained fn status(w: MerchantWorld, account: AztecAddress) -> Token::MerchantStatus {
    w.env.view_public(Token::at(w.token).get_merchant_status(account))
}

unconstrained fn roles(w: MerchantWorld) -> Token::MerchantRoles {
    w.env.view_public(Token::at(w.token).get_merchant_roles())
}

unconstrained fn is_merchant(w: MerchantWorld, account: AztecAddress) -> bool {
    w.env.view_public(Token::at(w.token).is_merchant(account))
}

// Moves the next block (and every public call after it) to `timestamp`.
unconstrained fn at(w: MerchantWorld, timestamp: u64) {
    w.env.mine_block_at(timestamp);
}

#[test(should_fail_with = "Only the merchant admin")]
unconstrained fn add_merchant_is_admin_only() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.m1, Token::at(w.token).add_merchant(w.alice));
}

#[test(should_fail_with = "Merchant is the zero address")]
unconstrained fn add_merchant_refuses_zero() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).add_merchant(AztecAddress::zero()));
}

#[test(should_fail_with = "Merchant already added")]
unconstrained fn add_merchant_refuses_a_listed_account() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).add_merchant(w.m1));
}

#[test]
unconstrained fn add_merchant_is_instant_on_the_delay_setting() {
    let w = utils::setup_merchant_world(false);
    assert(!is_merchant(w, w.alice));
    w.env.call_public(w.admin, Token::at(w.token).add_merchant(w.alice));
    assert(is_merchant(w, w.alice));
    let s = status(w, w.alice);
    assert(s.registered & !s.off & !s.scheduled_off);
    // Raising the slot's 3600 s floor to the setting applies at once.
    assert_eq(s.delay, DAY);
    assert_eq(s.scheduled_delay, DAY);
}

#[test]
unconstrained fn an_unlisted_account_reads_unregistered_and_on_at_the_floor() {
    let w = utils::setup_merchant_world(false);
    let s = status(w, w.bob);
    assert(!s.registered & !s.off & !s.scheduled_off);
    assert_eq(s.scheduled_off_at, 0);
    assert_eq(s.delay, HOUR);
}

#[test]
unconstrained fn switch_off_takes_effect_after_the_delay_and_not_before() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    let s = status(w, w.m1);
    assert(s.scheduled_off & !s.off);
    assert_eq(s.scheduled_off_at, t0 + DAY);

    at(w, t0 + DAY - 1);
    assert(is_merchant(w, w.m1));
    at(w, t0 + DAY);
    assert(!is_merchant(w, w.m1));
    assert(status(w, w.m1).off);
}

#[test]
unconstrained fn a_repeated_switch_off_does_not_restart_the_clock() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    at(w, t0 + HOUR);
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    assert_eq(status(w, w.m1).scheduled_off_at, t0 + DAY);
}

#[test]
unconstrained fn switching_back_on_cancels_a_pending_switch_off() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    at(w, t0 + HOUR);
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, false));
    let s = status(w, w.m1);
    assert(!s.scheduled_off);
    // The switch-on is itself scheduled; as a change to the current value it marks nothing.
    assert_eq(s.scheduled_off_at, t0 + HOUR + DAY);
    at(w, t0 + DAY + HOUR - 1);
    assert(is_merchant(w, w.m1));
}

#[test(should_fail_with = "Not a registered merchant")]
unconstrained fn switch_off_refuses_an_unlisted_account() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.alice, true));
}

#[test(should_fail_with = "Only the merchant admin")]
unconstrained fn switch_off_is_admin_only() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.m2, Token::at(w.token).schedule_merchant_off(w.m1, true));
}

#[test(should_fail_with = "Only the merchant admin or guardian")]
unconstrained fn cancel_is_admin_or_guardian_only() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    w.env.call_public(w.m1, Token::at(w.token).cancel_merchant_change(w.m1));
}

#[test(should_fail_with = "No pending change")]
unconstrained fn cancel_refuses_an_entry_with_nothing_pending() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).cancel_merchant_change(w.m1));
}

#[test(should_fail_with = "No pending change")]
unconstrained fn cancel_refuses_a_cancelled_entry() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    w.env.call_public(w.admin, Token::at(w.token).cancel_merchant_change(w.m1));
    // The scheduled value now equals the current one, so nothing is left to cancel.
    w.env.call_public(w.admin, Token::at(w.token).cancel_merchant_change(w.m1));
}

#[test]
unconstrained fn the_guardian_cancels_a_pending_switch_off_once_in_office() {
    let w = utils::setup_merchant_world(false);
    let guardian = w.bob;
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_guardian(guardian));
    at(w, t0 + DAY);
    assert_eq(roles(w).guardian, guardian);

    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    w.env.call_public(guardian, Token::at(w.token).cancel_merchant_change(w.m1));
    let s = status(w, w.m1);
    assert(!s.scheduled_off);
    at(w, t0 + 3 * DAY);
    assert(is_merchant(w, w.m1));
}

#[test]
unconstrained fn the_guardian_cancels_a_pending_delay_decrease() {
    let w = utils::setup_merchant_world(false);
    let guardian = w.bob;
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_guardian(guardian));
    at(w, t0 + DAY);
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(HOUR));
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.m1));
    assert_eq(status(w, w.m1).scheduled_delay, HOUR);

    w.env.call_public(guardian, Token::at(w.token).cancel_merchant_change(w.m1));
    let s = status(w, w.m1);
    assert_eq(s.delay, DAY);
    assert_eq(s.scheduled_delay, DAY);
}

#[test(should_fail_with = "Only the merchant admin or guardian")]
unconstrained fn a_scheduled_guardian_cannot_cancel_before_taking_office() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_guardian(w.bob));
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    w.env.call_public(w.bob, Token::at(w.token).cancel_merchant_change(w.m1));
}

#[test(should_fail_with = "Delay out of range")]
unconstrained fn the_delay_has_a_one_hour_floor() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(HOUR - 1));
}

#[test(should_fail_with = "Delay out of range")]
unconstrained fn the_delay_has_a_one_day_ceiling() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(DAY + 1));
}

#[test(should_fail_with = "Only the merchant admin")]
unconstrained fn the_delay_setting_is_admin_only() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.m1, Token::at(w.token).set_merchant_delay(HOUR));
}

// Both ways one admin tx can leave a merchant alone on a shorter delay: a merchant added under a lowered setting, and
// one synced to it, each with the setting restored in the same tx.
#[test]
unconstrained fn a_stranger_restores_a_targeted_entry_at_once() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(HOUR));
    w.env.call_public(w.admin, Token::at(w.token).add_merchant(w.bob));
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.m1));
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(DAY));
    assert_eq(status(w, w.bob).delay, HOUR);
    assert_eq(status(w, w.m1).scheduled_delay, HOUR);

    w.env.call_public(w.alice, Token::at(w.token).sync_merchant_delay(w.bob));
    w.env.call_public(w.alice, Token::at(w.token).sync_merchant_delay(w.m1));
    let (b, m) = (status(w, w.bob), status(w, w.m1));
    assert_eq([b.delay, b.scheduled_delay, m.delay, m.scheduled_delay], [DAY; 4]);
}

#[test]
unconstrained fn a_strangers_sync_never_restarts_a_pending_decrease() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(HOUR));
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.m1));
    let pending = status(w, w.m1);
    at(w, t0 + 12 * HOUR);
    w.env.call_public(w.alice, Token::at(w.token).sync_merchant_delay(w.m1));
    assert(status(w, w.m1) == pending);
    at(w, t0 + DAY - HOUR);
    assert_eq(status(w, w.m1).delay, HOUR);
}

// The setting sits above the pending 1 h but below the 24 h in force, so only a guard reading the delay in force
// refuses.
#[test(should_fail_with = "Only the merchant admin lowers a delay")]
unconstrained fn a_strangers_sync_never_lowers_the_delay_in_force() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(HOUR));
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.m1));
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(12 * HOUR));
    w.env.call_public(w.alice, Token::at(w.token).sync_merchant_delay(w.m1));
}

#[test(should_fail_with = "Only the merchant admin lowers a delay")]
unconstrained fn a_guardians_cancel_holds_against_a_strangers_sync() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_guardian(w.bob));
    at(w, t0 + DAY);
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(HOUR));
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.m1));
    w.env.call_public(w.bob, Token::at(w.token).cancel_merchant_change(w.m1));
    w.env.call_public(w.alice, Token::at(w.token).sync_merchant_delay(w.m1));
}

#[test]
unconstrained fn a_delay_decrease_waits_the_difference_and_an_increase_applies_at_once() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(HOUR));
    assert_eq(roles(w).delay, HOUR);
    // The setting reaches an entry only when synced; the decrease then waits old - new.
    assert_eq(status(w, w.m1).scheduled_delay, DAY);
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.m1));
    let s = status(w, w.m1);
    assert_eq(s.delay, DAY);
    assert_eq(s.scheduled_delay, HOUR);
    assert_eq(s.scheduled_delay_at, t0 + DAY - HOUR);

    at(w, t0 + DAY - HOUR);
    assert_eq(status(w, w.m1).delay, HOUR);
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(DAY));
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.m1));
    let raised = status(w, w.m1);
    assert_eq(raised.delay, DAY);
    assert_eq(raised.scheduled_delay_at, t0 + DAY - HOUR);
}

#[test]
unconstrained fn a_switch_off_uses_the_entrys_delay_once_synced() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).set_merchant_delay(HOUR));
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.m1));
    at(w, t0 + DAY - HOUR);
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_off(w.m1, true));
    assert_eq(status(w, w.m1).scheduled_off_at, t0 + DAY);
    // An entry added after the change starts on the new setting at once.
    w.env.call_public(w.admin, Token::at(w.token).add_merchant(w.alice));
    assert_eq(status(w, w.alice).delay, HOUR);
}

#[test]
unconstrained fn sync_is_a_no_op_on_a_synced_entry() {
    let w = utils::setup_merchant_world(false);
    let before = status(w, w.m1);
    at(w, w.env.last_block_timestamp() + HOUR);
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.m1));
    assert(status(w, w.m1) == before);
}

#[test(should_fail_with = "Not a registered merchant")]
unconstrained fn sync_refuses_an_unlisted_account() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).sync_merchant_delay(w.alice));
}

#[test]
unconstrained fn the_admin_role_moves_in_two_steps() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).propose_merchant_admin(w.bob));
    assert_eq(roles(w).pending_admin, w.bob);
    assert_eq(roles(w).admin, w.admin);
    w.env.call_public(w.bob, Token::at(w.token).accept_merchant_admin());
    let r = roles(w);
    assert_eq(r.admin, w.bob);
    assert_eq(r.pending_admin, AztecAddress::zero());
    w.env.call_public(w.bob, Token::at(w.token).add_merchant(w.alice));
    assert(is_merchant(w, w.alice));
}

#[test(should_fail_with = "Only the merchant admin")]
unconstrained fn the_former_admin_loses_the_role_on_acceptance() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).propose_merchant_admin(w.bob));
    w.env.call_public(w.bob, Token::at(w.token).accept_merchant_admin());
    w.env.call_public(w.admin, Token::at(w.token).add_merchant(w.alice));
}

#[test(should_fail_with = "Only the merchant admin")]
unconstrained fn propose_merchant_admin_is_admin_only() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.bob, Token::at(w.token).propose_merchant_admin(w.bob));
}

#[test(should_fail_with = "Only the pending merchant admin")]
unconstrained fn only_the_proposed_admin_accepts() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).propose_merchant_admin(w.bob));
    w.env.call_public(w.alice, Token::at(w.token).accept_merchant_admin());
}

#[test(should_fail_with = "Only the pending merchant admin")]
unconstrained fn proposing_zero_withdraws_the_proposal() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).propose_merchant_admin(w.bob));
    w.env.call_public(w.admin, Token::at(w.token).propose_merchant_admin(AztecAddress::zero()));
    w.env.call_public(w.bob, Token::at(w.token).accept_merchant_admin());
}

#[test]
unconstrained fn the_guardian_slot_waits_a_day_from_construction() {
    let w = utils::setup_merchant_world(false);
    let r = roles(w);
    assert_eq(r.admin, w.admin);
    assert_eq(r.delay, DAY);
    assert_eq(r.guardian_delay, DAY);
    assert_eq(r.guardian, AztecAddress::zero());

    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_guardian(w.bob));
    assert_eq(roles(w).scheduled_guardian_at, t0 + DAY);
    at(w, t0 + DAY - 1);
    assert_eq(roles(w).guardian, AztecAddress::zero());
    at(w, t0 + DAY);
    assert_eq(roles(w).guardian, w.bob);

    // Removal waits the same delay.
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_guardian(AztecAddress::zero()));
    at(w, t0 + 2 * DAY - 1);
    assert_eq(roles(w).guardian, w.bob);
    at(w, t0 + 2 * DAY);
    assert_eq(roles(w).guardian, AztecAddress::zero());
}

#[test(should_fail_with = "Only the merchant admin")]
unconstrained fn the_guardian_is_scheduled_by_the_admin_only() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.bob, Token::at(w.token).schedule_merchant_guardian(w.bob));
}

#[test(should_fail_with = "Only the merchant admin")]
unconstrained fn propose_merchant_admin_refuses_a_merchant() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.m1, Token::at(w.token).propose_merchant_admin(w.m1));
}

#[test(should_fail_with = "Only the merchant admin")]
unconstrained fn propose_merchant_admin_refuses_the_guardian() {
    let w = utils::setup_merchant_world(false);
    let t0 = w.env.last_block_timestamp();
    w.env.call_public(w.admin, Token::at(w.token).schedule_merchant_guardian(w.bob));
    at(w, t0 + DAY);
    assert_eq(roles(w).guardian, w.bob);
    w.env.call_public(w.bob, Token::at(w.token).propose_merchant_admin(w.bob));
}

#[test(should_fail_with = "Only the merchant admin")]
unconstrained fn the_proposed_admin_cannot_propose_before_accepting() {
    let w = utils::setup_merchant_world(false);
    w.env.call_public(w.admin, Token::at(w.token).propose_merchant_admin(w.bob));
    w.env.call_public(w.bob, Token::at(w.token).propose_merchant_admin(w.alice));
}
