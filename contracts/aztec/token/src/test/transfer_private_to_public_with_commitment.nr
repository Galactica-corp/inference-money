use crate::test::utils::{self, mint_amount};
use crate::Token;
use aztec::protocol::traits::FromField;
use aztec::test::helpers::authwit as authwit_cheatcodes;
use generic_proxy::GenericProxy;
use uint_note::PartialUintNote;

#[test]
unconstrained fn transfer_private_to_public_with_commitment() {
    let (mut env, token_contract_address, owner, recipient) =
        utils::setup_and_mint_to_private_without_minter(false);

    utils::check_private_balance(env, token_contract_address, owner, mint_amount);
    utils::check_private_balance(env, token_contract_address, recipient, 0 as u128);

    // Transfer tokens
    let transfer_amount = mint_amount;
    let _ = env.call_private(
        owner,
        Token::at(token_contract_address).transfer_private_to_public_with_commitment(
            owner,
            recipient,
            transfer_amount,
            0,
        ),
    );

    // Check balances
    utils::check_private_balance(env, token_contract_address, owner, 0 as u128);
    utils::check_public_balance(env, token_contract_address, recipient, transfer_amount);
}

#[test]
unconstrained fn transfer_private_to_public_with_commitment_emits_validity_nullifier() {
    let (mut env, token_contract_address, owner, recipient) =
        utils::setup_and_mint_to_private_without_minter(false);

    let commitment = env.call_private(
        owner,
        Token::at(token_contract_address).transfer_private_to_public_with_commitment(
            owner,
            recipient,
            mint_amount,
            0,
        ),
    );

    // The caller is the completer of the partial note.
    let validity_commitment =
        PartialUintNote::from_field(commitment).compute_validity_commitment(owner);
    assert(
        env.public_context(|context| {
            context.nullifier_exists_unsafe(validity_commitment, token_contract_address)
        }),
        "validity nullifier should exist",
    );
}

#[test]
unconstrained fn transfer_private_to_public_with_commitment_on_behalf_of_other() {
    let (mut env, token_contract_address, owner, recipient, proxy) =
        utils::setup_and_mint_to_private_with_proxy();

    utils::check_private_balance(env, token_contract_address, owner, mint_amount);
    utils::check_private_balance(env, token_contract_address, recipient, 0 as u128);

    // Transfer tokens
    let transfer_amount = mint_amount;

    let transfer_private_to_public_commitment_call_interface = Token::at(token_contract_address)
        .transfer_private_to_public_with_commitment(owner, recipient, transfer_amount, 0);

    authwit_cheatcodes::add_private_authwit_from_call(
        env,
        owner,
        proxy,
        transfer_private_to_public_commitment_call_interface,
    );

    // Transfer tokens via proxy
    env.call_private(
        owner,
        GenericProxy::at(proxy).forward_private_4(
            transfer_private_to_public_commitment_call_interface.target_contract,
            transfer_private_to_public_commitment_call_interface.selector,
            transfer_private_to_public_commitment_call_interface.args,
        ),
    );

    // Check balances
    utils::check_private_balance(env, token_contract_address, owner, 0 as u128);
    utils::check_public_balance(env, token_contract_address, recipient, transfer_amount);
}

/// The refund pattern as Labs' AMM uses it: a contract pulls `amount` from the user's private balance into its
/// own public balance, then returns the unused part privately. The refund must land with `from`, not with `to`.
#[test]
unconstrained fn transfer_private_to_public_with_commitment_refunds_from() {
    let (env, token_contract_address, owner, _, dex) =
        utils::setup_and_mint_to_private_with_proxy();
    // The commitment is unstamped, so only a merchant source can refund it.
    utils::list_merchants(env, token_contract_address, owner, [dex]);

    let pulled = mint_amount;
    let refund = mint_amount / 4;

    let pull = Token::at(token_contract_address).transfer_private_to_public_with_commitment(
        owner,
        dex,
        pulled,
        0,
    );
    authwit_cheatcodes::add_private_authwit_from_call(env, owner, dex, pull);
    let commitment: Field = env.call_private(
        owner,
        GenericProxy::at(dex).forward_private_4_and_return(
            pull.target_contract,
            pull.selector,
            pull.args,
        ),
    );

    // The dex is `msg_sender` of the pull, hence the only completer; it refunds from its own public balance.
    let give_back =
        Token::at(token_contract_address).transfer_public_to_commitment(dex, commitment, refund, 0);
    env.call_public(
        owner,
        GenericProxy::at(dex).forward_public_4(
            give_back.target_contract,
            give_back.selector,
            give_back.args,
        ),
    );

    utils::check_private_balance(env, token_contract_address, owner, refund);
    utils::check_private_balance(env, token_contract_address, dex, 0 as u128);
    utils::check_public_balance(env, token_contract_address, dex, pulled - refund);
    utils::check_total_supply(env, token_contract_address, mint_amount);
}

