// Deploys and wires the production trio (proxy, merchant Token, bridge) as the deployer does. Test messages are hashed
// with the same portal_messages lib the claims use, so they cannot drift from what the bridge expects.

use crate::TokenBridge;
use aztec::{
    protocol::address::{AztecAddress, EthAddress},
    test::helpers::test_environment::TestEnvironment,
};
use token::Token;
use token_minter_proxy::TokenMinterProxy;
use claim_secret_lib::{derive_claim_secret, split_change_commitment, split_secret};
use portal_messages::{mint_to_private_content_hash, mint_to_public_content_hash};

/// The L1 portal identity the bridge binds at construction; arbitrary but must match the
/// `sender` of every injected L1→L2 message.
pub global PORTAL: EthAddress = EthAddress::from_field(0x707741);

pub unconstrained fn portal() -> EthAddress {
    PORTAL
}

/// The Ethereum address every injected deposit message names unless a test says otherwise.
pub global DEPOSITOR: EthAddress = EthAddress::from_field(0xD0D0);

pub unconstrained fn depositor() -> EthAddress {
    DEPOSITOR
}

/// The full wired trio: (env, admin, proxy, token, bridge). Admin owns proxy and bridge (pause rights) and the
/// token's merchant list, as when one wallet deploys everything.
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();

    // TokenMinterProxy: owner = admin (the initializer caller); single-shot set_token/set_bridge.
    let proxy_init = TokenMinterProxy::interface().constructor();
    let proxy = env
        .deploy("@token_minter_proxy/TokenMinterProxy")
        .with_public_initializer(admin, proxy_init);

    // The merchant Token with the PROXY as its only minter (constructor_with_minter); admin curates its list.
    let token_init = Token::interface().constructor_with_minter(
        "UsdcTestToken000000000000000000",
        "NTT0000000000000000000000000000",
        18,
        proxy,
        AztecAddress::zero(),
    );
    let token = env.deploy("@merchant_token/Token").with_public_initializer(admin, token_init);

    // The bridge binds proxy, token and portal; its owner (pause rights) is admin too.
    let bridge_init = TokenBridge::interface().constructor(proxy, token, PORTAL);
    let bridge = env.deploy("TokenBridge").with_public_initializer(admin, bridge_init);

    env.call_public(admin, TokenMinterProxy::at(proxy).set_token(token));
    env.call_public(admin, TokenMinterProxy::at(proxy).set_bridge(bridge));

    (env, admin, proxy, token, bridge)
}

/// Lists `account` as a merchant; adds take effect at once.
pub unconstrained fn list(env: TestEnvironment, admin: AztecAddress, token: AztecAddress, account: AztecAddress) {
    env.call_public(admin, Token::at(token).add_merchant(account));
}

/// A fresh listed merchant with full keys, so it can hold and spend private notes too. Takes the environment by
/// reference: a copy would rewind its account counter and hand the caller's next account the same address.
pub unconstrained fn merchant(env: &mut TestEnvironment, admin: AztecAddress, token: AztecAddress) -> AztecAddress {
    let account = env.create_contract_account();
    list(*env, admin, token, account);
    account
}

/// Injects an L1→L2 `mint_to_private` message from `depositor` with `recipient`'s committed secret hash.
pub unconstrained fn send_mint_to_private_message_from(
    env: TestEnvironment,
    recipient: AztecAddress,
    amount: u128,
    salt: Field,
    depositor: EthAddress,
    bridge: AztecAddress,
) -> Field {
    send_mint_to_private_message_via(env, recipient, amount, salt, depositor, PORTAL, bridge)
}

/// The same message sent by `sender` on L1, which the bridge consumes only when it is the portal.
pub unconstrained fn send_mint_to_private_message_via(
    env: TestEnvironment,
    recipient: AztecAddress,
    amount: u128,
    salt: Field,
    depositor: EthAddress,
    sender: EthAddress,
    bridge: AztecAddress,
) -> Field {
    let content = mint_to_private_content_hash(amount, depositor);
    let secret_hash = aztec::hash::compute_secret_hash([derive_claim_secret(salt, recipient)]);
    env.send_l1_to_l2_message_from_secret_hash(content, secret_hash, sender, bridge)
}

/// Injects an L1→L2 `mint_to_public` message exactly as TokenPortal would commit it, and
/// returns the leaf index to hand to `claim_public`.
pub unconstrained fn send_mint_to_public_message(
    env: TestEnvironment,
    to: AztecAddress,
    amount: u128,
    secret: Field,
    bridge: AztecAddress,
) -> Field {
    send_mint_to_public_message_via(env, to, amount, secret, PORTAL, bridge)
}

