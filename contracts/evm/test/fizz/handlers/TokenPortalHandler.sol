// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";
import {IERC20Errors} from "@oz/interfaces/draft-IERC6093.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

/// @notice Handles the interaction with TokenPortal
abstract contract TokenPortalHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function tokenPortal_depositToAztecPrivate_clamped(uint256 _amount, bytes32 _secretHash) public {
        _amount = clampBetween(_amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, _amount);
        tokenPortal_depositToAztecPrivate(_amount, _toField(_secretHash));
    }

    function tokenPortal_depositToAztecPublic_clamped(
        uint256 _accountSeed,
        uint256 _amount,
        bytes32 _secretHash,
        address _refundSeed
    ) public {
        _amount = clampBetween(_amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, _amount);
        _depositToAztecPublic(toActor(_refundSeed), toL2Account(_accountSeed), _amount, _toField(_secretHash));
    }

    /// Pays the proven, unpaid exit at `_exitSeed` exactly as its L2 message committed it. The portal call is wrapped
    /// inline (not through `tokenPortal_withdraw`) so a revert leaves no prank behind; a revert in a healthy
    /// environment is a stuck payable exit.
    function tokenPortal_withdraw_clamped(uint256 _exitSeed) public {
        uint256 n = provenUnpaidExits.length;
        if (n == 0) return;
        ExitMsg storage e = exitMsgs[provenUnpaidExits[_exitSeed % n]];
        if (e.caller != address(0)) actor = e.caller;
        address recipient = e.recipient;
        uint256 amount = e.amount;
        bool withCaller = e.caller != address(0);
        uint256 epoch = e.epoch;
        uint256 numCheckpoints = e.numCheckpoints;
        uint256 leafIndex = e.leafIndex;
        bytes32[] memory path = _exitPath(e);
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try portal.withdraw(recipient, amount, withCaller, Epoch.wrap(epoch), numCheckpoints, leafIndex, path) {
            _recordWithdraw(recipient, amount, withCaller, epoch, numCheckpoints, leafIndex);
            snapshotAfter();
            property_withdrawPost(recipient, amount, epoch, path.length, leafIndex);
            property_thirdPartySubmitNoSkim(recipient, amount);
            property_depositWithdrawIsolation(false);
            _universalChecks(false, true);
        } catch {
            if (_withdrawHealthy(recipient, actor)) ghosts.payableExitStuck++;
            _noopEnd(consumed);
            _universalChecks(false, false);
        }
    }

    // Boundary stress: the largest fundable amount (the u128 ceiling while the mock supply allows), one past the
    // ceiling, zero, and the field ceiling for `_to`.

    function tokenPortal_depositToAztecPublic_maxAmount(uint256 _accountSeed, bytes32 _secretHash) public {
        uint256 amount = _largestFundable(actor);
        if (amount == 0) return;
        tokenPortal_depositToAztecPublic(toL2Account(_accountSeed), amount, _toField(_secretHash));
    }

    function tokenPortal_depositToAztecPrivate_maxAmount(bytes32 _secretHash) public {
        uint256 amount = _largestFundable(actor);
        if (amount == 0) return;
        tokenPortal_depositToAztecPrivate(amount, _toField(_secretHash));
    }

    function tokenPortal_deposit_zeroAmount(uint256 _accountSeed, bool _isPrivate) public {
        bytes32 to = toL2Account(_accountSeed);
        (uint256 deadline, bytes memory signature) = _authorize(actor, actor, 0, bytes32(0));
        uint256 consumed = _noopBegin();
        vm.startPrank(actor);
        if (_isPrivate) {
            try portal.depositToAztecPrivate(actor, 0, bytes32(0), deadline, signature) {
                ghosts.boundaryAccepted++;
            } catch (bytes memory reason) {
                _requireRefusal(reason, TokenPortal.ZeroAmount.selector);
            }
        } else {
            try portal.depositToAztecPublic(actor, to, 0, bytes32(0)) {
                ghosts.boundaryAccepted++;
            } catch (bytes memory reason) {
                _requireRefusal(reason, TokenPortal.ZeroAmount.selector);
            }
        }
        vm.stopPrank();
        _noopEnd(consumed);
        property_zeroAmountSafe();
    }

    /// Unfunded, so only the cap's own selector counts as a refusal: without the cap the pull would revert instead.
    function tokenPortal_deposit_overU128(bool _isPrivate) public {
        uint256 amount = uint256(type(uint128).max) + 1;
        (uint256 deadline, bytes memory signature) = _authorize(actor, actor, amount, bytes32(0));
        uint256 consumed = _noopBegin();
        vm.startPrank(actor);
        if (_isPrivate) {
            try portal.depositToAztecPrivate(actor, amount, bytes32(0), deadline, signature) {
                ghosts.boundaryAccepted++;
            } catch (bytes memory reason) {
                _requireRefusal(reason, TokenPortal.AmountExceedsL2Max.selector);
            }
        } else {
            try portal.depositToAztecPublic(actor, L2_ACCOUNTS[0], amount, bytes32(0)) {
                ghosts.boundaryAccepted++;
            } catch (bytes memory reason) {
                _requireRefusal(reason, TokenPortal.AmountExceedsL2Max.selector);
            }
        }
        vm.stopPrank();
        _noopEnd(consumed);
    }

    /// `_to` at the largest field element is accepted; one past it must be refused.
    function tokenPortal_depositToAztecPublic_fieldBoundary(uint256 _amount, bool _overField) public {
        _amount = clampBetween(_amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, _amount);
        if (!_overField) {
            tokenPortal_depositToAztecPublic(bytes32(Constants.MAX_FIELD_VALUE), _amount, bytes32(0));
            return;
        }
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try portal.depositToAztecPublic(actor, bytes32(Constants.MAX_FIELD_VALUE + 1), _amount, bytes32(0)) {
            ghosts.boundaryAccepted++;
        } catch (bytes memory reason) {
            _requireRefusal(reason, TokenPortal.RecipientExceedsFieldMax.selector);
        }
        _noopEnd(consumed);
    }

    /// A periphery's private deposit: the current actor submits and pays, another actor's key signed it, and the
    /// message names the signer.
    function tokenPortal_depositToAztecPrivate_forSigner(uint256 _amount, bytes32 _secretHash, uint256 _signerSeed)
        public
    {
        _amount = clampBetween(_amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, _amount);
        address signer = toActor(address(uint160(_signerSeed)));
        bytes32 secretHash = _toField(_secretHash);
        (uint256 deadline, bytes memory signature) = _authorize(signer, actor, _amount, secretHash);
        snapshotBefore();
        vm.prank(actor);
        (, uint256 index) = portal.depositToAztecPrivate(signer, _amount, secretHash, deadline, signature);
        lastAuthorization = Authorization(signer, actor, _amount, secretHash, deadline, signature);
        _afterDirectDeposit(signer, bytes32(0), _amount, true);
        snapshotAfter();
        _directDepositProperties(_amount, secretHash, index);
    }

    /// The last authorization that deposited, presented again by its submitter (spent) or by another actor (bound to
    /// its submitter): either way refused with that rule's own selector, before anything moves.
    function tokenPortal_authorizationMisuse(bool _foreignSubmitter, uint256 _seed) public {
        Authorization memory a = lastAuthorization;
        if (a.depositor == address(0)) return;
        address submitter = _foreignSubmitter ? _otherActor(a.submitter, _seed) : a.submitter;
        bytes4 refusal =
            _foreignSubmitter ? TokenPortal.SignerIsNotTheDepositor.selector : TokenPortal.AuthorizationUsed.selector;
        // Expiry is checked first, and a long campaign can outrun even a year-long deadline.
        if (block.timestamp > a.deadline) refusal = TokenPortal.AuthorizationExpired.selector;
        _ensureFunds(submitter, a.amount);
        uint256 consumed = _noopBegin();
        vm.prank(submitter);
        try portal.depositToAztecPrivate(a.depositor, a.amount, a.secretHash, a.deadline, a.signature) {
            ghosts.authorizationMisused++;
        } catch (bytes memory reason) {
            if (bytes4(reason) != refusal) ghosts.authorizationMisused++;
        }
        _noopEnd(consumed);
    }

    /// The current actor submits a private deposit carrying another actor's signature, to the portal (naming itself)
    /// or to the router: refused with the signer rule's own selector, which Permit2 (`InvalidSigner`) would not raise.
    function tokenPortal_foreignSignature(bool _viaRouter, uint256 _amount, uint256 _signerSeed) public {
        _amount = clampBetween(_amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, _amount);
        address signer = _otherActor(actor, _signerSeed);
        uint256 consumed = _noopBegin();
        bytes4 refusal;
        bool ok;
        bytes memory reason;
        if (_viaRouter) {
            refusal = Permit2DepositRouter.SignerIsNotTheCaller.selector;
            uint256 deadline = block.timestamp + 1;
            bytes memory signature = _permitSignature(signer, _amount, bytes32(0), bytes32(0), true, 0, deadline);
            vm.prank(actor);
            (ok, reason) = address(router)
                .call(abi.encodeCall(router.deposit, (_amount, bytes32(0), bytes32(0), true, 0, deadline, signature)));
        } else {
            refusal = TokenPortal.SignerIsNotTheDepositor.selector;
            (uint256 deadline, bytes memory signature) = _authorize(signer, actor, _amount, bytes32(0));
            vm.prank(actor);
            (ok, reason) = address(portal)
                .call(abi.encodeCall(portal.depositToAztecPrivate, (actor, _amount, bytes32(0), deadline, signature)));
        }
        if (ok || bytes4(reason) != refusal) ghosts.foreignSignatureAccepted++;
        _noopEnd(consumed);
    }

    /// A private deposit that reverts at the pull, after the portal marked its authorization used (the actor withdrew
    /// its approval), must leave the authorization unspent; with the approval back the same signature deposits once.
    function tokenPortal_authorizationRollback(uint256 _amount, bytes32 _secretHash) public {
        if (!_depositEnvClean()) return;
        _amount = clampBetween(_amount, 1, MAX_REALISTIC_AMOUNT);
        if (!_ensureFunds(actor, _amount)) return;
        bytes32 secretHash = _toField(_secretHash);
        (uint256 deadline, bytes memory signature) = _authorize(actor, actor, _amount, secretHash);
        bytes32 digest = portal.fundingAuthorizationDigest(actor, actor, _amount, secretHash, deadline);
        vm.prank(actor);
        usdc.approve(address(portal), 0);
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try portal.depositToAztecPrivate(actor, _amount, secretHash, deadline, signature) {
            ghosts.authorizationRollbackBroken++;
        } catch (bytes memory reason) {
            if (bytes4(reason) != IERC20Errors.ERC20InsufficientAllowance.selector) {
                ghosts.authorizationRollbackBroken++;
            }
        }
        _noopEnd(consumed);
        vm.prank(actor);
        usdc.approve(address(portal), type(uint256).max);
        if (portal.authorizationUsed(digest)) ghosts.authorizationRollbackBroken++;
        snapshotBefore();
        vm.prank(actor);
        try portal.depositToAztecPrivate(actor, _amount, secretHash, deadline, signature) returns (
            bytes32, uint256 index
        ) {
            lastAuthorization = Authorization(actor, actor, _amount, secretHash, deadline, signature);
            _afterDirectDeposit(actor, bytes32(0), _amount, true);
            snapshotAfter();
            _directDepositProperties(_amount, secretHash, index);
        } catch {
            ghosts.authorizationRollbackBroken++;
        }
    }

    /// A public deposit naming zero, the portal, the router, USDC, the Inbox, the Outbox or the registry as its refund
    /// address: no return could ever leave them.
    function tokenPortal_depositToAztecPublic_badRefund(uint8 _which, uint256 _amount, uint256 _accountSeed) public {
        _amount = clampBetween(_amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, _amount);
        address[7] memory sinks = [
            address(0),
            address(portal),
            address(router),
            address(usdc),
            address(portal.inbox()),
            address(portal.outbox()),
            address(portal.registry())
        ];
        address refund = sinks[_which % 7];
        bytes32 to = toL2Account(_accountSeed);
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try portal.depositToAztecPublic(refund, to, _amount, bytes32(0)) {
            ghosts.boundaryAccepted++;
        } catch (bytes memory reason) {
            _requireRefusal(reason, TokenPortal.InvalidDepositor.selector);
        }
        _noopEnd(consumed);
    }

    /// A paid exit presented again, with the identical proof and caller.
    function tokenPortal_withdraw_replay(uint256 _exitSeed) public {
        uint256 n = paidExits.length;
        if (n == 0) return;
        ExitMsg storage e = exitMsgs[paidExits[_exitSeed % n]];
        address sender = e.caller != address(0) ? e.caller : actor;
        bytes32[] memory path = _exitPath(e);
        uint256 consumed = _noopBegin();
        vm.prank(sender);
        try portal.withdraw(
            e.recipient, e.amount, e.caller != address(0), Epoch.wrap(e.epoch), e.numCheckpoints, e.leafIndex, path
        ) {
            ghosts.replayedPayouts++;
        } catch {}
        _noopEnd(consumed);
    }

    /// A proven, unpaid exit with exactly one field altered: amount, recipient, caller binding or leaf position.
    function tokenPortal_withdraw_tampered(uint256 _exitSeed, uint8 _field, uint256 _delta) public {
        uint256 n = provenUnpaidExits.length;
        if (n == 0) return;
        ExitMsg storage e = exitMsgs[provenUnpaidExits[_exitSeed % n]];
        address sender = e.caller != address(0) ? e.caller : actor;
        address recipient = e.recipient;
        uint256 amount = e.amount;
        bool withCaller = e.caller != address(0);
        uint256 leafIndex = e.leafIndex;
        _field = uint8(_field % 4);
        if (_field == 0) amount += 1 + (_delta % 1e6);
        else if (_field == 1) recipient = _otherActor(e.recipient, _delta);
        else if (_field == 2) withCaller = !withCaller;
        else leafIndex = e.leafIndex ^ 1;
        // Identical exits are distinct leaves: a moved position can name a sibling's genuine, payable message.
        if (_isProvenUnpaid(recipient, amount, withCaller ? sender : address(0), e.epoch, e.numCheckpoints, leafIndex))
        {
            return;
        }
        bytes32[] memory path = _exitPath(e);
        uint256 consumed = _noopBegin();
        vm.prank(sender);
        try portal.withdraw(recipient, amount, withCaller, Epoch.wrap(e.epoch), e.numCheckpoints, leafIndex, path) {
            ghosts.tamperedPayouts++;
        } catch {}
        _noopEnd(consumed);
    }

    function _isProvenUnpaid(
        address recipient,
        uint256 amount,
        address caller,
        uint256 epoch,
        uint256 numCheckpoints,
        uint256 leafIndex
    ) internal view returns (bool) {
        for (uint256 pos; pos < provenUnpaidExits.length; pos++) {
            ExitMsg storage x = exitMsgs[provenUnpaidExits[pos]];
            if (
                x.recipient == recipient && x.amount == amount && x.caller == caller && x.epoch == epoch
                    && x.numCheckpoints == numCheckpoints && x.leafIndex == leafIndex
            ) return true;
        }
        return false;
    }

    /// A caller-bound exit delivered by any other actor, with and without claiming the binding.
    function tokenPortal_withdraw_wrongCaller(uint256 _exitSeed, uint256 _senderSeed) public {
        uint256 n = provenUnpaidExits.length;
        for (uint256 i; i < n; i++) {
            ExitMsg storage e = exitMsgs[provenUnpaidExits[(_exitSeed + i) % n]];
            if (e.caller == address(0)) continue;
            address sender = _otherActor(e.caller, _senderSeed);
            bytes32[] memory path = _exitPath(e);
            uint256 consumed = _noopBegin();
            vm.prank(sender);
            try portal.withdraw(e.recipient, e.amount, true, Epoch.wrap(e.epoch), e.numCheckpoints, e.leafIndex, path) {
                ghosts.wrongCallerPayouts++;
            } catch {}
            vm.prank(sender);
            try portal.withdraw(
                e.recipient, e.amount, false, Epoch.wrap(e.epoch), e.numCheckpoints, e.leafIndex, path
            ) {
                ghosts.wrongCallerPayouts++;
            } catch {}
            _noopEnd(consumed);
            return;
        }
    }

    function tokenPortal_secondary(uint8 selector, uint256 arg0, bytes32 arg1, address arg2) public {
        selector = uint8(selector % 5);
        if (selector == 0) _tokenPortal_depositToAztecPrivateFor(toActor(arg2), arg0, arg1);
        else if (selector == 1) _tokenPortal_depositToAztecPublicFor(toActor(arg2), toL2Account(arg0), arg0, arg1);
        else if (selector == 2) _tokenPortal_initialize(address(registry), address(usdc), arg1, address(router));
        else if (selector == 3) _tokenPortal_initializeAsInitializer(arg1);
        else _tokenPortal_freshBinding(arg2);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function tokenPortal_depositToAztecPrivate(uint256 _amount, bytes32 _secretHashForL2MessageConsumption)
        public
        asActor
    {
        (uint256 deadline, bytes memory signature) =
            _authorize(actor, actor, _amount, _secretHashForL2MessageConsumption);
        snapshotBefore();
        (, uint256 index) =
            portal.depositToAztecPrivate(actor, _amount, _secretHashForL2MessageConsumption, deadline, signature);
        lastAuthorization =
            Authorization(actor, actor, _amount, _secretHashForL2MessageConsumption, deadline, signature);
        _afterDirectDeposit(actor, bytes32(0), _amount, true);
        snapshotAfter();
        _directDepositProperties(_amount, _secretHashForL2MessageConsumption, index);
    }

    function tokenPortal_depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash) public {
        _depositToAztecPublic(actor, _to, _amount, _secretHash);
    }

    function tokenPortal_withdraw(
        address _recipient,
        uint256 _amount,
        bool _withCaller,
        uint256 _epoch,
        uint256 _numCheckpointsInEpoch,
        uint256 _leafIndex,
        bytes32[] memory _path
    ) public asActor {
        snapshotBefore();
        portal.withdraw(_recipient, _amount, _withCaller, Epoch.wrap(_epoch), _numCheckpointsInEpoch, _leafIndex, _path);
        _recordWithdraw(_recipient, _amount, _withCaller, _epoch, _numCheckpointsInEpoch, _leafIndex);
        snapshotAfter();
        property_withdrawPost(_recipient, _amount, _epoch, _path.length, _leafIndex);
        property_thirdPartySubmitNoSkim(_recipient, _amount);
        property_depositWithdrawIsolation(false);
        _universalChecks(false, true);
    }

    // ――――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    /// `refund` must be an actor: a return pays it, and USDC outside the actors escapes the supply GL-13 accounts for.
    function _depositToAztecPublic(address refund, bytes32 to, uint256 amount, bytes32 secretHash) internal asActor {
        snapshotBefore();
        (, uint256 index) = portal.depositToAztecPublic(refund, to, amount, secretHash);
        _afterDirectDeposit(refund, to, amount, false);
        snapshotAfter();
        _directDepositProperties(amount, secretHash, index);
    }

    /// Model update after a successful direct deposit by `depositor`.
    function _afterDirectDeposit(address depositor, bytes32 to, uint256 amount, bool isPrivate) internal {
        if (!_canonical()) ghosts.staleDepositAccepted++;
        _recordDeposit(depositor, to, amount, isPrivate);
        ghosts.directDeposited += amount;
        _flagInexactDeposit(amount);
    }

    /// Model update after a successful withdraw; a payout matching no proven, unpaid exit is a violation.
    function _recordWithdraw(
        address recipient,
        uint256 amount,
        bool withCaller,
        uint256 epoch,
        uint256 numCheckpoints,
        uint256 leafIndex
    ) internal {
        ghosts.withdrawn += amount;
        ghosts.withdrawCount++;
        _flagInexactWithdraw(amount);
        address caller = withCaller ? actor : address(0);
        if (!_settleWithdraw(recipient, amount, caller, epoch, numCheckpoints, leafIndex)) {
            ghosts.unbackedPayouts++;
        }
    }

    function _directDepositProperties(uint256 amount, bytes32 secretHash, uint256 index) internal {
        property_directDepositPost(amount);
        property_secretHashPassthrough(secretHash);
        property_inboxIndexAdvances(index);
        property_depositWithdrawIsolation(true);
        _universalChecks(true, false);
    }

    /// A payable exit has nothing in its way: no sender surcharge (a recipient-side fee still debits the portal exactly
    /// `amount`), nothing armed, no blacklisted party.
    function _withdrawHealthy(address recipient, address sender) internal view returns (bool) {
        return usdc.mode() != ModalUsdc.Mode.SenderSurcharge && usdc.hookPayload().length == 0
            && !usdc.blacklisted(recipient) && !usdc.blacklisted(address(portal)) && !usdc.blacklisted(sender);
    }

    /// Anyone but the router naming a depositor must be refused before anything moves.
    function _tokenPortal_depositToAztecPrivateFor(address _depositor, uint256 _amount, bytes32 _secretHash) internal {
        _amount = clampBetween(_amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, _amount);
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try portal.depositToAztecPrivateFor(_depositor, _amount, _secretHash) {
            ghosts.strangerNamedDepositor++;
        } catch {}
        _noopEnd(consumed);
    }

    function _tokenPortal_depositToAztecPublicFor(address _depositor, bytes32 _to, uint256 _amount, bytes32 _secretHash)
        internal
    {
        _amount = clampBetween(_amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, _amount);
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try portal.depositToAztecPublicFor(_depositor, _to, _amount, _secretHash) {
            ghosts.strangerNamedDepositor++;
        } catch {}
        _noopEnd(consumed);
    }

    /// A stranger re-initializing the live portal.
    function _tokenPortal_initialize(address _registry, address _underlying, bytes32 _l2Bridge, address _router)
        internal
    {
        uint256 consumed = _noopBegin();
        vm.prank(actor);
        try portal.initialize(_registry, _underlying, _l2Bridge, _router, FAKE_ROLLUP_VERSION) {
            ghosts.reinitialized++;
        } catch {}
        _noopEnd(consumed);
    }

    /// The initializer itself (this contract) calling `initialize` a second time.
    function _tokenPortal_initializeAsInitializer(bytes32 _l2Bridge) internal {
        uint256 consumed = _noopBegin();
        try portal.initialize(address(registry), address(usdc), _l2Bridge, address(router), FAKE_ROLLUP_VERSION) {
            ghosts.reinitialized++;
        } catch {}
        _noopEnd(consumed);
    }

    /// A fresh portal must refuse a stranger's initialize and a router bound to another portal; a fresh router must
    /// refuse a code-less dependency. A router bound to the fresh portal and its token is the one that must work, once.
    function _tokenPortal_freshBinding(address _stranger) internal {
        TokenPortal fresh = new TokenPortal();
        address stranger = toActor(_stranger);
        vm.prank(stranger);
        try fresh.initialize(address(registry), address(usdc), L2_BRIDGE, address(router), FAKE_ROLLUP_VERSION) {
            ghosts.misboundRouter++;
        } catch {}
        try fresh.initialize(address(registry), address(usdc), L2_BRIDGE, address(router), FAKE_ROLLUP_VERSION) {
            ghosts.misboundRouter++;
        } catch {}
        try new Permit2DepositRouter(ISignatureTransfer(address(0xC0DE1E55)), ITokenPortal(address(fresh)), usdc) {
            ghosts.misboundRouter++;
        } catch {}

        ISignatureTransfer p2 = ISignatureTransfer(address(permit2));
        address validRouter = address(new Permit2DepositRouter(p2, ITokenPortal(address(fresh)), usdc));
        address foreignTokenRouter =
            address(new Permit2DepositRouter(p2, ITokenPortal(address(fresh)), IERC20(address(inbox))));
        property_strangerInitKeepsSlot(fresh, validRouter, foreignTokenRouter, stranger);
        // initialize reads the canonical rollup's wiring, which a switched-away registry does not point at
        if (_canonical()) property_freshPortalInitOnce(fresh, validRouter, stranger);
    }
}
