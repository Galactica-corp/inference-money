mod config;
mod funding_address_note;
mod test;

// Moves one token between L1 and L2 through its TokenPortal's Inbox/Outbox messages, minting and burning via
// TokenMinterProxy, whose sole minter is this bridge. A user account is bound to the Ethereum address its first private
// claim came from and withdraws only there; merchants (the token's list) claim publicly and exit anywhere but the portal,
// whose payout must lower its own balance, which a transfer to itself never does. A deposit nobody may claim goes back
// to its depositor. A split deposit pays a merchant a price and leaves the rest as change its buyer collects, so a buyer
// pays from L1 in one deposit. The owner can only pause claims, returns and exits.

use aztec::macros::aztec;

#[aztec]
pub contract TokenBridge {
use crate::{config::Config, funding_address_note::{funding_note, FundingAddressNote}};

use aztec::{
context::NullifierExistenceRequest,
macros::{events::event, functions::{external, initializer, internal, only_self, view}, storage::storage},
messages::delivery::MessageDelivery,
oracle::nullifiers::check_nullifier_exists,
protocol::{address::{AztecAddress, EthAddress}, hash::compute_siloed_nullifier},
state_vars::{Owned, PrivateImmutable, PublicImmutable, PublicMutable, StateVariable},
};

use portal_messages::{mint_to_private_content_hash, mint_to_public_content_hash, withdraw_content_hash};

use claim_secret_lib::{derive_claim_secret, split_change_commitment, split_iou, split_iou_spent, split_secret};

use token::Token;
use token_minter_proxy::TokenMinterProxy;

#[storage]
struct Storage<Context> {
owner: PublicMutable<AztecAddress, Context>,
pending_owner: PublicMutable<AztecAddress, Context>,
config: PublicImmutable<Config, Context>,
is_paused: PublicMutable<bool, Context>,
// One per account, set by its first private claim. The initialization nullifier derives from the owner's nullifier
// hiding key, so only the owner can bind its account, and only once.
funding_address: Owned<PrivateImmutable<FundingAddressNote, Context>, Context>,
}

// Every change to the owner, the pending owner or the pause flag emits one of these. They sit above every function:
// check-sole-consumer.sh reads a function's body up to the next `fn`.
#[event]
struct PauseSet {
paused: bool,
}

#[event]
struct OwnershipTransferStarted {
owner: AztecAddress,
pending_owner: AztecAddress,
}

#[event]
struct OwnershipTransferCancelled {
owner: AztecAddress,
pending_owner: AztecAddress,
}

#[event]
struct OwnershipTransferred {
previous_owner: AztecAddress,
new_owner: AztecAddress,
}

#[external("public")]
#[initializer]
fn constructor(token_minter_proxy: AztecAddress, token: AztecAddress, portal: EthAddress) {
let sender = self.msg_sender();
self.storage.owner.write(sender);
self.storage.config.initialize(Config { token_minter_proxy, token, portal });
self.storage.is_paused.write(false);
}

#[external("public")]
fn transfer_ownership(new_owner: AztecAddress) {
assert(self.storage.owner.read() == self.msg_sender(), "Only owner");
assert(!new_owner.is_zero(), "New owner cannot be zero address");
self.storage.pending_owner.write(new_owner);
self.emit(OwnershipTransferStarted { owner: self.msg_sender(), pending_owner: new_owner });
}

#[external("public")]
fn cancel_ownership_transfer() {
assert(self.storage.owner.read() == self.msg_sender(), "Only owner");
let pending_owner = self.storage.pending_owner.read();
assert(!pending_owner.is_zero(), "No pending owner");
self.storage.pending_owner.write(AztecAddress::zero());
self.emit(OwnershipTransferCancelled { owner: self.msg_sender(), pending_owner });
}

#[external("public")]
fn claim_ownership() {
let sender = self.msg_sender();
assert(self.storage.pending_owner.read() == sender, "Only pending owner can claim");
let previous_owner = self.storage.owner.read();
self.storage.owner.write(sender);
self.storage.pending_owner.write(AztecAddress::zero());
self.emit(OwnershipTransferred { previous_owner, new_owner: sender });
}

#[external("public")]
fn set_paused(paused: bool) {
assert(self.storage.owner.read() == self.msg_sender(), "Only owner");
self.storage.is_paused.write(paused);
self.emit(PauseSet { paused });
}

#[external("private")]
#[view]
fn get_config() -> Config {
self.storage.config.read()
}

#[external("public")]
#[view]
fn get_config_public() -> Config {
self.storage.config.read()
}

/// @notice The Ethereum address `owner`'s account is bound to, or zero while unbound
/// @dev Reads the caller's own notes, so only `owner`'s wallet knows the answer.
#[external("utility")]
unconstrained fn get_funding_address(owner: AztecAddress) -> EthAddress {
funding_note(owner, self.storage.funding_address.get_storage_slot()).unwrap_or(EthAddress::zero())
}

#[external("public")]
#[only_self]
fn _assert_not_paused() {
assert(self.storage.is_paused.read() == false, "Bridge is paused");
}

// Both claims and both returns hash the depositor the deposit names, which need not be the address that paid, so each
// must present it; any other consumes nothing.

// Relayable: the mint goes to the merchant the message commits to, whoever submits it.
#[external("public")]
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field, depositor: EthAddress) {
assert(self.storage.is_paused.read() == false, "Bridge is paused");
assert(amount > 0, "Amount must be greater than zero");
let config = self.storage.config.read();
assert(self.view(Token::at(config.token).is_merchant(to)), "Public claims are for merchants only");
let content_hash = mint_to_public_content_hash(to, amount, depositor);
self.context.consume_l1_to_l2_message(content_hash, [secret], config.portal, message_leaf_index);
self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_to_public(to, amount));
}