// A valid commitment takes only its completer, whatever the source: the merchant the pull paid cannot fill it.
#[test(should_fail_with = "Invalid partial note or completer")]
unconstrained fn transfer_private_to_public_with_commitment_failure_wrong_completer() {
    let (env, token_contract_address, owner, recipient) =
        utils::setup_and_mint_to_private_without_minter(false);
    let token = Token::at(token_contract_address);
    let commitment = env.call_private(
        owner,
        token.transfer_private_to_public_with_commitment(owner, recipient, mint_amount, 0),
    );
    env.call_public(
        recipient,
        token.transfer_public_to_commitment(recipient, commitment, mint_amount, 0),
    );
}

#[test(should_fail_with = "Invalid partial note or completer")]
unconstrained fn transfer_private_to_public_with_commitment_and_finalize_with_invalid_commitment() {
    let (mut env, token_contract_address, owner, recipient) =
        utils::setup_and_mint_to_private_without_minter(false);

    utils::check_private_balance(env, token_contract_address, owner, mint_amount);
    utils::check_private_balance(env, token_contract_address, recipient, 0 as u128);

    // Transfer tokens
    let transfer_amount = mint_amount;

    // we ignore the returned commitment
    let _ = env.call_private(
        owner,
        Token::at(token_contract_address).transfer_private_to_public_with_commitment(
            owner,
            recipient,
            transfer_amount,
            0,
        ),
    );

    let invalid_commitment = 0xdeadbeef;

    // finalize transfer to an invalid commitment
    env.call_public(
        recipient,
        Token::at(token_contract_address).transfer_public_to_commitment(
            recipient,
            invalid_commitment,
            transfer_amount,
            0,
        ),
    );

    // you can finalize but the recipient will not have tokens
    utils::check_public_balance(env, token_contract_address, owner, 0 as u128);
    utils::check_private_balance(env, token_contract_address, owner, 0 as u128);
    utils::check_public_balance(env, token_contract_address, recipient, 0 as u128);
    utils::check_private_balance(env, token_contract_address, recipient, 0 as u128);
}

#[test(should_fail_with = "Invalid partial note or completer")]
unconstrained fn transfer_private_to_public_with_commitment_and_finalize_with_commitment_zero() {
    let (mut env, token_contract_address, owner, recipient) =
        utils::setup_and_mint_to_private_without_minter(false);

    utils::check_private_balance(env, token_contract_address, owner, mint_amount);
    utils::check_private_balance(env, token_contract_address, recipient, 0 as u128);

    // Transfer tokens
    let transfer_amount = mint_amount;

    // we ignore the returned commitment
    let _ = env.call_private(
        owner,
        Token::at(token_contract_address).transfer_private_to_public_with_commitment(
            owner,
            recipient,
            transfer_amount,
            0,
        ),
    );

    let invalid_commitment = 0;
    // Transfer tokens
    env.call_public(
        recipient,
        Token::at(token_contract_address).transfer_public_to_commitment(
            recipient,
            invalid_commitment,
            transfer_amount,
            0,
        ),
    );

    // check that both owner and recipient have no tokens
    utils::check_public_balance(env, token_contract_address, owner, 0 as u128);
    utils::check_private_balance(env, token_contract_address, owner, 0 as u128);
    utils::check_public_balance(env, token_contract_address, recipient, 0 as u128);
    utils::check_private_balance(env, token_contract_address, recipient, 0 as u128);
}
