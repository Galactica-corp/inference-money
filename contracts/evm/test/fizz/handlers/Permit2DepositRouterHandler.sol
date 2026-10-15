// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with Permit2DepositRouter through the real Permit2. Every leg signs the spec digest
/// with its actor's key and a nonce that actor has not spent; the router itself also requires a private deposit's
/// signature to recover to its caller.
abstract contract Permit2DepositRouterHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// A well-formed intent: amount in (0, 1M USDC], recipient zero iff private, a field-sized secret hash, and the
    /// fuzzed nonce unless the actor already spent it.
    function permit2DepositRouter_deposit_clamped(
        uint256 amount,
        uint256 accountSeed,
        bytes32 secretHash,
        bool isPrivate,
        uint256 nonce
    ) public {
        amount = clampBetween(amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, amount);
        bytes32 recipient = isPrivate ? bytes32(0) : toL2Account(accountSeed);
        bytes32 secret = _toField(secretHash);
        if (_nonceUsed(actor, nonce)) nonce = _freshNonce(actor);
        uint256 deadline = block.timestamp + 1;
        bytes memory signature = _permitSignature(actor, amount, recipient, secret, isPrivate, nonce, deadline);
        permit2DepositRouter_deposit(amount, recipient, secret, isPrivate, nonce, deadline, signature);
    }

    /// Boundary stress: the largest fundable amount, the L2 side's u128 ceiling while the mock supply allows.
    function permit2DepositRouter_deposit_maxAmount(uint256 accountSeed, bool isPrivate) public {
        uint256 amount = _largestFundable(actor);
        if (amount == 0) return;
        bytes32 recipient = isPrivate ? bytes32(0) : toL2Account(accountSeed);
        uint256 nonce = _freshNonce(actor);
        uint256 deadline = block.timestamp + 1;
        bytes memory signature = _permitSignature(actor, amount, recipient, bytes32(0), isPrivate, nonce, deadline);
        permit2DepositRouter_deposit(amount, recipient, bytes32(0), isPrivate, nonce, deadline, signature);
    }

    /// Malformed intents (zero, over u128, a private deposit naming a recipient, a public one naming none, a public
    /// one naming a recipient above the field maximum) must never move funds or message anything.
    function permit2DepositRouter_deposit_malformed(uint8 kind, uint256 amount, bytes32 recipient) public {
        kind = uint8(kind % 5);
        if (kind == 4) {
            _permit2DepositRouter_overField(amount, recipient);
            return;
        }
        bool isPrivate;
        bytes4 refusal;
        if (kind == 0) {
            amount = 0;
            recipient = L2_ACCOUNTS[0];
            refusal = Permit2DepositRouter.ZeroAmount.selector;
        } else if (kind == 1) {
            amount = uint256(type(uint128).max) + 1 + (amount % 1e18);
            recipient = L2_ACCOUNTS[0];
            refusal = Permit2DepositRouter.AmountExceedsL2Max.selector;
        } else if (kind == 2) {
            amount = clampBetween(amount, 1, MAX_REALISTIC_AMOUNT);
            isPrivate = true;
            if (recipient == bytes32(0)) recipient = L2_ACCOUNTS[1];
            refusal = Permit2DepositRouter.PrivateDepositNamesRecipient.selector;
        } else {
            amount = clampBetween(amount, 1, MAX_REALISTIC_AMOUNT);
            recipient = bytes32(0);
            refusal = Permit2DepositRouter.PublicDepositNeedsRecipient.selector;
        }
        // Over u128 stays unfunded (funding it would only drain the capped mock supply), so a missing cap would revert
        // on the pull; the exact selector is what proves the rule refused.
        if (kind != 1) _ensureFunds(actor, amount);
        uint256 portalBefore = usdc.balanceOf(address(portal));
        uint256 sentBefore = inbox.sent();
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try router.deposit(amount, recipient, bytes32(0), isPrivate, 0, block.timestamp + 1, "") {
            ghosts.boundaryAccepted++;
        } catch (bytes memory reason) {
            _requireRefusal(reason, refusal);
        }
        if (usdc.balanceOf(address(portal)) != portalBefore || inbox.sent() != sentBefore) ghosts.boundaryAccepted++;
        _noopEnd(consumed);
        if (kind == 0) property_zeroAmountSafe();
    }

    function permit2DepositRouter_secondary(uint256 amount, bool isPrivate, bool foreignKey, uint256 signerSeed)
        public
    {
        _permit2DepositRouter_rejectedPermit(amount, isPrivate, foreignKey, signerSeed);
    }

    /// SP-23 over arbitrary inputs, out-of-range ones included.
    function permit2DepositRouter_digest(
        uint256 amount,
        bytes32 recipient,
        bytes32 secretHash,
        bool isPrivate,
        uint256 nonce,
        uint256 deadline
    ) public {
        property_permitDigestMatchesSpec(amount, recipient, secretHash, isPrivate, nonce, deadline);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function permit2DepositRouter_deposit(
        uint256 amount,
        bytes32 aztecRecipient,
        bytes32 secretHash,
        bool isPrivate,
        uint256 nonce,
        uint256 deadline,
        bytes memory signature
    ) public asActor {
        bool nonceWasFree = !_nonceUsed(actor, nonce);
        snapshotBefore();
        (, uint256 index) = router.deposit(amount, aztecRecipient, secretHash, isPrivate, nonce, deadline, signature);
        _afterRouterDeposit(actor, aztecRecipient, amount, isPrivate, nonce);
        snapshotAfter();
        property_routerDepositPost(amount);
        property_routerPermit2Binding(nonceWasFree, nonce);
        property_permitDigestMatchesSpec(amount, aztecRecipient, secretHash, isPrivate, nonce, deadline);
        property_secretHashPassthrough(secretHash);
        property_inboxIndexAdvances(index);
        property_depositWithdrawIsolation(true);
        _universalChecks(true, false);
    }

    /// Model update after a successful router deposit by signer `depositor`.
    function _afterRouterDeposit(
        address depositor,
        bytes32 aztecRecipient,
        uint256 amount,
        bool isPrivate,
        uint256 nonce
    ) internal {
        if (!_canonical()) ghosts.staleDepositAccepted++;
        _recordDeposit(depositor, aztecRecipient, amount, isPrivate);
        ghosts.routerDeposited += amount;
        lastRouterNonce[depositor] = nonce;
        _flagInexactDeposit(amount);
    }

    /// Permit2 refusing the pull aborts the whole deposit with Permit2's own error: a replay of the actor's last spent
    /// nonce (`InvalidNonce`), or a public deposit signed by another actor's key (`InvalidSigner`; the router refuses
    /// a private one before Permit2, GL-34). The refused fresh nonce must stay unspent.
    function _permit2DepositRouter_rejectedPermit(uint256 amount, bool isPrivate, bool foreignKey, uint256 signerSeed)
        internal
    {
        amount = clampBetween(amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, amount);
        address signer = foreignKey ? _otherActor(actor, signerSeed) : actor;
        uint256 nonce = foreignKey ? _freshNonce(actor) : lastRouterNonce[actor];
        if (!foreignKey && !_nonceUsed(actor, nonce)) return;
        if (foreignKey) isPrivate = false;
        bytes4 refusal = foreignKey ? IPermit2Errors.InvalidSigner.selector : IPermit2Errors.InvalidNonce.selector;
        bytes32 recipient = isPrivate ? bytes32(0) : L2_ACCOUNTS[0];
        uint256 deadline = block.timestamp + 1;
        bytes memory signature = _permitSignature(signer, amount, recipient, bytes32(0), isPrivate, nonce, deadline);
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try router.deposit(amount, recipient, bytes32(0), isPrivate, nonce, deadline, signature) {
            ghosts.permit2RejectBypassed++;
        } catch (bytes memory reason) {
            if (bytes4(reason) != refusal) ghosts.permit2RejectBypassed++;
        }
        _noopEnd(consumed);
        if (foreignKey && _nonceUsed(actor, nonce)) ghosts.authorizationRollbackBroken++;
    }

    /// A signed public deposit to a recipient above the field maximum passes the router and Permit2, so only the
    /// portal's own rule refuses it, and the revert must hand the signer's nonce back.
    function _permit2DepositRouter_overField(uint256 amount, bytes32 seed) internal {
        if (!_depositEnvClean()) return;
        amount = clampBetween(amount, 1, MAX_REALISTIC_AMOUNT);
        // The pull precedes the portal's rule, so an unfunded actor would be refused by the token instead.
        if (!_ensureFunds(actor, amount)) return;
        bytes32 recipient = bytes32(Constants.MAX_FIELD_VALUE + 1 + (uint256(seed) % 1e9));
        uint256 nonce = _freshNonce(actor);
        uint256 deadline = block.timestamp + 1;
        bytes memory signature = _permitSignature(actor, amount, recipient, bytes32(0), false, nonce, deadline);
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try router.deposit(amount, recipient, bytes32(0), false, nonce, deadline, signature) {
            ghosts.boundaryAccepted++;
        } catch (bytes memory reason) {
            _requireRefusal(reason, TokenPortal.RecipientExceedsFieldMax.selector);
        }
        _noopEnd(consumed);
        if (_nonceUsed(actor, nonce)) ghosts.authorizationRollbackBroken++;
    }
}
