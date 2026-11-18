// The derivations token_bridge consumes private deposits with, pinned by the keystone against
// packages/bridge-core/src/claim-secret.ts and split.ts, so the toolchains cannot drift a deposit into an unclaimable
// state.
//
// A plain private deposit's message commits to `compute_secret_hash(derive_claim_secret(salt, recipient))`, and both of
// its consumers re-derive the secret from their `recipient` argument: claim_private, which only the recipient may
// submit, and return_deposit_private, which only pays the depositor back. A split deposit's commits to
// `compute_secret_hash(split_secret(merchant, price, payment_ref, change_commitment, salt))`, and its two consumers
// re-derive it from those terms: claim_split, which pays the merchant the price and leaves the rest as change, and
// return_split, which only pays the depositor back, and only when the merchant cannot be paid. Whoever holds a
// deposit's data can return it (within those rules) but never redirect it. Rests on poseidon2 preimage resistance,
// distinct separators, and those four being the only consumers of private-deposit messages
// (scripts/check-sole-consumer.sh).
use aztec::protocol::address::{AztecAddress, EthAddress};
use aztec::protocol::hash::poseidon2_hash_with_separator;
use aztec::protocol::traits::ToField;

// poseidon2_hash_bytes("nulo_dom_sep__token_bridge_private_claim_secret") as u32, pinned as a literal; the keystones
// re-derive it and assert it differs from the FPC fuel and protocol secret-hash separators. The inherited `nulo_`
// prefix is not Aztec-canonical, but changing it re-keys every claim.
pub global DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET: u32 = 3140354885;

pub fn derive_claim_secret(claim_salt: Field, recipient: AztecAddress) -> Field {
    poseidon2_hash_with_separator(
        [claim_salt, recipient.to_field()],
        DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET,
    )
}

// Split deposits: one private deposit whose secret commits to a merchant, a price, the merchant's payment reference and
// a commitment to the buyer's change, so the deposit can only be split as agreed. The price goes to the merchant, the
// change waits as an IOU (a bridge nullifier) that only the account behind `change_commitment` collects. Each separator
// is poseidon2_hash_bytes(<its name>) as u32, pinned as a literal; the keystone re-derives them and asserts they differ
// from each other and from every protocol, aztec-nr and token separator, the claim secret's included, so a split secret
// is never a plain claim secret and no IOU or spent marker is any other nullifier the bridge pushes.
pub global DOM_SEP__TOKEN_BRIDGE_SPLIT_CLAIM: u32 = 2878369513;
pub global DOM_SEP__TOKEN_BRIDGE_SPLIT_CHANGE: u32 = 1854012931;
pub global DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU: u32 = 2366609694;
pub global DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU_SPENT: u32 = 3143065046;

/// Hides the buyer, who collects the change, from the merchant, who learns only this commitment. `change_salt` MUST be
/// fresh randomness: the commitment and the spent marker are only as hiding as it is.
pub fn split_change_commitment(buyer: AztecAddress, change_salt: Field) -> Field {
    poseidon2_hash_with_separator([buyer.to_field(), change_salt], DOM_SEP__TOKEN_BRIDGE_SPLIT_CHANGE)
}

/// The L1-to-L2 message secret of a split deposit. `salt` MUST be fresh randomness: the secret hash is public on L1.
pub fn split_secret(
    merchant: AztecAddress,
    price: u128,
    payment_ref: Field,
    change_commitment: Field,
    salt: Field,
) -> Field {
    poseidon2_hash_with_separator(
        [merchant.to_field(), price as Field, payment_ref, change_commitment, salt],
        DOM_SEP__TOKEN_BRIDGE_SPLIT_CLAIM,
    )
}

/// The IOU a claimed split deposit leaves for its change. The leaf index makes it unique per message: two deposits with
/// the same terms would otherwise leave one IOU, and the second claim could never push it.
pub fn split_iou(
    change_commitment: Field,
    change: u128,
    depositor: EthAddress,
    secret: Field,
    message_leaf_index: Field,
) -> Field {
    poseidon2_hash_with_separator(
        [change_commitment, change as Field, depositor.to_field(), secret, message_leaf_index],
        DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU,
    )
}

/// Marks an IOU collected. `change_salt` keeps the merchant, who can compute the IOU, from seeing when it is collected;
/// it is fixed by the IOU (it opens `change_commitment`), so an IOU has exactly one spent marker.
pub fn split_iou_spent(iou: Field, change_salt: Field) -> Field {
    poseidon2_hash_with_separator([iou, change_salt], DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU_SPENT)
}