/// The same message sent by `sender` on L1, which the bridge consumes only when it is the portal.
pub unconstrained fn send_mint_to_public_message_via(
    env: TestEnvironment,
    to: AztecAddress,
    amount: u128,
    secret: Field,
    sender: EthAddress,
    bridge: AztecAddress,
) -> Field {
    let content = mint_to_public_content_hash(to, amount, DEPOSITOR);
    env.send_l1_to_l2_message_from_secret_hash(
        content,
        aztec::hash::compute_secret_hash([secret]),
        sender,
        bridge,
    )
}

/// Whether `account`'s next private claim must bind, read as a wallet reads it.
pub unconstrained fn unbound(env: TestEnvironment, account: AztecAddress, bridge: AztecAddress) -> bool {
    env.execute_utility(TokenBridge::at(bridge).get_funding_address(account)).is_zero()
}

/// Funds `recipient` with private notes through its own claim of a deposit from DEPOSITOR, binding it on the first.
/// Guard tests that target the PRIVATE proxy/bridge entrypoints need a real private balance first: those calls nullify
/// notes during private execution, so an unfunded caller fails on the missing note or authwit long before reaching the
/// guard under test. `recipient` must come from `create_contract_account()`: light accounts lack the key set needed to
/// spend private notes.
pub unconstrained fn fund_private(
    env: TestEnvironment,
    recipient: AztecAddress,
    amount: u128,
    salt: Field,
    bridge: AztecAddress,
) {
    let leaf = send_mint_to_private_message_from(env, recipient, amount, salt, DEPOSITOR, bridge);
    let bind = unbound(env, recipient, bridge);
    env.call_private(recipient, TokenBridge::at(bridge).claim_private(recipient, amount, salt, leaf, DEPOSITOR, bind));
}

/// Funds a listed merchant's public balance through a relayable public claim.
pub unconstrained fn fund_public(env: TestEnvironment, to: AztecAddress, amount: u128, secret: Field, bridge: AztecAddress) {
    let leaf = send_mint_to_public_message(env, to, amount, secret, bridge);
    env.call_public(to, TokenBridge::at(bridge).claim_public(to, amount, secret, leaf, DEPOSITOR));
}

/// The terms a split deposit's secret commits to. `buyer` and `change_salt` stay with the buyer; the merchant learns
/// only `change_commitment`.
pub struct Split {
    pub amount: u128,
    pub depositor: EthAddress,
    pub merchant: AztecAddress,
    pub price: u128,
    pub payment_ref: Field,
    pub buyer: AztecAddress,
    pub change_salt: Field,
    pub salt: Field,
}

impl Split {
    pub fn change_commitment(self) -> Field {
        split_change_commitment(self.buyer, self.change_salt)
    }

    pub fn secret(self) -> Field {
        split_secret(self.merchant, self.price, self.payment_ref, self.change_commitment(), self.salt)
    }
}

/// Injects the split deposit's `mint_to_private` message, as the router commits it, and returns its leaf index.
pub unconstrained fn send_split_message(env: TestEnvironment, split: Split, bridge: AztecAddress) -> Field {
    let content = mint_to_private_content_hash(split.amount, split.depositor);
    let secret_hash = aztec::hash::compute_secret_hash([split.secret()]);
    env.send_l1_to_l2_message_from_secret_hash(content, secret_hash, PORTAL, bridge)
}

pub unconstrained fn claim_split(
    env: TestEnvironment,
    caller: AztecAddress,
    split: Split,
    leaf: Field,
    bridge: AztecAddress,
) {
    env.call_private(
        caller,
        TokenBridge::at(bridge).claim_split(
            split.amount,
            split.depositor,
            leaf,
            split.merchant,
            split.price,
            split.payment_ref,
            split.change_commitment(),
            split.salt,
        ),
    );
}

pub unconstrained fn return_split(
    env: TestEnvironment,
    caller: AztecAddress,
    split: Split,
    leaf: Field,
    bridge: AztecAddress,
) {
    env.call_private(
        caller,
        TokenBridge::at(bridge).return_split(
            split.amount,
            split.depositor,
            leaf,
            split.merchant,
            split.price,
            split.payment_ref,
            split.change_commitment(),
            split.salt,
        ),
    );
}

/// The buyer collects its change, binding on its first claim of any kind.
pub unconstrained fn claim_change(env: TestEnvironment, split: Split, leaf: Field, bridge: AztecAddress) {
    let bind = unbound(env, split.buyer, bridge);
    env.call_private(
        split.buyer,
        TokenBridge::at(bridge).claim_change(
            split.amount - split.price,
            split.depositor,
            leaf,
            split.secret(),
            split.change_salt,
            bind,
        ),
    );
}

pub unconstrained fn private_balance(env: TestEnvironment, token: AztecAddress, account: AztecAddress) -> u128 {
    env.execute_utility(Token::at(token).balance_of_private(account))
}

pub unconstrained fn total_supply(env: TestEnvironment, token: AztecAddress) -> u128 {
    env.view_public(Token::at(token).total_supply())
}