// The recipient is bound through the message's secret hash (claim_secret), not its content hash, and only the
// recipient may claim: its first claim (`bind`) binds the account to the depositor, every later one must come from
// that address. A wrong `bind` only fails: binding twice repeats a nullifier, and an unbound account has no note to
// read. INVARIANT: claim_private and return_deposit_private are the only consumers of a `mint_to_private` message, and
// both re-derive its secret (scripts/check-sole-consumer.sh).
#[external("private")]
fn claim_private(
recipient: AztecAddress,
amount: u128,
claim_salt: Field,
message_leaf_index: Field,
depositor: EthAddress,
bind: bool,
) {
self.enqueue_self._assert_not_paused();
assert(amount > 0, "Amount must be greater than zero");
assert(!recipient.is_zero(), "Recipient cannot be zero");
assert(self.msg_sender() == recipient, "Only the recipient can claim privately");
let config = self.storage.config.read();
let content_hash = mint_to_private_content_hash(amount, depositor);
let secret = derive_claim_secret(claim_salt, recipient);
self.context.consume_l1_to_l2_message(
content_hash,
[secret],
config.portal,
message_leaf_index,
);
let funding = self.storage.funding_address.at(recipient);
if bind {
// Delivered on chain so a restored wallet rediscovers its binding.
funding.initialize(FundingAddressNote { address: depositor }).deliver(MessageDelivery::onchain_unconstrained());
} else {
assert(funding.get_note().address == depositor, "Deposit is not from this account's funding address");
}
self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_to_private(recipient, amount));
}

// Sends an unclaimed private deposit back to its depositor and mints nothing. Whoever holds the claim data may call
// it, so a deposit is final only once claimed.
#[external("private")]
fn return_deposit_private(
recipient: AztecAddress,
amount: u128,
claim_salt: Field,
message_leaf_index: Field,
depositor: EthAddress,
) {
self.enqueue_self._assert_not_paused();
assert(amount > 0, "Amount must be greater than zero");
let config = self.storage.config.read();
let content_hash = mint_to_private_content_hash(amount, depositor);
let secret = derive_claim_secret(claim_salt, recipient);
self.context.consume_l1_to_l2_message(
content_hash,
[secret],
config.portal,
message_leaf_index,
);
self.context.message_portal(config.portal, withdraw_content_hash(depositor, amount, EthAddress::zero()));
}

