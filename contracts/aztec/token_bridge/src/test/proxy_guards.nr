// TokenMinterProxy guards: after the one-shot wiring, the bridge is the ONLY mint/burn caller
// and the owner retains no standing authority.

use super::utils;
use aztec::test::helpers::authwit::add_private_authwit_from_call;
use token::Token;
use token_minter_proxy::TokenMinterProxy;

/// A random account calling the proxy directly is rejected — only the bridge mints.
#[test(should_fail_with = "not the bridge")]
unconstrained fn proxy_direct_mint_rejected() {
    let (mut env, _admin, proxy, _token, _bridge) = utils::setup();
    let rando = env.create_light_account();
    env.call_public(rando, TokenMinterProxy::at(proxy).mint_to_public(rando, 1));
}

/// Even the PROXY OWNER cannot mint — the wiring is single-shot by construction.
#[test(should_fail_with = "not the bridge")]
unconstrained fn proxy_owner_cannot_mint() {
    let (env, admin, proxy, _token, _bridge) = utils::setup();
    env.call_public(admin, TokenMinterProxy::at(proxy).mint_to_public(admin, 1));
}

/// set_bridge is single-shot: a second call reverts on the PublicImmutable guard (the
/// sole minter can never be repointed or extended, even by the owner).
#[test(should_fail_with = "Attempted to emit duplicate nullifier")]
unconstrained fn proxy_set_bridge_second_call_reverts() {
    let (mut env, admin, proxy, _token, _bridge) = utils::setup();
    let other = env.create_light_account();
    env.call_public(admin, TokenMinterProxy::at(proxy).set_bridge(other));
}

/// An UNWIRED proxy still enforces owner-only wiring: a non-owner set_bridge fails with the
/// owner assert (not merely the immutability guard), pinning that access control precedes
/// single-shot semantics.
#[test(should_fail_with = "not owner")]
unconstrained fn proxy_unwired_non_owner_set_bridge_rejected() {
    let mut env = aztec::test::helpers::test_environment::TestEnvironment::new();
    let admin = env.create_light_account();
    let attacker = env.create_light_account();

    let proxy_init = TokenMinterProxy::interface().constructor();
    let proxy = env
        .deploy("@token_minter_proxy/TokenMinterProxy")
        .with_public_initializer(admin, proxy_init);

    let other_bridge = env.create_light_account();
    env.call_public(attacker, TokenMinterProxy::at(proxy).set_bridge(other_bridge));
}

/// set_token carries the identical owner-gate + single-shot pair as set_bridge but had no
/// coverage at all. Repointing the token would redirect every mint the bridge performs.
#[test(should_fail_with = "not owner")]
unconstrained fn proxy_non_owner_set_token_rejected() {
    let (mut env, _admin, proxy, _token, _bridge) = utils::setup();
    let attacker = env.create_light_account();
    let other_token = env.create_light_account();
    env.call_public(attacker, TokenMinterProxy::at(proxy).set_token(other_token));
}

/// PublicImmutable's single-shot guard surfaces as a duplicate-nullifier revert rather than a
/// named assert. Pinned rather than left bare: a bare should_fail is also satisfied by a TXE
/// resolver error, which is how this suite silently "passes" when the oracle dies.
#[test(should_fail_with = "Attempted to emit duplicate nullifier")]
unconstrained fn proxy_set_token_second_call_reverts() {
    let (mut env, admin, proxy, _token, _bridge) = utils::setup();
    let other_token = env.create_light_account();
    env.call_public(admin, TokenMinterProxy::at(proxy).set_token(other_token));
}

/// mint_to_public was the only privileged entrypoint probed directly. The other three share
/// the same bridge gate — burn_public inline, the two private ones through the enqueued
/// only_self assert_bridge — and were exercised only indirectly via exit happy-paths, so a
/// dropped gate on any of them would not have failed a test.
#[test(should_fail_with = "not the bridge")]
unconstrained fn proxy_direct_burn_public_rejected() {
    let (mut env, _admin, proxy, _token, _bridge) = utils::setup();
    let rando = env.create_light_account();
    env.call_public(rando, TokenMinterProxy::at(proxy).burn_public(rando, 1, 0));
}

#[test(should_fail_with = "not the bridge")]
unconstrained fn proxy_direct_mint_to_private_rejected() {
    let (mut env, _admin, proxy, _token, _bridge) = utils::setup();
    let rando = env.create_contract_account();
    env.call_private(rando, TokenMinterProxy::at(proxy).mint_to_private(rando, 1));
}

/// Funded and authorized first: burn_private nullifies notes during private execution, so an
/// unfunded caller fails on the missing note rather than on the bridge gate this pins.
#[test(should_fail_with = "not the bridge")]
unconstrained fn proxy_direct_burn_private_rejected() {
    let (mut env, _admin, proxy, token, bridge) = utils::setup();
    let rando = env.create_contract_account();
    utils::fund_private(env, rando, 500_000, 31337, bridge);

    add_private_authwit_from_call(env, rando, proxy, Token::at(token).burn_private(rando, 1, 0));
    env.call_private(rando, TokenMinterProxy::at(proxy).burn_private(rando, 1, 0));
}

/// The split-deposit forwards are the bridge's alone too: a direct call is refused before reaching the token.
#[test(should_fail_with = "not the bridge")]
unconstrained fn proxy_direct_split_mint_rejected() {
    let (mut env, _admin, proxy, _token, _bridge) = utils::setup();
    let rando = env.create_light_account();
    env.call_private(rando, TokenMinterProxy::at(proxy).mint_split_to_private(rando, 1, 1, true));
}

#[test(should_fail_with = "not the bridge")]
unconstrained fn proxy_direct_reserved_mint_rejected() {
    let (mut env, _admin, proxy, _token, _bridge) = utils::setup();
    let rando = env.create_light_account();
    env.call_private(rando, TokenMinterProxy::at(proxy).mint_reserved_to_private(rando, 1));
}

#[test(should_fail_with = "not the bridge")]
unconstrained fn proxy_owner_cannot_release_reserved_supply() {
    let (env, admin, proxy, _token, _bridge) = utils::setup();
    env.call_public(admin, TokenMinterProxy::at(proxy).release_reserved(1));
}
