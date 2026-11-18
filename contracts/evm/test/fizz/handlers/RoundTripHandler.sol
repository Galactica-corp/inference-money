// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27 <0.9.0;

import "../Base.sol";
import {AztecL2Handler} from "./AztecL2Handler.sol";
import {Permit2DepositRouterHandler} from "./Permit2DepositRouterHandler.sol";
import {TokenPortalHandler} from "./TokenPortalHandler.sol";

/// @notice Multi-step flows over the whole bridge (deposit, L2 exit or return, proof, withdraw) that assert what a
/// completed cycle must leave behind, plus the liveness and domain-separation probes. Every step goes through the
/// same model updates as the single-step handlers, so a cycle that stops midway leaves a consistent model. Steps use
/// inline `try` calls with `vm.prank` (never `this.` calls), so a revert leaves no prank dangling. Handlers here do not
/// read `stateBefore`/`stateAfter`: the inner handlers overwrite them.
abstract contract RoundTripHandler is AztecL2Handler, Permit2DepositRouterHandler, TokenPortalHandler {
    // ―――――――――――――――――――――――― Round trips ――――――――――――――――――――――――――

    /// Deposit, claim, exit to self, withdraw: in a clean env the actor and the reserve end exactly where they began.
    function roundTrip_claimExit(uint256 amount, bool isPrivate, uint256 acc) public {
        if (!_cleanEnv()) return;
        amount = clampBetween(amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, amount);
        uint256 actorStart = usdc.balanceOf(actor);
        uint256 portalStart = usdc.balanceOf(address(portal));
        uint256 inboxStart = inbox.sent();
        if (!_cycle(amount, false, isPrivate, acc, false)) return;
        property_roundTripClaimExit(actorStart, portalStart, inboxStart);
    }

    /// Any token mode: a cycle that completes or stalls midway never enriches the actor or lowers the reserve.
    function roundTrip_anyMode(uint256 amount, bool isPrivate, bool viaReturn, uint256 acc) public {
        amount = clampBetween(amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, amount);
        uint256 actorStart = usdc.balanceOf(actor);
        uint256 portalStart = usdc.balanceOf(address(portal));
        _cycle(amount, false, isPrivate, acc, viaReturn);
        property_roundTripNoProfitAnyMode(actorStart, portalStart);
    }

    /// Deposit (direct or through the router), return, withdraw: in a clean env everything is restored.
    function roundTrip_return(uint256 amount, bool isPrivate, uint256 acc, bool viaRouter) public {
        if (!_cleanEnv()) return;
        amount = clampBetween(amount, 1, MAX_REALISTIC_AMOUNT);
        _ensureFunds(actor, amount);
        uint256 actorStart = usdc.balanceOf(actor);
        uint256 portalStart = usdc.balanceOf(address(portal));
        if (!_cycle(amount, viaRouter, isPrivate, acc, true)) return;
        property_roundTripReturn(actorStart, portalStart);
    }

    /// Up to four deposit-return-withdraw cycles of 1..199 units, straddling the 1% fee floor at 100.
    function roundTrip_dustCycles(uint256 n, uint256 x, bool isPrivate, uint256 acc) public {
        n = 1 + (n % 4);
        x = clampBetween(x, 1, 199);
        _ensureFunds(actor, n * x);
        uint256 actorStart = usdc.balanceOf(actor);
        uint256 portalStart = usdc.balanceOf(address(portal));
        for (uint256 i; i < n; i++) {
            if (!_cycle(x, false, isPrivate, acc, true)) break;
        }
        property_roundTripDustCycles(actorStart, portalStart);
    }

    /// Pays a caller-free proven exit, then deposits the same amount: the reserve ends where it began.
    function roundTrip_withdrawThenRedeposit(uint256 exitSeed, uint256 acc, bool isPrivate) public {
        uint256 n = provenUnpaidExits.length;
        uint256 id;
        bool found;
        for (uint256 i; i < n; i++) {
            uint256 cand = provenUnpaidExits[(exitSeed + i) % n];
            if (exitMsgs[cand].caller == address(0) && exitMsgs[cand].amount <= type(uint128).max) {
                id = cand;
                found = true;
                break;
            }
        }
        if (!found) return;
        uint256 amount = exitMsgs[id].amount;
        address recipient = exitMsgs[id].recipient;
        _ensureFunds(actor, amount);
        bool checkActor = _cleanEnv() && recipient == actor && !usdc.blacklisted(recipient);
        uint256 actorStart = usdc.balanceOf(actor);
        uint256 portalStart = usdc.balanceOf(address(portal));
        uint256 pendingStart = ghosts.pendingDepositAmount;
        if (!_attemptWithdraw(id)) return;
        if (!_attemptDeposit(actor, amount, false, isPrivate, toL2Account(acc), bytes32(0))) return;
        property_withdrawThenRedeposit(portalStart, pendingStart, amount, actorStart, checkActor);
    }

    /// The same deposit through the portal and through the router is interchangeable; another actor's router deposit
    /// names that actor.
    function roundTrip_directVsRouter(uint256 amount, bool isPrivate, uint256 acc, bytes32 secret) public {
        if (!_cleanEnv()) return;
        amount = clampBetween(amount, 1, MAX_REALISTIC_AMOUNT);
        address other = _otherActor(actor, uint256(secret));
        _ensureFunds(actor, amount);
        _ensureFunds(other, amount);
        bytes32 to = toL2Account(acc);
        secret = _toField(secret);

        uint256 mark = usdc.balanceOf(address(portal));
        if (!_attemptDeposit(actor, amount, false, isPrivate, to, secret)) return;
        uint256 creditDirect = usdc.balanceOf(address(portal)) - mark;
        bytes32 hashDirect = inbox.lastContentHash();

        mark = usdc.balanceOf(address(portal));
        if (!_attemptDeposit(actor, amount, true, isPrivate, to, secret)) return;
        uint256 creditRouter = usdc.balanceOf(address(portal)) - mark;
        bytes32 hashRouter = inbox.lastContentHash();

        if (!_attemptDeposit(other, amount, true, isPrivate, to, secret)) return;
        bytes32 expectedOther =
            _depositContent(DepositMsg(other, isPrivate ? bytes32(0) : to, amount, isPrivate, false));
        property_directRouterEquivalent(
            creditDirect, creditRouter, hashDirect, hashRouter, inbox.lastContentHash(), expectedOther
        );
    }

    // ――――――――――――――――――――――――― Probes ――――――――――――――――――――――――――

    /// A funded, unblocked caller's in-range deposit with the portal's rollup still canonical must go through, whatever
    /// the history: in a Normal environment on every path, and under a sender surcharge on the direct ones, where the
    /// portal still receives exactly `amount` (the router pays a surcharge on its forward, which `ResidualBalance`
    /// refuses by design).
    function adv_depositLiveness(uint8 which, uint256 amt, bool dust) public {
        which = uint8(which % 4);
        bool viaRouter = which >= 2;
        bool liveMode =
            _cleanEnvIn(ModalUsdc.Mode.Normal) || (!viaRouter && _cleanEnvIn(ModalUsdc.Mode.SenderSurcharge));
        if (!liveMode || !_canonical()) return;
        uint256 amount = dust ? clampBetween(amt, 1, 99) : clampBetween(amt, 1, MAX_REALISTIC_AMOUNT);
        // At the mock supply cap `_ensureFunds` can succeed on `amount` alone; the surcharge needs 1 % on top.
        uint256 surcharge = usdc.mode() == ModalUsdc.Mode.SenderSurcharge ? (amount * usdc.BPS()) / 10_000 : 0;
        if (!_ensureFunds(actor, amount) || usdc.balanceOf(actor) < amount + surcharge) return;
        if (!_attemptDeposit(actor, amount, viaRouter, which % 2 == 1, toL2Account(amt), bytes32(0))) {
            ghosts.depositLivenessBroken++;
        }
    }

    /// A deadline equal to the block's timestamp is still valid, on the portal's private path (its own authorization)
    /// and through the router (Permit2's); one second earlier is refused with that path's own expiry error, and a
    /// refused router deposit keeps its nonce.
    function adv_deadlineEdge(bool viaRouter, bool isPrivate, bool past, uint256 amt) public {
        if (!past && !_depositEnvClean()) return;
        if (!viaRouter) isPrivate = true;
        uint256 amount = clampBetween(amt, 1, MAX_REALISTIC_AMOUNT);
        if (!_ensureFunds(actor, amount)) return;
        uint256 deadline = block.timestamp - (past ? 1 : 0);
        // A fresh secret per probe, so two edge deposits in one block never share a portal authorization digest.
        bytes32 secret = bytes32(authorizationNonce++);
        if (!past) {
            (bool live,,) = _signedDeposit(actor, amount, viaRouter, isPrivate, L2_ACCOUNTS[0], secret, deadline);
            if (!live) ghosts.depositLivenessBroken++;
            return;
        }
        uint256 consumed = _noopBegin();
        (bool ok, bytes memory reason, uint256 nonce) =
            _signedDeposit(actor, amount, viaRouter, isPrivate, L2_ACCOUNTS[0], secret, deadline);
        bytes4 expired =
            viaRouter ? IPermit2Errors.SignatureExpired.selector : TokenPortal.AuthorizationExpired.selector;
        if (ok || bytes4(reason) != expired) ghosts.boundaryAccepted++;
        _noopEnd(consumed);
        if (viaRouter && _nonceUsed(actor, nonce)) ghosts.authorizationRollbackBroken++;
    }

    /// A proven Outbox leaf from another L2 sender, rollup version, L1 recipient or chain must never pay the portal out.
    function bridge_foreignDomainExit(uint8 kind, uint256 amount, uint256 recipientSeed, uint256 cpSeed) public {
        uint256 reserve = usdc.balanceOf(address(portal));
        if (reserve == 0) return;
        amount = clampBetween(amount, 1, reserve < MAX_REALISTIC_AMOUNT ? reserve : MAX_REALISTIC_AMOUNT);
        address recipient = actors[recipientSeed % actors.length];
        bytes32 leaf = _foreignLeaf(uint8(kind % 4), recipient, amount);
        uint256 epoch = nextEpoch++;
        uint256 numCheckpoints = 1 + (cpSeed % MAX_CHECKPOINTS_PER_EPOCH);
        uint256 consumed = _noopBegin();
        vm.prank(address(rollup));
        outbox.insert(Epoch.wrap(epoch), numCheckpoints, leaf);
        vm.prank(actor);
        try portal.withdraw(recipient, amount, false, Epoch.wrap(epoch), numCheckpoints, 0, new bytes32[](0)) {
            ghosts.foreignDomainPaid++;
        } catch {}
        snapshotAfter();
        property_refusedCallIsNoop(consumed);
        _universalChecks(false, false);
    }

    // ――――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    /// The leaf of a withdraw the portal would honour, with exactly one domain field changed.
    function _foreignLeaf(uint8 kind, address recipient, uint256 amount) internal view returns (bytes32) {
        bytes32 content =
            _fieldHash(abi.encodeWithSignature("withdraw(address,uint256,address)", recipient, amount, address(0)));
        return Hash.sha256ToField(
            DataStructures.L2ToL1Msg({
                sender: DataStructures.L2Actor(
                    kind == 0 ? bytes32(uint256(L2_BRIDGE) ^ 1) : L2_BRIDGE,
                    kind == 1 ? ROLLUP_VERSION + 1 : ROLLUP_VERSION
                ),
                recipient: DataStructures.L1Actor(
                    kind == 2 ? address(router) : address(portal), kind == 3 ? block.chainid + 1 : block.chainid
                ),
                content: content
            })
        );
    }

    /// Deposit by the current actor, leave through a claim + exit-to-self or a return, prove, withdraw. False when a
    /// step reverted (the model keeps whatever succeeded).
    function _cycle(uint256 amount, bool viaRouter, bool isPrivate, uint256 acc, bool viaReturn)
        internal
        returns (bool)
    {
        bytes32 to = toL2Account(acc);
        if (!_attemptDeposit(actor, amount, viaRouter, isPrivate, to, bytes32(uint256(amount)))) return false;
        uint256 pending = pendingDeposits.length - 1;
        if (viaReturn) {
            l2_returnDeposit(pending);
        } else {
            l2_claim(pending, acc);
            _exit(to, amount, actor, address(0));
        }
        uint256 id = exitMsgs.length - 1;
        for (uint256 i; i < 64 && !exitMsgs[id].proven; i++) {
            l2_proveEpoch(3, 0);
        }
        return _attemptWithdraw(id);
    }

    /// One deposit by `who`, recorded in the model only if it succeeded.
    function _attemptDeposit(address who, uint256 amount, bool viaRouter, bool isPrivate, bytes32 to, bytes32 secret)
        internal
        returns (bool ok)
    {
        if (viaRouter || isPrivate) {
            // A year out on the portal's path, as `_authorize` signs; Permit2's only needs to outlive this call.
            uint256 deadline = viaRouter ? block.timestamp + 1 : block.timestamp + 365 days + authorizationNonce++;
            (ok,,) = _signedDeposit(who, amount, viaRouter, isPrivate, to, secret, deadline);
            return ok;
        }
        vm.prank(who);
        try portal.depositToAztecPublic(who, to, amount, secret) {
            ok = true;
        } catch {}
        if (ok) _afterDirectDeposit(who, to, amount, false);
    }

    /// One signed deposit by `who` through the router or the portal's private path, valid through `deadline`, recorded
    /// in the model only if it succeeded. Returns the revert reason and the Permit2 nonce it signed.
    function _signedDeposit(
        address who,
        uint256 amount,
        bool viaRouter,
        bool isPrivate,
        bytes32 to,
        bytes32 secret,
        uint256 deadline
    ) internal returns (bool ok, bytes memory reason, uint256 nonce) {
        bytes32 recipient = isPrivate ? bytes32(0) : to;
        bytes memory signature;
        if (viaRouter) {
            nonce = _freshNonce(who);
            signature = _permitSignature(who, amount, recipient, secret, isPrivate, nonce, deadline);
        } else {
            signature = _authorizeUntil(who, who, amount, secret, deadline);
        }
        vm.prank(who);
        (ok, reason) = viaRouter
            ? address(router)
                .call(
                    abi.encodeCall(router.deposit, (amount, recipient, secret, isPrivate, nonce, deadline, signature))
                )
            : address(portal)
                .call(abi.encodeCall(portal.depositToAztecPrivate, (who, amount, secret, deadline, signature)));
        if (!ok) return (ok, reason, nonce);
        if (viaRouter) _afterRouterDeposit(who, recipient, amount, isPrivate, nonce);
        else _afterDirectDeposit(who, bytes32(0), amount, true);
    }

    /// One withdraw of modelled exit `id` by its caller (or the actor), recorded only if it succeeded; a revert in a
    /// healthy environment is a stuck payable exit.
    function _attemptWithdraw(uint256 id) internal returns (bool ok) {
        ExitMsg storage e = exitMsgs[id];
        address recipient = e.recipient;
        uint256 amount = e.amount;
        bool withCaller = e.caller != address(0);
        address sender = withCaller ? e.caller : actor;
        uint256 epoch = e.epoch;
        uint256 numCheckpoints = e.numCheckpoints;
        uint256 leafIndex = e.leafIndex;
        bytes32[] memory path = _exitPath(e);
        address prevActor = actor;
        actor = sender;
        vm.prank(sender);
        try portal.withdraw(recipient, amount, withCaller, Epoch.wrap(epoch), numCheckpoints, leafIndex, path) {
            ok = true;
        } catch {}
        if (ok) _recordWithdraw(recipient, amount, withCaller, epoch, numCheckpoints, leafIndex);
        else if (_withdrawHealthy(recipient, sender)) ghosts.payableExitStuck++;
        actor = prevActor;
    }
}