// Sends a public deposit to a non-merchant back to its depositor. A merchant's is claimed, never returned: a public
// claim's secret is visible in the mempool, so anyone could otherwise bounce it.
#[external("public")]
fn return_deposit_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field, depositor: EthAddress) {
assert(self.storage.is_paused.read() == false, "Bridge is paused");
assert(amount > 0, "Amount must be greater than zero");
let config = self.storage.config.read();
assert(!self.view(Token::at(config.token).is_merchant(to)), "A merchant's public deposit is claimed, not returned");
let content_hash = mint_to_public_content_hash(to, amount, depositor);
self.context.consume_l1_to_l2_message(content_hash, [secret], config.portal, message_leaf_index);
self.context.message_portal(config.portal, withdraw_content_hash(depositor, amount, EthAddress::zero()));
}

#[external("public")]
fn exit_to_l1_public(recipient: EthAddress, amount: u128, caller_on_l1: EthAddress, authwit_nonce: Field) {
assert(self.storage.is_paused.read() == false, "Bridge is paused");
assert(amount > 0, "Amount must be greater than zero");
assert(!recipient.is_zero(), "Recipient cannot be zero");
let sender = self.msg_sender();
let config = self.storage.config.read();
assert(recipient != config.portal, "Recipient cannot be the portal");
assert(self.view(Token::at(config.token).is_merchant(sender)), "Public exits are for merchants only");
let content = withdraw_content_hash(recipient, amount, caller_on_l1);
self.context.message_portal(config.portal, content);
self.call(TokenMinterProxy::at(config.token_minter_proxy).burn_public(sender, amount, authwit_nonce));
}

// A user withdraws only to its funding address; a merchant (`as_merchant`, proven at the anchor block) anywhere.
#[external("private")]
fn exit_to_l1_private(
recipient: EthAddress,
amount: u128,
caller_on_l1: EthAddress,
authwit_nonce: Field,
as_merchant: bool,
) {
self.enqueue_self._assert_not_paused();
assert(amount > 0, "Amount must be greater than zero");
assert(!recipient.is_zero(), "Recipient cannot be zero");
let sender = self.msg_sender();
let config = self.storage.config.read();
assert(recipient != config.portal, "Recipient cannot be the portal");
if as_merchant {
assert(
self.view(Token::at(config.token).try_prove_merchant(sender)),
"Withdrawals from a user account go only to its funding address",
);
} else {
// Safety: only picks the refusal text for an unbound account; get_note below proves the binding or fails.
let bound = unsafe { funding_note(sender, self.storage.funding_address.get_storage_slot()).is_some() };
assert(bound, "Withdrawals from a user account go only to its funding address");
assert(
self.storage.funding_address.at(sender).get_note().address == recipient,
"Withdrawals from a user account go only to its funding address",
);
}
let content = withdraw_content_hash(recipient, amount, caller_on_l1);
self.context.message_portal(config.portal, content);
self.call(TokenMinterProxy::at(config.token_minter_proxy).burn_private(sender, amount, authwit_nonce));
}

// A split deposit's secret commits to the merchant, the price, the merchant's payment reference and the buyer's change
// commitment, so its claim can only pay the price to that merchant and leave the rest as change for the account behind
// the commitment. Relayable: the merchant claims it, and the buyer can if the merchant never does. INVARIANT: claim_split
// and return_split are the only consumers of a split message, and both re-derive its secret from the terms
// (scripts/check-sole-consumer.sh).
#[external("private")]
fn claim_split(
amount: u128,
depositor: EthAddress,
message_leaf_index: Field,
merchant: AztecAddress,
price: u128,
payment_ref: Field,
change_commitment: Field,
salt: Field,
) {
self.enqueue_self._assert_not_paused();
assert(price > 0, "Price must be greater than zero");
assert(price <= amount, "The price exceeds the deposit");
let config = self.storage.config.read();
assert(
self.view(Token::at(config.token).try_prove_merchant(merchant)),
"Split deposits pay listed merchants only",
);
let content_hash = mint_to_private_content_hash(amount, depositor);
let secret = split_secret(merchant, price, payment_ref, change_commitment, salt);
self.context.consume_l1_to_l2_message(
content_hash,
[secret],
config.portal,
message_leaf_index,
);
let change = amount - price;
if change > 0 {
self.context.push_nullifier_unsafe(split_iou(change_commitment, change, depositor, secret, message_leaf_index));
}
// The merchant's own claim proves the tx, so its note needs no constrained delivery, which would announce it.
let self_send = self.msg_sender() == merchant;
self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_split_to_private(merchant, price, amount, self_send));
}

