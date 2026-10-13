// Forked from AztecProtocol/aztec-standards v6.0.0-rc.3 (f7bf63d5), src/token_contract; MIT, see LICENSE.
// Delta:
// - the package is `merchant_token`, and its path dependencies are the same upstream crates by pinned git tag;
// - a merchant list is appended (storage, events, the MERCHANTS section); upstream's storage slots, events and function
//   signatures are unchanged (scripts/abi-superset.test.ts);
// - the private transfers, request openings and payments refuse unless one side is a listed merchant or the request was
//   opened for one, except a transfer into the sender's own private balance; each check runs before any balance moves;
// - a note its owner's own call or nullifier key proves (change, a send or shield to oneself, a bridge mint) is
//   delivered unconstrained under an address-derived tag, so it announces no handshake.
pub mod hints;
pub mod test;

use aztec::macros::aztec;

#[aztec]
pub contract Token {
    // aztec library
    use aztec::{
        authwit::auth::compute_authwit_nullifier,
        macros::{
            events::event,
            functions::{authorize_once, external, initializer, internal, only_self, view},
            storage::storage,
        },
        messages::delivery::{MessageDelivery, OnchainUnconstrainedDelivery},
        protocol::{address::AztecAddress, traits::{FromField, ToField}},
        state_vars::{Map, Owned, PublicImmutable, PublicMutable, StateVariable},
    };
    // note library
    use uint_note::{PartialUintNote, UintNote};
    // compression library
    use compressed_string::FieldCompressedString;
    // private balance library
    use balance_set::BalanceSet;
    // ARC-403 authorization hook interface (draft; see src/arc403_interface)
    use arc403_interface::Arc403Authorizer;
    // merchant list
    use crate::hints::{
        FIRST, is_merchant_at_anchor, MERCHANT_MAX_DELAY, MERCHANT_MIN_DELAY, merchant_side_hint,
        MerchantList, NEITHER, payment_side_hint, SECOND,
    };
    use aztec::{
        context::{NullifierExistenceRequest, PrivateContext},
        oracle::{nullifiers::check_nullifier_exists, offchain_effect::emit_offchain_effect},
        protocol::{hash::compute_siloed_nullifier, traits::{Deserialize, Serialize}},
        state_vars::DelayedPublicMutable,
    };
    use merchant_stamp::{
        pad, paid, REQUEST_OPENED_EFFECT, stamp, stamp_bucket, stamp_deadline, STAMP_LIVE_BUCKETS,
    };

    // gas-optimized max notes for initial transfer call
    global INITIAL_TRANSFER_CALL_MAX_NOTES: u32 = 2;
    // max notes transfer for recursive transfer call if initial max notes are exceeded
    global RECURSIVE_TRANSFER_CALL_MAX_NOTES: u32 = 8;

    // Sentinel address used in Transfer events to represent the private side of a balance change.
    // sha224sum 'PRIVATE_ADDRESS'
    global PRIVATE_ADDRESS_MAGIC_VALUE: AztecAddress =
        AztecAddress::from_field(0x1ea7e01501975545617c2e694d931cb576b691a4a867fed81ebd3264);

    #[event]
    struct Transfer {
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
    }

    // Every change to a merchant entry emits one of these three, so they are a complete feed of the list.
    #[event]
    struct MerchantAdded {
        account: AztecAddress,
    }

    #[event]
    struct MerchantOffScheduled {
        account: AztecAddress,
        off: bool,
        effective_at: u64,
    }

    #[event]
    struct MerchantDelayScheduled {
        account: AztecAddress,
        delay: u64,
        effective_at: u64,
    }

    #[event]
    struct MerchantAdminProposed {
        pending_admin: AztecAddress,
    }

    #[event]
    struct MerchantAdminAccepted {
        previous_admin: AztecAddress,
        admin: AztecAddress,
    }

    #[event]
    struct MerchantGuardianScheduled {
        guardian: AztecAddress,
        effective_at: u64,
    }

    // `set_merchant_delay` also reschedules the guardian slot's own delay, which applies from this timestamp.
    #[event]
    struct MerchantDelaySet {
        delay: u64,
        guardian_delay_effective_at: u64,
    }

    /// A merchant entry: registered, switched off now, the latest scheduled switch value and when it applies, and the
    /// entry's delay now and scheduled.
    #[derive(Deserialize, Eq, Serialize)]
    pub struct MerchantStatus {
        pub registered: bool,
        pub off: bool,
        pub scheduled_off: bool,
        pub scheduled_off_at: u64,
        pub delay: u64,
        pub scheduled_delay: u64,
        pub scheduled_delay_at: u64,
    }

    /// Who governs the list: the admin, a proposed admin (zero if none), the guardian now and scheduled, the delay
    /// setting, and the guardian slot's own delay.
    #[derive(Deserialize, Eq, Serialize)]
    pub struct MerchantRoles {
        pub admin: AztecAddress,
        pub pending_admin: AztecAddress,
        pub guardian: AztecAddress,
        pub scheduled_guardian: AztecAddress,
        pub scheduled_guardian_at: u64,
        pub delay: u64,
        pub guardian_delay: u64,
    }

    /// @param name The name of the token
    /// @param symbol The symbol of the token
    /// @param decimals The number of decimals of the token
    /// @param private_balances The private balances of the token
    /// @param total_supply The total supply of the token
    /// @param public_balances The public balances of the token
    /// @param minter The account permissioned to mint the token
    /// @param auth_contract The authorization contract called on every transfer
    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        decimals: PublicImmutable<u8, Context>,
        private_balances: Owned<BalanceSet<Context>, Context>,
        total_supply: PublicMutable<u128, Context>,
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
        auth_contract: PublicImmutable<AztecAddress, Context>,
        // Appended after upstream's fields so theirs keep their slots.
        merchant_admin: PublicMutable<AztecAddress, Context>,
        pending_merchant_admin: PublicMutable<AztecAddress, Context>,
        // Replaced on its own delay, which the constructors raise to the setting.
        merchant_guardian: DelayedPublicMutable<AztecAddress, MERCHANT_MIN_DELAY, Context>,
        merchant_delay: PublicMutable<u64, Context>,
        // Append-only: an entry is never removed, only switched off.
        merchants: Map<AztecAddress, PublicImmutable<bool, Context>, Context>,
        merchant_off: Map<AztecAddress, DelayedPublicMutable<bool, MERCHANT_MIN_DELAY, Context>, Context>,
    }

    /// @notice Initializes the token with an initial supply
    /// @dev The minter is initialized to the zero address, so the mint functions are disabled
    /// @param name The name of the token
    /// @param symbol The symbol of the token
    /// @param decimals The number of decimals of the token
    /// @param initial_supply The initial supply of the token
    /// @param to The address to mint the initial supply to
    /// @param auth_contract The address of the authorization contract (zero address to disable)
    #[external("public")]
    #[initializer]
    fn constructor_with_initial_supply(
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        initial_supply: u128,
        to: AztecAddress,
        auth_contract: AztecAddress,
    ) {
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.auth_contract.initialize(auth_contract);
        self.storage.minter.initialize(AztecAddress::zero());
        self.internal._initialize_merchant_roles(self.msg_sender());

        self.internal._mint_to_public(to, initial_supply);
    }

    /// @notice Initializes the token with a minter
    /// @param name The name of the token
    /// @param symbol The symbol of the token
    /// @param decimals The number of decimals of the token
    /// @param minter The address of the minter
    /// @param auth_contract The address of the authorization contract (zero address to disable)
    #[external("public")]
    #[initializer]
    fn constructor_with_minter(
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        minter: AztecAddress,
        auth_contract: AztecAddress,
    ) {
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.auth_contract.initialize(auth_contract);

        self.storage.minter.initialize(minter);
        self.internal._initialize_merchant_roles(self.msg_sender());
    }

    /** ==========================================================
    * ========================= PRIVATE =========================
    * ======================================================== */

    /// @notice Transfer tokens from private balance to public balance
    /// @dev Spends notes, emits a new note (UintNote) with any remaining change, and enqueues a public call
    /// @param from The address of the sender
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to transfer
    /// @param _nonce The nonce used for authwitness
    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        let side = self.internal._prove_merchant_side(to, from, true);
        assert(side != NEITHER, "Transfer refused: neither sender nor recipient is a merchant");

        self.internal._call_auth_private(from, amount);

        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);

        self.enqueue_self.increase_public_balance_internal(to, amount);
    }

    /// @notice Transfer tokens from private balance to public balance, with a refund commitment for `from`
    /// @dev The refund pattern: a contract pulls `amount` publicly and later returns any unused part to `from`
    ///      privately via `transfer_public_to_commitment`. The commitment is owned by `from` and completable only by
    ///      `msg_sender` (the integrating contract when called through an authwit). Complete it at most once (see
    ///      README). It is never stamped, so only a merchant source can complete it.
    /// @param from The address of the sender, and the owner of the commitment
    /// @param to The address of the recipient of the public balance
    /// @param amount The amount of tokens to transfer
    /// @param _nonce The nonce used for authwitness
    /// @return commitment The refund commitment owned by `from`
    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_public_with_commitment(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) -> Field {
        let side = self.internal._prove_merchant_side(to, from, true);
        assert(side != NEITHER, "Transfer refused: neither sender nor recipient is a merchant");

        self.internal._call_auth_private(from, amount);

        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);

        self.enqueue_self.increase_public_balance_internal(to, amount);

        let completer = self.msg_sender();
        // Never stamped: a stamp is the only owner check a payment makes, and this commitment's owner may be a user.
        let commitment = self.internal._initialize_transfer_commitment(from, completer);
        commitment.to_field()
    }

    /// @notice Transfer tokens from private balance to another private balance
    /// @dev Spends notes, emits a new note (UintNote) with any remaining change, and sends a note to the recipient
    /// @param from The address of the sender
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to transfer
    /// @param _nonce The nonce used for authwitness
    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        let side = self.internal._prove_merchant_side(to, from, false);
        // A send to oneself moves value between no two accounts, and is how a user merges notes a payment cannot all
        // spend in one tx.
        assert(
            (side != NEITHER) | (from == to),
            "Transfer refused: neither sender nor recipient is a merchant",
        );

        self.internal._call_auth_private(from, amount);

        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);

        // A send to oneself: this call just nullified the recipient's notes.
        self.internal._increase_private_balance(to, amount, from == to);
    }

    /// @notice Transfer tokens from a private balance to the recipient commitment, which must be already initialized.
    /// @dev Spends notes, emits a new note (UintNote) with any remaining change, and enqueues a public call.
    ///      The `msg_sender` must be the completer of the partial note.
    /// @param from The address of the sender
    /// @param commitment The partial note representing the commitment (privacy entrance that the recipient shares with the sender)
    /// @param amount The amount of tokens to transfer
    /// @param _nonce The nonce used for authwitness
    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_commitment(
        from: AztecAddress,
        commitment: Field,
        amount: u128,
        _nonce: Field,
    ) {
        // A request takes one payment, and a zero one would spend it: upstream's private completion accepts zero.
        assert(amount != 0, "Payment refused: the amount is zero");
        let side = self.internal._prove_payment_side(from, commitment);
        assert(
            side != NEITHER,
            "Payment refused: users may only pay into requests opened for a merchant",
        );
        self.internal._push_paid(commitment);

        self.internal._call_auth_private(from, amount);

        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);

        let completer = self.msg_sender();
        PartialUintNote::from_field(commitment).complete_from_private(
            self.context,
            completer,
            self.storage.private_balances.get_storage_slot(),
            amount,
        );
    }

    /// @notice Transfer tokens from public balance to private balance
    /// @dev Enqueues a public call to decrease account balance and emits a new note with balance difference
    /// @param from The address of the sender
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to transfer
    /// @param _nonce The nonce used for authwitness
    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_public_to_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        let side = self.internal._prove_merchant_side(from, to, true);
        // A shield to oneself moves value between no two accounts, so a user or an ex-merchant may make one.
        assert(
            (side != NEITHER) | (from == to),
            "Transfer refused: neither sender nor recipient is a merchant",
        );

        self.internal._call_auth_private(from, amount);

        self.enqueue_self.decrease_public_balance_internal(from, amount);

        // Only `to` shielding for itself: a caller acting on `to`'s authwit could withhold the note.
        self.internal._increase_private_balance(to, amount, (from == to) & (to == self.msg_sender()));
    }

    /// @notice Initializes a transfer commitment to be used for transfers/mints
    /// @dev Returns a partial note that can be used to execute transfers/mints
    /// @param to The address of the recipient
    /// @param completer The address allowed to complete the partial note
    /// @return commitment The partial note initialized for the transfer/mint commitment
    #[external("private")]
    fn initialize_transfer_commitment(to: AztecAddress, completer: AztecAddress) -> Field {
        let side = self.internal._prove_merchant_side(to, self.msg_sender(), true);
        assert(side != NEITHER, "Request refused: neither creator nor recipient is a merchant");

        let commitment = self.internal._initialize_transfer_commitment(to, completer);
        self.internal._push_request_stamp(commitment.to_field(), side);
        commitment.to_field()
    }

    /// @notice Recursively subtracts balance from private balance
    /// @dev Used to subtract private balances that exceed the max notes limit
    /// @param account The address of the account to subtract the balance from
    /// @param amount The amount of tokens to subtract
    /// @return The change to return to the owner
    #[external("private")]
    #[only_self]
    fn recurse_subtract_balance_internal(account: AztecAddress, amount: u128) -> u128 {
        self.internal._subtract_balance(account, amount, RECURSIVE_TRANSFER_CALL_MAX_NOTES)
    }

    /** ==========================================================
    * ========================= PUBLIC ==========================
    * ======================================================== */

    /// @notice Transfers tokens from public balance to public balance
    /// @dev Public call to decrease account balance and a public call to increase recipient balance
    /// @param from The address of the sender
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to transfer
    /// @param _nonce The nonce used for authwitness
    #[authorize_once("from", "_nonce")]
    #[external("public")]
    fn transfer_public_to_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._call_auth_public(from, amount);

        self.internal._decrease_public_balance(from, amount);
        self.internal._increase_public_balance(to, amount);

        self.emit(Transfer { from, to, amount });
    }

    /// @notice Finalizes a transfer of token `amount` from public balance of `from` to a commitment of `to`
    /// @dev The transfer must be prepared by calling `initialize_transfer_commitment` first and the resulting
    /// `commitment` must be passed as an argument to this function.
    /// @dev The sender will be used as the completer for the partial note.
    /// @param from The address of the sender
    /// @param commitment The partial note representing the commitment (privacy entrance)
    /// @param amount The amount of tokens to transfer
    /// @param _nonce The nonce used for authwitness
    #[authorize_once("from", "_nonce")]
    #[external("public")]
    fn transfer_public_to_commitment(
        from: AztecAddress,
        commitment: Field,
        amount: u128,
        _nonce: Field,
    ) {
        // aztec-nr's public completion refuses zero only behind a TODO to remove the check.
        assert(amount != 0, "Payment refused: the amount is zero");
        // The payer first: a merchant needs no stamp, which spares it the search.
        if !self.internal._is_merchant(from) {
            assert(
                self.internal._has_live_stamp(commitment),
                "Payment refused: users may only pay into requests opened for a merchant",
            );
        }
        let paid_nullifier = paid(commitment);
        // A repeated nullifier reverts by itself; this only says why.
        assert(
            !self.context.nullifier_exists_unsafe(paid_nullifier, self.context.this_address()),
            "Payment refused: the request is already paid",
        );
        self.context.push_nullifier_unsafe(paid_nullifier);

        self.internal._call_auth_public(from, amount);

        self.internal._decrease_public_balance(from, amount);

        let completer = self.msg_sender();
        self.internal._increase_commitment_balance(
            PartialUintNote::from_field(commitment),
            completer,
            amount,
        );

        self.emit(Transfer { from, to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    /// @notice Increases the public balance of `to` by `amount`
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to increase the balance by
    #[external("public")]
    #[only_self]
    fn increase_public_balance_internal(to: AztecAddress, amount: u128) {
        self.internal._increase_public_balance(to, amount);

        self.emit(Transfer { from: PRIVATE_ADDRESS_MAGIC_VALUE, to, amount });
    }

    /// @notice Decreases the public balance of `from` by `amount`
    /// @param from The address of the sender
    /// @param amount The amount of tokens to decrease the balance by
    #[external("public")]
    #[only_self]
    fn decrease_public_balance_internal(from: AztecAddress, amount: u128) {
        self.internal._decrease_public_balance(from, amount);

        self.emit(Transfer { from, to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    /** ==========================================================
    * ====================== VIEW FUNCTIONS =====================
    * ======================================================== */

    /// @notice Returns the public balance of `owner`
    /// @param owner The address of the owner
    /// @return The balance of the public balance of `owner`
    #[external("public")]
    #[view]
    fn balance_of_public(owner: AztecAddress) -> u128 {
        self.storage.public_balances.at(owner).read()
    }

    /// @notice Returns the total supply of the token
    /// @return The total supply of the token
    #[external("public")]
    #[view]
    fn total_supply() -> u128 {
        self.storage.total_supply.read()
    }

    /// @notice Returns the name of the token
    /// @return The name of the token
    #[external("public")]
    #[view]
    fn name() -> FieldCompressedString {
        self.storage.name.read()
    }

    /// @notice Returns the symbol of the token
    /// @return The symbol of the token
    #[external("public")]
    #[view]
    fn symbol() -> FieldCompressedString {
        self.storage.symbol.read()
    }

    /// @notice Returns the decimals of the token
    /// @return The decimals of the token
    #[external("public")]
    #[view]
    fn decimals() -> u8 {
        self.storage.decimals.read()
    }

    /// @notice Returns the ARC-403 authorization hook contract address
    /// @return The auth contract address (zero address means authorization is disabled)
    #[external("public")]
    #[view]
    fn get_auth_contract() -> AztecAddress {
        self.storage.auth_contract.read()
    }

    /// @notice Returns the authorized minter address
    /// @return The minter address (zero address means minting is disabled)
    #[external("public")]
    #[view]
    fn get_minter() -> AztecAddress {
        self.storage.minter.read()
    }

    /** ==========================================================
     * ===================== UNCONSTRAINED =======================
     * ======================================================== */

    /// @notice Returns the private balance of an account
    /// @param owner The address to query
    /// @return The private balance of the address
    #[external("utility")]
    unconstrained fn balance_of_private(owner: AztecAddress) -> u128 {
        self.storage.private_balances.at(owner).balance_of()
    }

    /** ==========================================================
    * ======================= MINTABLE ==========================
    * ======================================================== */

    /// @notice Mints tokens to a private balance
    /// @dev Mints tokens to a private balance and enqueues a public call to increase the total supply
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to mint
    #[external("private")]
    fn mint_to_private(to: AztecAddress, amount: u128) {
        _validate_minter(self.msg_sender(), self.storage.minter.read());

        self.internal._mint_to_private(to, amount);
    }

    /// @notice Mints tokens to an address publicly
    /// @dev Increases the public balance of `to` by `amount` and the total supply
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to mint
    #[external("public")]
    fn mint_to_public(to: AztecAddress, amount: u128) {
        _validate_minter(self.msg_sender(), self.storage.minter.read());

        self.internal._mint_to_public(to, amount);
    }

    /// @notice Finalizes a mint to a commitment
    /// @dev Finalizes a mint to a commitment and updates the total supply
    /// @param commitment The partial note representing the mint commitment (privacy entrance)
    /// @param amount The amount of tokens to mint
    #[external("public")]
    fn mint_to_commitment(commitment: Field, amount: u128) {
        let completer = self.msg_sender();
        _validate_minter(completer, self.storage.minter.read());
        self.internal._increase_total_supply(amount);
        self.internal._increase_commitment_balance(
            PartialUintNote::from_field(commitment),
            completer,
            amount,
        );

        self.emit(Transfer { from: AztecAddress::zero(), to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    /// @notice Internal function to increase the total supply by `amount`
    /// @param amount The amount to increase the total supply by
    #[external("public")]
    #[only_self]
    fn increase_total_supply_internal(amount: u128) {
        self.internal._increase_total_supply(amount);

        self.emit(Transfer { from: AztecAddress::zero(), to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    /** ==========================================================
     * ======================= BURNABLE ==========================
     * ======================================================== */

    /// @notice Burns tokens from a private balance
    /// @dev Burns tokens from a private balance and enqueues a public call to update the total supply
    /// @param from The address of the sender
    /// @param amount The amount of tokens to burn
    /// @param _nonce The nonce used for authwitness
    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn burn_private(from: AztecAddress, amount: u128, _nonce: Field) {
        self.internal._call_auth_private(from, amount);

        self.internal._burn_private(from, amount);
    }

    /// @notice Burns tokens from a public balance
    /// @dev Burns tokens from a public balance and updates the total supply
    /// @param from The address of the sender
    /// @param amount The amount of tokens to burn
    /// @param _nonce The nonce used for authwitness
    #[authorize_once("from", "_nonce")]
    #[external("public")]
    fn burn_public(from: AztecAddress, amount: u128, _nonce: Field) {
        self.internal._call_auth_public(from, amount);

        self.internal._burn_public(from, amount);
    }

    /// @notice Cancels a private authentication witness the caller previously granted
    /// @dev Emits the authwit nullifier for `(msg_sender, inner_hash)`, so an authwit that has been
    ///      granted but not yet consumed can no longer be used. Matches the upstream Token contract.
    /// @param inner_hash The inner hash of the authwit to cancel
    #[external("private")]
    fn cancel_authwit(inner_hash: Field) {
        let on_behalf_of = self.msg_sender();
        let nullifier = compute_authwit_nullifier(on_behalf_of, inner_hash);
        self.context.push_nullifier_unsafe(nullifier);
    }

    /// @notice Decreases the total supply by `amount`
    /// @param amount The amount of tokens to decrease the total supply by
    #[external("public")]
    #[only_self]
    fn decrease_total_supply_internal(amount: u128) {
        self.internal._decrease_total_supply(amount);

        self.emit(Transfer { from: PRIVATE_ADDRESS_MAGIC_VALUE, to: AztecAddress::zero(), amount });
    }

    /** ==========================================================
     * ======================= MERCHANTS =========================
     * ======================================================== */

    /// @notice Lists `account` as a merchant, effective at once; the register is append-only
    /// @dev The entry starts on the delay setting: raising from the slot's 3600 s floor applies at once
    /// @param account The account to list
    #[external("public")]
    fn add_merchant(account: AztecAddress) {
        self.internal._assert_merchant_admin();
        assert(!account.is_zero(), "Merchant is the zero address");
        let register = self.storage.merchants.at(account);
        assert(!register.is_initialized(), "Merchant already added");
        register.initialize(true);
        self.emit(MerchantAdded { account });

        let delay = self.storage.merchant_delay.read();
        let entry = self.storage.merchant_off.at(account);
        entry.schedule_delay_change(delay);
        let (_, effective_at) = entry.get_scheduled_delay();
        self.emit(MerchantDelayScheduled { account, delay, effective_at });
    }

    /// @notice Schedules switching a merchant off (`off`) or back on, after the entry's delay
    /// @dev A no-op when `off` is already the latest scheduled value, so repeats never restart the clock. Scheduling the
    ///      current value cancels a pending change and unmarks the entry: a change to the current value caps no read.
    /// @param account The listed merchant
    /// @param off Whether the merchant is to be switched off
    #[external("public")]
    fn schedule_merchant_off(account: AztecAddress, off: bool) {
        self.internal._assert_merchant_admin();
        assert(self.storage.merchants.at(account).is_initialized(), "Not a registered merchant");
        let entry = self.storage.merchant_off.at(account);
        let (scheduled, _) = entry.get_scheduled_value();
        if scheduled != off {
            let (_, effective_at) = entry.schedule_and_get_value_change(off).get_scheduled();
            self.emit(MerchantOffScheduled { account, off, effective_at });
        }
    }

    /// @notice Sets the switch-off delay for entries synced from now on, and schedules it on the guardian slot
    /// @dev An increase applies at once and a decrease waits old - new (DelayedPublicMutable's rule), per entry
    /// @param delay The delay in seconds, within [3600, 86400]
    #[external("public")]
    fn set_merchant_delay(delay: u64) {
        self.internal._assert_merchant_admin();
        assert((delay >= MERCHANT_MIN_DELAY) & (delay <= MERCHANT_MAX_DELAY), "Delay out of range");
        self.storage.merchant_delay.write(delay);
        self.storage.merchant_guardian.schedule_delay_change(delay);
        let (_, guardian_delay_effective_at) = self.storage.merchant_guardian.get_scheduled_delay();
        self.emit(MerchantDelaySet { delay, guardian_delay_effective_at });
    }

    /// @notice Schedules the delay setting on one entry; a no-op when it is already the entry's scheduled delay
    /// @dev Anyone may sync an entry to a setting at or above its current delay, which undoes an entry singled out on a
    ///      shorter delay; only the admin may start a decrease, so a guardian's cancel of one binds everyone else
    /// @param account The listed merchant
    #[external("public")]
    fn sync_merchant_delay(account: AztecAddress) {
        assert(self.storage.merchants.at(account).is_initialized(), "Not a registered merchant");
        let delay = self.storage.merchant_delay.read();
        let entry = self.storage.merchant_off.at(account);
        let (scheduled, _) = entry.get_scheduled_delay();
        if scheduled != delay {
            assert(
                (delay >= entry.get_current_delay())
                    | (self.msg_sender() == self.storage.merchant_admin.read()),
                "Only the merchant admin lowers a delay",
            );
            entry.schedule_delay_change(delay);
            let (_, effective_at) = entry.get_scheduled_delay();
            self.emit(MerchantDelayScheduled { account, delay, effective_at });
        }
    }

    /// @notice Proposes the next merchant admin, who takes over by accepting; zero withdraws the proposal
    /// @param new_admin The proposed admin
    #[external("public")]
    fn propose_merchant_admin(new_admin: AztecAddress) {
        self.internal._assert_merchant_admin();
        self.storage.pending_merchant_admin.write(new_admin);
        self.emit(MerchantAdminProposed { pending_admin: new_admin });
    }

    /// @notice Completes the handover to the proposed merchant admin
    #[external("public")]
    fn accept_merchant_admin() {
        let pending = self.storage.pending_merchant_admin.read();
        assert(
            !pending.is_zero() & (self.msg_sender() == pending),
            "Only the pending merchant admin",
        );
        let previous_admin = self.storage.merchant_admin.read();
        self.storage.merchant_admin.write(pending);
        self.storage.pending_merchant_admin.write(AztecAddress::zero());
        self.emit(MerchantAdminAccepted { previous_admin, admin: pending });
    }

    /// @notice Schedules the guardian, who can only cancel pending merchant changes; zero removes it
    /// @dev Applies after the guardian slot's delay, so a compromised admin cannot swap out a guardian at once
    /// @param guardian The next guardian
    #[external("public")]
    fn schedule_merchant_guardian(guardian: AztecAddress) {
        self.internal._assert_merchant_admin();
        self.storage.merchant_guardian.schedule_value_change(guardian);
        let (_, effective_at) = self.storage.merchant_guardian.get_scheduled_value();
        self.emit(MerchantGuardianScheduled { guardian, effective_at });
    }

    /// @notice Cancels an entry's pending change: re-schedules its current value, and its current delay if a decrease
    ///         is pending
    /// @dev Refused when nothing is pending, so a mistaken cancel fails rather than doing nothing
    /// @param account The merchant whose pending change to cancel
    #[external("public")]
    fn cancel_merchant_change(account: AztecAddress) {
        let caller = self.msg_sender();
        let guardian = self.storage.merchant_guardian.get_current_value();
        assert(
            (caller == self.storage.merchant_admin.read())
                | (!guardian.is_zero() & (caller == guardian)),
            "Only the merchant admin or guardian",
        );
        let entry = self.storage.merchant_off.at(account);
        let off = entry.get_current_value();
        let delay = entry.get_current_delay();
        // A pending delay change is always a decrease: increases apply at once.
        let delay_pending = entry.get_scheduled_delay().0 != delay;
        let value_pending = entry.get_scheduled_value().0 != off;
        assert(delay_pending | value_pending, "No pending change");
        if delay_pending {
            entry.schedule_delay_change(delay);
            let (_, effective_at) = entry.get_scheduled_delay();
            self.emit(MerchantDelayScheduled { account, delay, effective_at });
        }
        if value_pending {
            let (_, effective_at) = entry.schedule_and_get_value_change(off).get_scheduled();
            self.emit(MerchantOffScheduled { account, off, effective_at });
        }
    }

    /// @notice Whether `account` is a listed merchant that is switched on now
    /// @param account The account to check
    /// @return Whether it is a merchant
    #[external("public")]
    #[view]
    fn is_merchant(account: AztecAddress) -> bool {
        self.internal._is_merchant(account)
    }

    /// @notice Returns `account`'s merchant entry
    /// @param account The account to look up
    /// @return The entry; an account never listed reads unregistered and on, at the slot's 3600 s floor
    #[external("public")]
    #[view]
    fn get_merchant_status(account: AztecAddress) -> MerchantStatus {
        let entry = self.storage.merchant_off.at(account);
        let (scheduled_off, scheduled_off_at) = entry.get_scheduled_value();
        let (scheduled_delay, scheduled_delay_at) = entry.get_scheduled_delay();
        MerchantStatus {
            registered: self.storage.merchants.at(account).is_initialized(),
            off: entry.get_current_value(),
            scheduled_off,
            scheduled_off_at,
            delay: entry.get_current_delay(),
            scheduled_delay,
            scheduled_delay_at,
        }
    }

    /// @notice Returns who governs the merchant list, and its delays
    /// @return The roles
    #[external("public")]
    #[view]
    fn get_merchant_roles() -> MerchantRoles {
        let guardian = self.storage.merchant_guardian;
        let (scheduled_guardian, scheduled_guardian_at) = guardian.get_scheduled_value();
        MerchantRoles {
            admin: self.storage.merchant_admin.read(),
            pending_admin: self.storage.pending_merchant_admin.read(),
            guardian: guardian.get_current_value(),
            scheduled_guardian,
            scheduled_guardian_at,
            delay: self.storage.merchant_delay.read(),
            guardian_delay: guardian.get_current_delay(),
        }
    }

    /// @notice Proves `account` a merchant at the anchor block, if the prover's node says it is one
    /// @dev `true` is proven, and caps the tx's expiry like any merchant read. `false` is only the prover's claim:
    ///      callers may use it to refuse, never to grant.
    /// @param account The account to check
    /// @return Whether `account` was proven a merchant
    #[external("private")]
    #[view]
    fn try_prove_merchant(account: AztecAddress) -> bool {
        // Safety: only a `true` grants anything, and a `true` is proven below.
        let merchant =
            unsafe { is_merchant_at_anchor(merchant_list(self.context, self.storage), account) };
        if merchant {
            self.internal._assert_merchant(account);
        }
        merchant
    }

    /** ==========================================================
     * ================= TOKEN LIBRARIES =========================
     * ======================================================== */

    /// @notice ARC-403: calls the public authorization hook when one is configured
    /// @dev Invoked from external public functions; no-ops when auth_contract is zero.
    ///      Mints deliberately do not call this hook; see the ARC-403 section of the README.
    /// @param from The address tokens are moved from
    /// @param amount The amount of tokens being moved
    #[internal("public")]
    fn _call_auth_public(from: AztecAddress, amount: u128) {
        let auth = self.storage.auth_contract.read();
        if !auth.eq(AztecAddress::zero()) {
            let selector = self.context.selector().to_field();
            self.call(Arc403Authorizer::at(auth).authorize_public(from, amount, selector));
        }
    }

    /// @notice ARC-403: calls the private authorization hook when one is configured
    /// @dev Invoked from external private functions; no-ops when auth_contract is zero.
    ///      Runs in private context, but the authorization contract may still create public
    ///      side effects (e.g., via enqueued public calls or public events).
    /// @param from The address tokens are moved from
    /// @param amount The amount of tokens being moved
    #[internal("private")]
    fn _call_auth_private(from: AztecAddress, amount: u128) {
        let auth = self.storage.auth_contract.read();
        if !auth.eq(AztecAddress::zero()) {
            let selector = self.context.selector().to_field();
            self.call(Arc403Authorizer::at(auth).authorize_private(from, amount, selector));
        }
    }

    /// @notice Validates that the caller is the minter
    /// @param sender The address of the caller
    /// @param minter The address of the authorized minter
    #[contract_library_method]
    fn _validate_minter(sender: AztecAddress, minter: AztecAddress) {
        assert(minter.eq(sender), "caller is not minter");
    }

    /// @notice Delivery for a note proven by its owner's own call or by a holder of its nullifier key, so a wrong
    ///         delivery hides the note only from an owner that trusts its prover
    /// @dev The tag derives from the (tx sender, recipient) address pair, which no third party can compute, so no
    ///      handshake is announced; a PXE scans its own accounts as senders, so a wallet finds every such note a tx
    ///      from one of its accounts delivered
    #[contract_library_method]
    fn self_delivery() -> OnchainUnconstrainedDelivery {
        MessageDelivery::onchain_unconstrained().via_address_derived_secret()
    }

    /// @notice Decreases the private balance of `account` by `amount` and emits a private balance note with the change to account
    /// @param account The address of the account to decrease the balance of
    /// @param amount The amount of tokens to decrease the balance by
    /// @param max_notes The maximum number of notes to process in a single call
    #[internal("private")]
    fn _decrease_private_balance(account: AztecAddress, amount: u128, max_notes: u32) {
        // Subtracts `amount` from the private balance of `account`
        let change = self.internal._subtract_balance(account, amount, max_notes);
        // The prover just nullified `account`'s notes, which takes the owner's nullifier key.
        self.storage.private_balances.at(account).add(change).deliver(self_delivery());
    }

    /// @notice Increases the private balance of `to` by `amount`
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to increase the balance by
    /// @param self_send Whether `to`'s own call or its nullifier key proves this tx; otherwise delivery is constrained
    #[internal("private")]
    fn _increase_private_balance(to: AztecAddress, amount: u128, self_send: bool) {
        let note = self.storage.private_balances.at(to).add(amount);
        if self_send {
            note.deliver(self_delivery());
        } else {
            note.deliver(MessageDelivery::onchain_constrained());
        }
    }

    /// @notice Increases the public balance of `to` by `amount`
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to increase the balance by
    #[internal("public")]
    fn _increase_public_balance(to: AztecAddress, amount: u128) {
        // Read the current public balance of `to`, add `amount` to it,
        let new_balance = self.storage.public_balances.at(to).read() + amount;
        // write the result back to the storage
        self.storage.public_balances.at(to).write(new_balance);
    }

    /// @notice Decreases the public balance of `from` by `amount`
    /// @param from The address of the account to decrease the balance of
    /// @param amount The amount of tokens to decrease the balance by
    #[internal("public")]
    fn _decrease_public_balance(from: AztecAddress, amount: u128) {
        // read the current public balance of `from`, subtract `amount`
        let new_balance = self.storage.public_balances.at(from).read() - amount;
        // update the public balance of `from` with the new balance
        self.storage.public_balances.at(from).write(new_balance);
    }

    /// @notice Completes a partial note
    /// @dev Completes a partial note and increases the balance of the commitment by `amount`
    /// @param commitment The partial note representing the commitment (privacy entrance)
    /// @param completer The address used to compute the validity commitment
    /// @param amount The amount of tokens to increase the balance of the commitment by
    #[internal("public")]
    fn _increase_commitment_balance(
        commitment: PartialUintNote,
        completer: AztecAddress,
        amount: u128,
    ) {
        commitment.complete(
            self.context,
            completer,
            self.storage.private_balances.get_storage_slot(),
            amount,
        );
    }

    /// @notice Subtracts balance from private balance
    /// @dev Subtracts amount from private balance and returns the change to the owner, recursively if necessary
    /// @param account The address of the account to subtract the balance from
    /// @param amount The amount of tokens to subtract
    /// @param max_notes The maximum number of notes to process in a single call
    /// @return The change to return to the owner
    #[internal("private")]
    fn _subtract_balance(account: AztecAddress, amount: u128, max_notes: u32) -> u128 {
        let subtracted = self.storage.private_balances.at(account).try_sub(amount, max_notes);
        if subtracted >= amount {
            // We have achieved our goal of nullifying notes that add up to more than amount, so we return the change.
            subtracted - amount
        } else {
            // Failing to subtract any amount means that the owner was unable to produce more notes that could be nullified.
            assert(subtracted > 0, "Balance too low");

            // try_sub failed to nullify enough notes to reach the target amount, so we compute the amount remaining
            // and try again.
            let remaining = amount - subtracted;

            self.call_self.recurse_subtract_balance_internal(account, remaining)
        }
    }

    /// @notice Increases the total supply by `amount`
    /// @param amount The amount of tokens to increase the total supply by
    #[internal("public")]
    fn _increase_total_supply(amount: u128) {
        let new_supply = self.storage.total_supply.read() + amount;
        self.storage.total_supply.write(new_supply);
    }

    /// @notice Decreases the total supply by `amount`
    /// @param amount The amount to decrease the total supply by
    #[internal("public")]
    fn _decrease_total_supply(amount: u128) {
        let new_supply = self.storage.total_supply.read() - amount;
        self.storage.total_supply.write(new_supply);
    }

    /// @notice Initializes a transfer commitment to be used for transfers/mints
    /// @param to The address of the recipient
    /// @param completer The address used to compute the validity commitment
    /// @return The partial note that can be used to execute the transfer/mint
    #[internal("private")]
    fn _initialize_transfer_commitment(
        to: AztecAddress,
        completer: AztecAddress,
    ) -> PartialUintNote {
        let commitment = UintNote::partial(to, self.context, to, completer);

        commitment
    }

    /// @notice Mints tokens to a public balance and increases the total supply
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to mint
    #[internal("public")]
    fn _mint_to_public(to: AztecAddress, amount: u128) {
        self.internal._increase_public_balance(to, amount);
        self.internal._increase_total_supply(amount);

        self.emit(Transfer { from: AztecAddress::zero(), to, amount });
    }

    /// @notice Mints tokens to a private balance and enqueues a public call to increase the total supply
    /// @param to The address of the recipient
    /// @param amount The amount of tokens to mint
    #[internal("private")]
    fn _mint_to_private(to: AztecAddress, amount: u128) {
        // The only minter is the proxy, which only the bridge calls, and `claim_private` requires `msg_sender ==
        // recipient`: the recipient's own call proves the mint.
        self.storage.private_balances.at(to).add(amount).deliver(self_delivery());
        self.enqueue_self.increase_total_supply_internal(amount);
    }

    /// @notice Burns tokens from a public balance and decreases the total supply
    /// @param from The address to burn tokens from
    /// @param amount The amount of tokens to burn
    #[internal("public")]
    fn _burn_public(from: AztecAddress, amount: u128) {
        self.internal._decrease_public_balance(from, amount);
        self.internal._decrease_total_supply(amount);

        self.emit(Transfer { from, to: AztecAddress::zero(), amount });
    }

    /// @notice Burns tokens from a private balance and enqueues a public call to decrease the total supply
    /// @param from The address to burn tokens from
    /// @param amount The amount of tokens to burn
    #[internal("private")]
    fn _burn_private(from: AztecAddress, amount: u128) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.enqueue_self.decrease_total_supply_internal(amount);
    }

    /** ==========================================================
     * ================= MERCHANT LIBRARIES ======================
     * ======================================================== */

    /// @notice Makes the deployer the merchant admin with a 24 h delay setting, and raises the guardian slot's delay
    ///         to match
    /// @dev A DelayedPublicMutable schedules with its current delay, so without the raise a fresh deployment's
    ///      guardian could be replaced after 3600 s
    /// @param admin The first merchant admin
    #[internal("public")]
    fn _initialize_merchant_roles(admin: AztecAddress) {
        self.storage.merchant_admin.write(admin);
        self.storage.merchant_delay.write(MERCHANT_MAX_DELAY);
        self.storage.merchant_guardian.schedule_delay_change(MERCHANT_MAX_DELAY);
    }

    #[internal("public")]
    fn _assert_merchant_admin() {
        assert(self.msg_sender() == self.storage.merchant_admin.read(), "Only the merchant admin");
    }

    #[internal("public")]
    fn _is_merchant(account: AztecAddress) -> bool {
        self.storage.merchants.at(account).is_initialized()
            & !self.storage.merchant_off.at(account).get_current_value()
    }

    /// @notice Proves `account` a listed merchant, switched on, at the anchor block
    /// @dev Two historical reads. The switch-off read caps the tx's expiry: at anchor + delay - 1, or just before a
    ///      scheduled change to the entry.
    /// @param account The account to prove
    #[internal("private")]
    fn _assert_merchant(account: AztecAddress) {
        assert(self.storage.merchants.at(account).read(), "Not a registered merchant");
        assert(
            !self.storage.merchant_off.at(account).get_current_value(),
            "Merchant is switched off",
        );
    }

    /// @notice Proves `first` or `second` a merchant, whichever the side hint picks
    /// @param first The side probed first: the recipient, or the side the call publishes
    /// @param keep_first Whether a merchant `first` is always proven: the call publishes it, or opens a request for it
    /// @return The side proven; NEITHER proves nothing, so callers accept it only for a transfer into the sender's own
    ///         private balance
    #[internal("private")]
    fn _prove_merchant_side(first: AztecAddress, second: AztecAddress, keep_first: bool) -> u8 {
        // Safety: the hint only picks which side is proven below; a wrong pick is unprovable, never a pass. FIRST
        // proves the first, NEITHER nothing, any other value the second.
        let side = unsafe {
            merchant_side_hint(
                merchant_list(self.context, self.storage),
                first,
                second,
                keep_first,
            )
        };
        if side != NEITHER {
            self.internal._assert_merchant(if side == FIRST { first } else { second });
        }
        side
    }

    /// @notice Proves a payment into `commitment` allowed: the request holds a stamp (opened for a merchant) that
    ///         has not expired, or `from` is a merchant, whichever the side hint picks
    /// @dev The stamp must be settled at the anchor, like upstream's private completion reads its validity
    ///      commitment. Proving it caps the tx's expiry at the stamp's deadline.
    /// @param from The payer
    /// @param commitment The request paid into
    /// @return The side proven; NEITHER proves nothing, and the caller refuses
    #[internal("private")]
    fn _prove_payment_side(from: AztecAddress, commitment: Field) -> u8 {
        // Safety: the hint only picks which proof is made below, and of which bucket's stamp; a wrong pick is
        // unprovable, never a pass. Every side proves something or refuses: FIRST the stamp, NEITHER nothing (the
        // caller refuses), any other the payer. The one bucket feeds both the stamp proven and the deadline enforced.
        let (side, bucket) = unsafe {
            payment_side_hint(merchant_list(self.context, self.storage), commitment, from)
        };
        if side == FIRST {
            let stamp_nullifier = stamp(commitment, bucket);
            // Safety: fails early and readably where the kernel would reject the existence request (TXE runs no
            // kernel); aztec-nr's PublicImmutable read pre-checks the same way.
            let stamped = unsafe { check_nullifier_exists(stamp_nullifier) };
            assert(
                stamped,
                "Payment refused: users may only pay into requests opened for a merchant",
            );
            let deadline = stamp_deadline(bucket);
            assert(
                self.context.get_anchor_block_header().timestamp() <= deadline,
                "Payment refused: the request's stamp has expired",
            );
            self.context.assert_nullifier_exists(NullifierExistenceRequest::for_settled(
                compute_siloed_nullifier(self.context.this_address(), stamp_nullifier),
            ));
            // The anchor may be a day old: only the tx's own expiry keeps the payment from landing past the deadline.
            self.context.set_expiration_timestamp(deadline);
        } else if side != NEITHER {
            self.internal._assert_merchant(from);
        }
        side
    }

    /// @notice Records who a request was opened for: its stamp if the recipient was proven a merchant, else its pad
    /// @dev The stamp carries the hour of the anchor block, which the opener cannot choose later than the present, and
    ///      expires at `stamp_deadline` of that hour. Also hands the commitment to the opener's client as an offchain
    ///      effect.
    /// @param commitment The request just opened
    /// @param side The side `_prove_merchant_side` proved, recipient first
    #[internal("private")]
    fn _push_request_stamp(commitment: Field, side: u8) {
        let nullifier = if side == FIRST {
            stamp(commitment, stamp_bucket(self.context.get_anchor_block_header().timestamp()))
        } else {
            pad(commitment)
        };
        self.context.push_nullifier_unsafe(nullifier);
        // Safety: an offchain effect only reaches the prover's own client and is neither constrained nor published.
        unsafe { emit_offchain_effect([REQUEST_OPENED_EFFECT, commitment]) };
    }

    /// @notice Marks `commitment` paid: a request takes one payment, whichever path it comes by
    #[internal("private")]
    fn _push_paid(commitment: Field) {
        let paid_nullifier = paid(commitment);
        // Safety: advice for a readable refusal only; uniqueness is the kernel's to enforce.
        let already = unsafe { check_nullifier_exists(paid_nullifier) };
        assert(!already, "Payment refused: the request is already paid");
        self.context.push_nullifier_unsafe(paid_nullifier);
    }

    /// @notice Whether `commitment` holds a stamp still payable at this block's timestamp
    /// @dev Public, so it reads the chain's tip: a request stamped earlier in this same tx counts. Every bucket
    ///      searched is live by construction, newest first.
    #[internal("public")]
    fn _has_live_stamp(commitment: Field) -> bool {
        let newest = stamp_bucket(self.context.timestamp());
        let mut found = false;
        for i in 0..STAMP_LIVE_BUCKETS {
            if !found & (i <= newest) {
                found = self.context.nullifier_exists_unsafe(
                    stamp(commitment, newest - i),
                    self.context.this_address(),
                );
            }
        }
        found
    }

    // A library method, not #[internal]: the header is not a valid entry-point type, which internal returns must be.
    #[contract_library_method]
    fn merchant_list(
        context: &mut PrivateContext,
        storage: Storage<&mut PrivateContext>,
    ) -> MerchantList {
        MerchantList {
            this: context.this_address(),
            anchor: context.get_anchor_block_header(),
            merchants_slot: storage.merchants.get_storage_slot(),
            merchant_off_slot: storage.merchant_off.get_storage_slot(),
        }
    }
}