// Sends a split deposit back to its depositor when it cannot pay its merchant: the price exceeds the deposit, or the
// merchant is proven not one at the anchor. Consuming the message proves its inclusion at the anchor, so the anchor
// follows the deposit and a merchant listed before it cannot be proven unlisted. Mints nothing.
#[external("private")]
fn return_split(
amount: u128,
depositor: EthAddress,
message_leaf_index: Field,
merchant: AztecAddress,
price: u128,
payment_ref: Field,
change_commitment: Field,
salt: Field,
) {
self.enqueue_self._assert_not_paused();
let config = self.storage.config.read();
if price <= amount {
self.view(Token::at(config.token).prove_not_merchant(merchant));
}
let content_hash = mint_to_private_content_hash(amount, depositor);
let secret = split_secret(merchant, price, payment_ref, change_commitment, salt);
self.context.consume_l1_to_l2_message(
content_hash,
[secret],
config.portal,
message_leaf_index,
);
self.context.message_portal(config.portal, withdraw_content_hash(depositor, amount, EthAddress::zero()));
}

// Collects a split deposit's change into the caller's private balance. Only the account behind the change commitment
// can, and its funding address rules apply as for claim_private: the first collection binds it to the depositor, a
// later one must match it.
#[external("private")]
fn claim_change(
amount_change: u128,
depositor: EthAddress,
message_leaf_index: Field,
secret: Field,
change_salt: Field,
bind: bool,
) {
self.enqueue_self._assert_not_paused();
assert(amount_change > 0, "Amount must be greater than zero");
let recipient = self.msg_sender();
self.internal._spend_iou(recipient, amount_change, depositor, message_leaf_index, secret, change_salt);
let funding = self.storage.funding_address.at(recipient);
if bind {
// Delivered on chain so a restored wallet rediscovers its binding.
funding.initialize(FundingAddressNote { address: depositor }).deliver(MessageDelivery::onchain_unconstrained());
} else {
assert(funding.get_note().address == depositor, "Deposit is not from this account's funding address");
}
let config = self.storage.config.read();
self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_reserved_to_private(recipient, amount_change));
}

// Sends a split deposit's change back to its depositor on L1, for a buyer whose account is bound elsewhere. Whoever
// holds the change's data may call it; the payout only ever goes to the depositor. Publishes the change amount.
#[external("private")]
fn return_change(
buyer: AztecAddress,
amount_change: u128,
depositor: EthAddress,
message_leaf_index: Field,
secret: Field,
change_salt: Field,
) {
self.enqueue_self._assert_not_paused();
assert(amount_change > 0, "Amount must be greater than zero");
self.internal._spend_iou(buyer, amount_change, depositor, message_leaf_index, secret, change_salt);
let config = self.storage.config.read();
self.context.message_portal(config.portal, withdraw_content_hash(depositor, amount_change, EthAddress::zero()));
self.enqueue(TokenMinterProxy::at(config.token_minter_proxy).release_reserved(amount_change));
}

// Proves `owner`'s IOU for this change exists (a settled claim_split left it) and marks it collected, once.
#[internal("private")]
fn _spend_iou(
owner: AztecAddress,
amount_change: u128,
depositor: EthAddress,
message_leaf_index: Field,
secret: Field,
change_salt: Field,
) {
let change_commitment = split_change_commitment(owner, change_salt);
let iou = split_iou(change_commitment, amount_change, depositor, secret, message_leaf_index);
// Safety: advice for a readable refusal only; the existence request below is what the kernel checks.
let owed = unsafe { check_nullifier_exists(iou) };
assert(owed, "No such change to collect");
self.context.assert_nullifier_exists(NullifierExistenceRequest::for_settled(
compute_siloed_nullifier(self.context.this_address(), iou),
));
let spent = split_iou_spent(iou, change_salt);
// Safety: advice for a readable refusal only; uniqueness is the kernel's to enforce.
let collected = unsafe { check_nullifier_exists(spent) };
assert(!collected, "The change is already collected");
self.context.push_nullifier_unsafe(spent);
}
}
