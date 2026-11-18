// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {TokenPortal} from "../../src/TokenPortal.sol";
import {FAKE_ROLLUP_VERSION} from "../mocks/AztecFakes.sol";
import {Permit2Digest} from "../mocks/Permit2Digest.sol";
import {ModalUsdc} from "./mocks/ModalUsdc.sol";
import {vm} from "./utils/Hevm.sol";
import {Snapshots} from "./Snapshots.sol";
import {PropertiesAsserts} from "./utils/PropertiesAsserts.sol";

abstract contract Properties is PropertiesAsserts, Snapshots {
    // ―――――――――――――――――――― Global properties ―――――――――――――――――――――
    // These properties must always hold after any function call.
    // They MUST BE PUBLIC so that fuzzers can find and call them.

    /// @notice GL-01: the portal's USDC equals deposits plus donations minus payouts, exactly
    function property_reserveIdentity() public {
        uint256 inflow = ghosts.deposited + ghosts.portalDonated;
        gte(inflow, ghosts.withdrawn, "GL-01: withdrawn exceeds deposited plus donated");
        if (inflow < ghosts.withdrawn) return;
        eq(
            usdc.balanceOf(address(portal)),
            inflow - ghosts.withdrawn,
            "GL-01: portal balance != deposited + donated - withdrawn"
        );
    }

    /// @notice GL-02: the portal's USDC covers every L2 supply, pending deposit and unpaid exit
    function property_solvent() public {
        gte(
            usdc.balanceOf(address(portal)),
            ghosts.l2Supply + ghosts.pendingDepositAmount + ghosts.unpaidExitAmount,
            "GL-02: portal balance < l2Supply + pending + unpaid exits"
        );
    }

    /// @notice GL-03: the portal's surplus over all obligations is exactly the donations
    function property_surplusIsDonations() public {
        eq(
            usdc.balanceOf(address(portal)),
            ghosts.portalDonated + ghosts.l2Supply + ghosts.pendingDepositAmount + ghosts.unpaidExitAmount,
            "GL-03: portal balance != donations + obligations"
        );
    }

    /// @notice GL-04: every deposited token is pending, claimed or returned, and exits balance the L2 supply
    function property_depositFlowConserved() public {
        eq(
            ghosts.deposited,
            ghosts.pendingDepositAmount + ghosts.claimed + ghosts.returned,
            "GL-04: deposited != pending + claimed + returned"
        );
        gte(ghosts.exited, ghosts.returned, "GL-04: returned exceeds exited");
        if (ghosts.exited < ghosts.returned) return;
        eq(ghosts.l2Supply + (ghosts.exited - ghosts.returned), ghosts.claimed, "GL-04: l2Supply + exits != claimed");
    }

    /// @notice GL-05: the L2 supply equals the modelled account balances plus the off-account ghost
    function property_l2SupplyMatchesBalances() public {
        uint256 sum = ghosts.l2OffAccount;
        for (uint256 i; i < L2_ACCOUNTS.length; i++) {
            sum += l2Balance[L2_ACCOUNTS[i]];
        }
        eq(ghosts.l2Supply, sum, "GL-05: l2Supply != sum of L2 balances + off-account");
    }

    /// @notice GL-06: the exit ledger sums to the exited and unpaid ghosts
    function property_exitLedgerSums() public {
        uint256 total;
        uint256 unpaid;
        for (uint256 i; i < exitMsgs.length; i++) {
            total += exitMsgs[i].amount;
            if (!exitMsgs[i].paid) unpaid += exitMsgs[i].amount;
        }
        eq(total, ghosts.exited, "GL-06: sum of exit amounts != exited");
        eq(unpaid, ghosts.unpaidExitAmount, "GL-06: sum of unpaid exits != unpaidExitAmount");
        if (ghosts.unbackedPayouts == 0) {
            gte(ghosts.exited, ghosts.withdrawn, "GL-06: withdrawn exceeds exited");
            if (ghosts.exited >= ghosts.withdrawn) {
                eq(ghosts.unpaidExitAmount, ghosts.exited - ghosts.withdrawn, "GL-06: unpaid != exited - withdrawn");
            }
        }
    }

    /// @notice GL-07: the unproven, proven-unpaid and paid lists partition the exits with matching flags
    function property_exitLifecyclePartition() public {
        eq(
            unprovenExits.length + provenUnpaidExits.length + paidExits.length,
            exitMsgs.length,
            "GL-07: exit lists do not partition exitMsgs"
        );
        for (uint256 i; i < unprovenExits.length; i++) {
            ExitMsg storage e = exitMsgs[unprovenExits[i]];
            t(!e.proven && !e.paid, "GL-07: unproven list holds a proven or paid exit");
        }
        for (uint256 i; i < provenUnpaidExits.length; i++) {
            ExitMsg storage e = exitMsgs[provenUnpaidExits[i]];
            t(e.proven && !e.paid, "GL-07: proven-unpaid list holds an unproven or paid exit");
        }
        uint256 paidSum;
        for (uint256 i; i < paidExits.length; i++) {
            ExitMsg storage e = exitMsgs[paidExits[i]];
            t(e.proven && e.paid, "GL-07: paid list holds an unproven or unpaid exit");
            paidSum += e.amount;
        }
        if (ghosts.unbackedPayouts == 0) {
            eq(paidSum, ghosts.withdrawn, "GL-07: sum of paid exits != withdrawn");
            eq(paidExits.length, ghosts.withdrawCount, "GL-07: paid exits != withdrawCount");
        }
    }

    /// @notice GL-08: the router holds exactly the donations it was sent
    function property_routerHoldsOnlyDonations() public {
        eq(usdc.balanceOf(address(router)), ghosts.routerDonated, "GL-08: router balance != routerDonated");
    }

    /// @notice GL-09: the router's allowance to the portal is zero between calls
    function property_routerAllowanceZero() public {
        eq(usdc.allowance(address(router), address(portal)), 0, "GL-09: router allowance to portal != 0");
    }

    /// @notice GL-10: one Inbox message per successful deposit and no other
    function property_oneMessagePerDeposit() public {
        eq(inbox.sent(), ghosts.depositCount, "GL-10: inbox.sent != depositCount");
        eq(depositMsgs.length, ghosts.depositCount, "GL-10: depositMsgs.length != depositCount");
    }

    /// @notice GL-11: the last Inbox message is addressed to the L2 bridge at the rollup version, sent by the portal
    function property_lastMessageAddressed() public {
        if (inbox.sent() == 0) return;
        eq(uint256(inbox.lastBridge()), uint256(L2_BRIDGE), "GL-11: last message not addressed to L2_BRIDGE");
        eq(inbox.lastVersion(), ROLLUP_VERSION, "GL-11: last message not at ROLLUP_VERSION");
        t(inbox.lastSender() == address(portal), "GL-11: last message not sent by the portal");
    }

    /// @notice GL-12: deposit-message sums match the deposited and pending ghosts
    function property_depositModelSums() public {
        uint256 total;
        uint256 unconsumedSum;
        uint256 unconsumedCount;
        for (uint256 i; i < depositMsgs.length; i++) {
            total += depositMsgs[i].amount;
            if (!depositMsgs[i].consumed) {
                unconsumedSum += depositMsgs[i].amount;
                unconsumedCount++;
            }
        }
        eq(total, ghosts.deposited, "GL-12: sum of deposit messages != deposited");
        eq(unconsumedSum, ghosts.pendingDepositAmount, "GL-12: sum of unconsumed != pendingDepositAmount");
        eq(unconsumedCount, pendingDeposits.length, "GL-12: unconsumed count != pendingDeposits.length");
        for (uint256 i; i < pendingDeposits.length; i++) {
            t(!depositMsgs[pendingDeposits[i]].consumed, "GL-12: pending index points at a consumed message");
        }
    }

    /// @notice GL-13: all USDC supply sits at the actors, portal, router or the fee sink
    function property_usdcSupplyAccounted() public {
        uint256 sum = usdc.balanceOf(address(portal)) + usdc.balanceOf(address(router)) + usdc.balanceOf(usdc.SINK());
        for (uint256 i; i < actors.length; i++) {
            sum += usdc.balanceOf(actors[i]);
        }
        eq(sum, usdc.totalSupply(), "GL-13: USDC supply not fully accounted for");
    }

    /// @notice GL-14: pass-through infrastructure never keeps USDC
    function property_infraHoldsNoUsdc() public {
        eq(usdc.balanceOf(address(permit2)), 0, "GL-14: Permit2 holds USDC");
        eq(usdc.balanceOf(address(inbox)), 0, "GL-14: Inbox holds USDC");
        eq(usdc.balanceOf(address(outbox)), 0, "GL-14: Outbox holds USDC");
        eq(usdc.balanceOf(address(rollup)), 0, "GL-14: Rollup holds USDC");
        eq(usdc.balanceOf(address(registry)), 0, "GL-14: Registry holds USDC");
        eq(usdc.balanceOf(admin), 0, "GL-14: admin holds USDC");
    }

    /// @notice GL-15: a proven exit's Outbox leaf is consumed exactly when its payout happened
    function property_outboxNullifierMatchesPaid() public {
        for (uint256 i; i < exitMsgs.length; i++) {
            ExitMsg storage e = exitMsgs[i];
            if (!e.proven) continue;
            bool consumed;
            try outbox.hasMessageBeenConsumedAtEpoch(Epoch.wrap(e.epoch), (1 << e.pathLen) + e.leafIndex) returns (
                bool c
            ) {
                consumed = c;
            } catch {
                continue;
            }
            t(consumed == e.paid, "GL-15: Outbox leaf consumed state != modelled paid");
        }
    }

    /// @notice GL-16: the direct and router deposit paths sum to the total deposited
    function property_depositPathsSum() public {
        eq(ghosts.deposited, ghosts.directDeposited + ghosts.routerDeposited, "GL-16: deposited != direct + router");
    }

    /// @notice GL-17: no payout without a matching proven exit, no replay, tamper or wrong-caller delivery
    function property_payoutsAuthentic() public {
        eq(ghosts.unbackedPayouts, 0, "GL-17: unbacked payout");
        eq(ghosts.replayedPayouts, 0, "GL-17: replayed payout");
        eq(ghosts.tamperedPayouts, 0, "GL-17: tampered payout");
        eq(ghosts.wrongCallerPayouts, 0, "GL-17: wrong-caller payout");
    }

    /// @notice GL-18: a proven exit naming the portal itself never pays
    function property_noSelfPayout() public {
        eq(ghosts.selfPayoutAccepted, 0, "GL-18: self payout accepted");
    }

    /// @notice GL-19: no re-initialization, stranger-named depositor or mis-bound router
    function property_noTakeover() public {
        eq(ghosts.reinitialized, 0, "GL-19: portal re-initialized");
        eq(ghosts.strangerNamedDepositor, 0, "GL-19: stranger named a depositor");
        eq(ghosts.misboundRouter, 0, "GL-19: mis-bound router accepted");
    }

    /// @notice GL-20: the live portal's and router's bindings never move from their setup values
    function property_bindingsFrozen() public {
        t(address(portal.registry()) == address(registry), "GL-20: portal registry moved");
        t(address(portal.underlying()) == address(usdc), "GL-20: portal underlying moved");
        t(portal.l2Bridge() == L2_BRIDGE, "GL-20: portal l2Bridge moved");
        t(portal.router() == address(router), "GL-20: portal router moved");
        t(address(portal.rollup()) == address(rollup), "GL-20: portal rollup moved");
        t(address(portal.outbox()) == address(outbox), "GL-20: portal outbox moved");
        t(address(portal.inbox()) == address(inbox), "GL-20: portal inbox moved");
        t(portal.rollupVersion() == ROLLUP_VERSION, "GL-20: portal rollupVersion moved");
        t(portal.initializer() == admin, "GL-20: portal initializer moved");
        t(address(router.PORTAL()) == address(portal), "GL-20: router PORTAL moved");
        t(address(router.TOKEN()) == address(usdc), "GL-20: router TOKEN moved");
        t(address(router.PERMIT2()) == address(permit2), "GL-20: router PERMIT2 moved");
    }

    /// @notice GL-21: out-of-range deposits never succeed
    function property_boundaryRefused() public {
        eq(ghosts.boundaryAccepted, 0, "GL-21: out-of-range deposit accepted");
    }

    /// @notice GL-22: a router deposit never succeeds when Permit2 refused the pull
    function property_permit2RejectHonoured() public {
        eq(ghosts.permit2RejectBypassed, 0, "GL-22: router deposit bypassed a Permit2 rejection");
    }

    /// @notice GL-23: every deposit's Inbox content names the true payer, recipient, amount and kind
    function property_messagesTruthful() public {
        eq(ghosts.misnamedMessages, 0, "GL-23: misnamed deposit message");
    }

    /// @notice GL-24: a token-hook re-entry into the portal or router is refused by the reentrancy guard itself
    function property_noReentry() public {
        eq(usdc.hookReentrySucceeded(), 0, "GL-24: a hook re-entry was not refused by the guard");
    }

    /// @notice GL-25: round-tripping the bridge never pays out more than was put in
    function property_noNetPayoutOverDeposits() public {
        lte(ghosts.withdrawn, ghosts.exited, "GL-25: withdrawn > exited");
        lte(ghosts.exited, ghosts.claimed + ghosts.returned, "GL-25: exited > claimed + returned");
        lte(ghosts.withdrawn, ghosts.deposited, "GL-25: withdrawn > deposited");
    }

    /// @notice GL-26: cumulative L2 liabilities fit the u128 L2 amount type
    function property_l2LiabilitiesFitU128() public {
        lte(
            ghosts.l2Supply + ghosts.pendingDepositAmount,
            type(uint128).max,
            "GL-26: l2Supply + pending exceeds u128 max"
        );
    }

    /// @notice GL-27: actors gain USDC only through payouts and funding mints
    function property_noFreeProfit() public {
        uint256 held;
        for (uint256 i; i < actors.length; i++) {
            held += usdc.balanceOf(actors[i]);
        }
        lte(
            held + ghosts.deposited,
            actors.length * INITIAL_TOKEN_BALANCE + ghosts.actorMinted + ghosts.withdrawn,
            "GL-27: actors hold more than funded plus payouts"
        );
    }

    /// @notice GL-28: a payable proven exit is never stuck in a healthy environment
    function property_noStuckPayableExit() public {
        eq(ghosts.payableExitStuck, 0, "GL-28: payable exit reverted in a healthy environment");
    }

    /// @notice GL-29: a funded caller's in-range deposit in a Normal environment (a direct one also under a sender
    /// surcharge) always succeeds, a deadline equal to the block's timestamp included
    function property_depositsLive() public {
        eq(ghosts.depositLivenessBroken, 0, "GL-29: a deposit that must go through reverted");
    }

    /// @notice GL-30: inexact token behaviour is never accepted
    function property_inexactTokenRefused() public {
        eq(ghosts.inexactAccepted, 0, "GL-30: inexact transfer accepted");
    }

    /// @notice GL-31: a foreign-domain Outbox leaf never pays out of the portal
    function property_foreignDomainRefused() public {
        eq(ghosts.foreignDomainPaid, 0, "GL-31: foreign-domain leaf paid out");
    }

    /// @notice GL-32: no deposit lands while the registry's canonical rollup is not the portal's
    function property_staleRollupRefusesDeposits() public {
        eq(ghosts.staleDepositAccepted, 0, "GL-32: a deposit landed on a rollup that is no longer canonical");
    }

    /// @notice GL-33: a portal authorization deposits once, and only for the submitter it names
    function property_authorizationsSingleUse() public {
        eq(ghosts.authorizationMisused, 0, "GL-33: a spent or foreign-submitter authorization was not refused");
    }

    /// @notice GL-34: a private deposit carrying another key's signature reaches neither Permit2 nor the Inbox
    function property_foreignSignaturesRefused() public {
        eq(
            ghosts.foreignSignatureAccepted,
            0,
            "GL-34: a foreign signature was not refused before Permit2 and the Inbox"
        );
    }

    /// @notice GL-35: a refused deposit spends neither its Permit2 nonce nor its portal authorization
    function property_refusedDepositsKeepAuthorizations() public {
        eq(ghosts.authorizationRollbackBroken, 0, "GL-35: a refused deposit spent its authorization");
    }

    // ――――――――――――――――――― Specific properties ――――――――――――――――――――
    // These properties must hold after specific function calls.
    // They MUST BE INTERNAL and called at the end of the relevant handlers.

    uint256 internal constant NO_ACTOR = type(uint256).max;

    // Helpers

    function _actorIdx(address who) internal view returns (uint256) {
        for (uint256 i; i < actors.length; i++) {
            if (actors[i] == who) return i;
        }
        return NO_ACTOR;
    }

    function _eqB(bytes32 a, bytes32 b, string memory reason) internal {
        eq(uint256(a), uint256(b), reason);
    }

    function _eqA(address a, address b, string memory reason) internal {
        eq(uint256(uint160(a)), uint256(uint160(b)), reason);
    }

    /// Every actor outside the two excluded indexes kept its balance across the bracketed call.
    function _othersUnchanged(uint256 except1, uint256 except2, string memory reason) internal {
        for (uint256 i; i < actors.length; i++) {
            if (i == except1 || i == except2) continue;
            eq(stateAfter.actorBal[i], stateBefore.actorBal[i], reason);
        }
    }

    function _consumedAt(uint256 epoch, uint256 pathLen, uint256 leafIndex) internal view returns (bool consumed) {
        try outbox.hasMessageBeenConsumedAtEpoch(Epoch.wrap(epoch), (1 << pathLen) + leafIndex) returns (bool c) {
            consumed = c;
        } catch {}
    }

    /// How many modelled proven exits have their Outbox leaf consumed.
    function _consumedCount() internal view returns (uint256 n) {
        for (uint256 i; i < exitMsgs.length; i++) {
            ExitMsg storage e = exitMsgs[i];
            if (e.proven && _consumedAt(e.epoch, e.pathLen, e.leafIndex)) n++;
        }
    }

    /// Opens the bracket of a call that must be refused; must run before any pending `vm.prank`.
    function _noopBegin() internal returns (uint256 consumed) {
        consumed = _consumedCount();
        snapshotBefore();
    }

    function _noopEnd(uint256 consumed) internal {
        snapshotAfter();
        property_refusedCallIsNoop(consumed);
    }

    /// Flags a deposit accepted although the token took a fee (below 100 units the 1% fee floors to zero).
    function _flagInexactDeposit(uint256 amount) internal {
        if (amount >= 100 && usdc.mode() == ModalUsdc.Mode.FeeOnTransfer) ghosts.inexactAccepted++;
    }

    /// Flags a withdraw accepted although the token charged the portal a surcharge.
    function _flagInexactWithdraw(uint256 amount) internal {
        if (amount >= 100 && usdc.mode() == ModalUsdc.Mode.SenderSurcharge) ghosts.inexactAccepted++;
    }

    /// Checks every bracketed handler owes: SP-09 (skipped across a withdraw), SP-10, SP-11, SP-13.
    function _universalChecks(bool isDeposit, bool isWithdraw) internal {
        if (!isWithdraw) property_portalNeverShrinksExceptWithdraw();
        property_routerNeverShrinks();
        property_inboxCountMoves(isDeposit);
        property_accumulatorsMonotone();
    }

    // Deposit and withdraw postconditions

    /// @notice SP-01: a direct deposit credits the portal exactly, sends one message and touches nothing else
    function property_directDepositPost(uint256 amount) internal {
        uint256 idx = _actorIdx(actor);
        eq(stateAfter.portalBal, stateBefore.portalBal + amount, "SP-01: portal not credited exactly amount");
        eq(stateAfter.inboxSent, stateBefore.inboxSent + 1, "SP-01: deposit did not send exactly one message");
        eq(stateAfter.routerBal, stateBefore.routerBal, "SP-01: router balance moved");
        eq(stateAfter.routerAllowance, stateBefore.routerAllowance, "SP-01: router allowance moved");
        eq(stateAfter.depositMsgsLen, stateBefore.depositMsgsLen + 1, "SP-01: depositMsgs did not grow by one");
        _othersUnchanged(idx, NO_ACTOR, "SP-01: a bystander's balance moved");
        gte(stateBefore.actorBal[idx], stateAfter.actorBal[idx] + amount, "SP-01: caller paid less than amount");
    }

    /// @notice SP-02: a router deposit credits the portal exactly, leaves the router untouched and debits only the signer
    function property_routerDepositPost(uint256 amount) internal {
        uint256 idx = _actorIdx(actor);
        eq(stateAfter.portalBal, stateBefore.portalBal + amount, "SP-02: portal not credited exactly amount");
        eq(stateAfter.inboxSent, stateBefore.inboxSent + 1, "SP-02: deposit did not send exactly one message");
        eq(stateAfter.routerBal, stateBefore.routerBal, "SP-02: router balance moved");
        eq(stateAfter.routerAllowance, 0, "SP-02: router allowance to portal left open");
        _othersUnchanged(idx, NO_ACTOR, "SP-02: a non-signer's balance moved");
        gte(stateBefore.actorBal[idx], stateAfter.actorBal[idx] + amount, "SP-02: signer paid less than amount");
        if (_cleanEnv()) {
            eq(
                stateBefore.actorBal[idx],
                stateAfter.actorBal[idx] + amount,
                "SP-02: signer paid != amount in a clean env"
            );
        }
    }

    /// @notice SP-03: the real Permit2 accepted the signer's signature over the spec digest and spent its free nonce,
    /// so the router handed it the signed owner, spender, token, amount, nonce, deadline and witness
    function property_routerPermit2Binding(bool nonceWasFree, uint256 nonce) internal {
        t(nonceWasFree, "SP-03: a deposit went through on a spent nonce");
        t(_nonceUsed(actor, nonce), "SP-03: Permit2 left the signer's nonce unspent");
    }

    /// @notice SP-23: the router's permit digest and Permit2's domain equal their independent derivation
    function property_permitDigestMatchesSpec(
        uint256 amount,
        bytes32 recipient,
        bytes32 secretHash,
        bool isPrivate,
        uint256 nonce,
        uint256 deadline
    ) internal {
        _eqB(
            permit2.DOMAIN_SEPARATOR(),
            Permit2Digest.domainSeparator(block.chainid, address(permit2)),
            "SP-23: Permit2's domain separator != the spec's"
        );
        _eqB(
            router.permitDigest(amount, recipient, secretHash, isPrivate, nonce, deadline),
            _specPermitDigest(amount, recipient, secretHash, isPrivate, nonce, deadline),
            "SP-23: router.permitDigest != the spec digest"
        );
    }

    /// @notice SP-04: the Inbox message carries the caller's secret hash verbatim
    function property_secretHashPassthrough(bytes32 secretHash) internal {
        _eqB(inbox.lastSecretHash(), secretHash, "SP-04: Inbox secret hash != the one passed");
    }

    /// @notice SP-05: the returned Inbox index is the latest message's
    function property_inboxIndexAdvances(uint256 index) internal {
        eq(index, inbox.sent() - 1, "SP-05: returned index != inbox.sent() - 1");
    }

    /// @notice SP-06: a withdraw debits the portal exactly, credits only the recipient and moves the exit to paid
    function property_withdrawPost(address recipient, uint256 amount, uint256 epoch, uint256 pathLen, uint256 leafIndex)
        internal
    {
        uint256 r = _actorIdx(recipient);
        eq(stateAfter.portalBal + amount, stateBefore.portalBal, "SP-06: portal not debited exactly amount");
        eq(stateAfter.inboxSent, stateBefore.inboxSent, "SP-06: withdraw sent an Inbox message");
        eq(stateAfter.routerBal, stateBefore.routerBal, "SP-06: router balance moved");
        _othersUnchanged(r, NO_ACTOR, "SP-06: a non-recipient's balance moved");
        if (r != NO_ACTOR) gte(stateAfter.actorBal[r], stateBefore.actorBal[r], "SP-06: recipient lost USDC");
        eq(stateAfter.paidLen, stateBefore.paidLen + 1, "SP-06: paidExits did not grow by one");
        eq(
            stateAfter.provenUnpaidLen + 1,
            stateBefore.provenUnpaidLen,
            "SP-06: provenUnpaidExits did not shrink by one"
        );
        eq(stateAfter.gWithdrawCount, stateBefore.gWithdrawCount + 1, "SP-06: withdrawCount did not rise by one");
        t(_consumedAt(epoch, pathLen, leafIndex), "SP-06: Outbox leaf not consumed after payout");
    }

    /// @notice SP-07: in a Normal env a third-party submit pays the recipient exactly and skims nothing
    function property_thirdPartySubmitNoSkim(address recipient, uint256 amount) internal {
        if (!_cleanEnv()) return;
        uint256 r = _actorIdx(recipient);
        if (r == NO_ACTOR) return;
        eq(stateAfter.actorBal[r], stateBefore.actorBal[r] + amount, "SP-07: recipient not credited exactly amount");
        uint256 a = _actorIdx(actor);
        if (a != r) eq(stateAfter.actorBal[a], stateBefore.actorBal[a], "SP-07: submitter's balance moved");
    }

    /// @notice SP-08: a refused call changes no balance, allowance, message count, model length or leaf status
    function property_refusedCallIsNoop(uint256 consumedBefore) internal {
        eq(stateAfter.portalBal, stateBefore.portalBal, "SP-08: portal balance moved");
        eq(stateAfter.routerBal, stateBefore.routerBal, "SP-08: router balance moved");
        eq(stateAfter.routerAllowance, stateBefore.routerAllowance, "SP-08: router allowance moved");
        eq(stateAfter.inboxSent, stateBefore.inboxSent, "SP-08: Inbox message count moved");
        _othersUnchanged(NO_ACTOR, NO_ACTOR, "SP-08: an actor balance moved");
        eq(stateAfter.depositMsgsLen, stateBefore.depositMsgsLen, "SP-08: depositMsgs length moved");
        eq(stateAfter.pendingLen, stateBefore.pendingLen, "SP-08: pendingDeposits length moved");
        eq(stateAfter.exitMsgsLen, stateBefore.exitMsgsLen, "SP-08: exitMsgs length moved");
        eq(stateAfter.provenUnpaidLen, stateBefore.provenUnpaidLen, "SP-08: provenUnpaidExits length moved");
        eq(stateAfter.paidLen, stateBefore.paidLen, "SP-08: paidExits length moved");
        eq(stateAfter.unprovenLen, stateBefore.unprovenLen, "SP-08: unprovenExits length moved");
        eq(_consumedCount(), consumedBefore, "SP-08: an Outbox leaf changed status");
    }

    // Transitions across every bracketed handler

    /// @notice SP-09: the portal's USDC never decreases outside a withdraw
    function property_portalNeverShrinksExceptWithdraw() internal {
        gte(stateAfter.portalBal, stateBefore.portalBal, "SP-09: portal balance shrank outside a withdraw");
    }

    /// @notice SP-10: the router's USDC never decreases
    function property_routerNeverShrinks() internal {
        gte(stateAfter.routerBal, stateBefore.routerBal, "SP-10: router balance shrank");
    }

    /// @notice SP-11: the Inbox count rises by exactly one across a deposit and not at all otherwise
    function property_inboxCountMoves(bool isDeposit) internal {
        eq(stateAfter.inboxSent, stateBefore.inboxSent + (isDeposit ? 1 : 0), "SP-11: Inbox count moved unexpectedly");
    }

    /// @notice SP-12: deposit handlers leave withdraw-side state alone and withdraw handlers deposit-side state
    function property_depositWithdrawIsolation(bool isDepositSide) internal {
        if (isDepositSide) {
            eq(stateAfter.gWithdrawCount, stateBefore.gWithdrawCount, "SP-12: deposit changed withdrawCount");
            eq(stateAfter.gWithdrawn, stateBefore.gWithdrawn, "SP-12: deposit changed withdrawn");
            eq(stateAfter.paidLen, stateBefore.paidLen, "SP-12: deposit changed paidExits");
            eq(stateAfter.provenUnpaidLen, stateBefore.provenUnpaidLen, "SP-12: deposit changed provenUnpaidExits");
        } else {
            eq(stateAfter.inboxSent, stateBefore.inboxSent, "SP-12: withdraw changed the Inbox count");
            eq(stateAfter.gDepositCount, stateBefore.gDepositCount, "SP-12: withdraw changed depositCount");
            eq(stateAfter.depositMsgsLen, stateBefore.depositMsgsLen, "SP-12: withdraw changed depositMsgs");
            eq(stateAfter.pendingLen, stateBefore.pendingLen, "SP-12: withdraw changed pendingDeposits");
        }
    }

    /// @notice SP-13: harness accumulators never decrease
    function property_accumulatorsMonotone() internal {
        gte(stateAfter.gDeposited, stateBefore.gDeposited, "SP-13: deposited decreased");
        gte(stateAfter.gDepositCount, stateBefore.gDepositCount, "SP-13: depositCount decreased");
        gte(stateAfter.gWithdrawn, stateBefore.gWithdrawn, "SP-13: withdrawn decreased");
        gte(stateAfter.gWithdrawCount, stateBefore.gWithdrawCount, "SP-13: withdrawCount decreased");
        gte(stateAfter.gClaimed, stateBefore.gClaimed, "SP-13: claimed decreased");
        gte(stateAfter.gReturned, stateBefore.gReturned, "SP-13: returned decreased");
        gte(stateAfter.gExited, stateBefore.gExited, "SP-13: exited decreased");
        gte(stateAfter.gPortalDonated, stateBefore.gPortalDonated, "SP-13: portalDonated decreased");
        gte(stateAfter.gRouterDonated, stateBefore.gRouterDonated, "SP-13: routerDonated decreased");
        gte(stateAfter.gNextEpoch, stateBefore.gNextEpoch, "SP-13: nextEpoch decreased");
        gte(stateAfter.depositMsgsLen, stateBefore.depositMsgsLen, "SP-13: depositMsgs shrank");
        gte(stateAfter.exitMsgsLen, stateBefore.exitMsgsLen, "SP-13: exitMsgs shrank");
        gte(stateAfter.paidLen, stateBefore.paidLen, "SP-13: paidExits shrank");
    }

    // Fresh-portal initialization

    function _bindingsHash(TokenPortal p) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(p.registry()),
                address(p.underlying()),
                p.l2Bridge(),
                p.router(),
                address(p.rollup()),
                address(p.outbox()),
                address(p.inbox()),
                p.rollupVersion()
            )
        );
    }

    /// @notice SP-14: a fresh portal's first valid initialize succeeds and every later one reverts, bindings intact
    function property_freshPortalInitOnce(TokenPortal fresh, address validRouter, address stranger) internal {
        try fresh.initialize(address(registry), address(usdc), L2_BRIDGE, validRouter, FAKE_ROLLUP_VERSION) {}
        catch {
            t(false, "SP-14: the initializer's first valid initialize reverted");
        }
        bytes32 bound = _bindingsHash(fresh);
        try fresh.initialize(
            address(registry), address(usdc), bytes32(uint256(0xBAD)), validRouter, FAKE_ROLLUP_VERSION
        ) {
            t(false, "SP-14: the initializer re-initialized");
        } catch {}
        vm.prank(stranger);
        try fresh.initialize(
            address(registry), address(usdc), bytes32(uint256(0xBAD)), validRouter, FAKE_ROLLUP_VERSION
        ) {
            t(false, "SP-14: a stranger re-initialized");
        } catch {}
        _eqB(_bindingsHash(fresh), bound, "SP-14: a refused initialize moved a binding");
    }

    /// @notice SP-15: a refused stranger or foreign-router initialize leaves a fresh portal's init slot unspent
    function property_strangerInitKeepsSlot(
        TokenPortal fresh,
        address validRouter,
        address foreignTokenRouter,
        address stranger
    ) internal {
        vm.prank(stranger);
        try fresh.initialize(address(registry), address(usdc), L2_BRIDGE, validRouter, FAKE_ROLLUP_VERSION) {
            t(false, "SP-15: a stranger initialized a fresh portal");
        } catch {}
        _eqA(address(fresh.registry()), address(0), "SP-15: a refused stranger initialize consumed the slot");
        try fresh.initialize(address(registry), address(usdc), L2_BRIDGE, foreignTokenRouter, FAKE_ROLLUP_VERSION) {
            t(false, "SP-15: a router naming another token was bound");
        } catch {}
        _eqA(address(fresh.registry()), address(0), "SP-15: a refused router consumed the slot");
    }

    // Round trips

    /// @notice SP-16: deposit, claim, exit, withdraw in a clean env restores the actor and the reserve
    function property_roundTripClaimExit(uint256 actorStart, uint256 portalStart, uint256 inboxStart) internal {
        eq(usdc.balanceOf(actor), actorStart, "SP-16: actor USDC changed over the round trip");
        eq(usdc.balanceOf(address(portal)), portalStart, "SP-16: portal reserve changed over the round trip");
        eq(inbox.sent(), inboxStart + 1, "SP-16: round trip did not send exactly one message");
    }

    /// @notice SP-17: in any token mode a cycle never leaves the actor richer or the portal poorer
    function property_roundTripNoProfitAnyMode(uint256 actorStart, uint256 portalStart) internal {
        lte(usdc.balanceOf(actor), actorStart, "SP-17: actor profited from a round trip");
        gte(usdc.balanceOf(address(portal)), portalStart, "SP-17: portal reserve fell over a round trip");
    }

    /// @notice SP-18: deposit, return, withdraw in a clean env restores the actor and the reserve
    function property_roundTripReturn(uint256 actorStart, uint256 portalStart) internal {
        eq(usdc.balanceOf(actor), actorStart, "SP-18: actor USDC not restored by a return");
        eq(usdc.balanceOf(address(portal)), portalStart, "SP-18: portal reserve not restored by a return");
    }

    /// @notice SP-19: repeated dust cycles never enrich the actor or drain the reserve
    function property_roundTripDustCycles(uint256 actorStart, uint256 portalStart) internal {
        lte(usdc.balanceOf(actor), actorStart, "SP-19: dust cycles enriched the actor");
        gte(usdc.balanceOf(address(portal)), portalStart, "SP-19: dust cycles drained the reserve");
    }

    /// @notice SP-20: withdrawing an exit and re-depositing its amount leaves the reserve and adds one pending amount
    function property_withdrawThenRedeposit(
        uint256 portalStart,
        uint256 pendingStart,
        uint256 amount,
        uint256 actorStart,
        bool checkActor
    ) internal {
        eq(usdc.balanceOf(address(portal)), portalStart, "SP-20: reserve changed over withdraw + redeposit");
        eq(ghosts.pendingDepositAmount, pendingStart + amount, "SP-20: pending did not rise by exactly amount");
        if (checkActor) eq(usdc.balanceOf(actor), actorStart, "SP-20: actor USDC changed over withdraw + redeposit");
    }

    /// @notice SP-21: direct and router deposits of the same inputs credit alike and carry the same content hash
    function property_directRouterEquivalent(
        uint256 creditDirect,
        uint256 creditRouter,
        bytes32 hashDirect,
        bytes32 hashRouter,
        bytes32 hashOther,
        bytes32 expectedOther
    ) internal {
        eq(creditDirect, creditRouter, "SP-21: direct and router credits differ");
        _eqB(hashDirect, hashRouter, "SP-21: direct and router content hashes differ");
        _eqB(hashOther, expectedOther, "SP-21: another actor's router deposit did not name that actor");
        neq(uint256(hashOther), uint256(hashDirect), "SP-21: another actor's deposit carries the first actor's hash");
    }

    /// @notice SP-22: a zero deposit is refused on every path and moves nothing: no USDC, no message, no claimable value
    function property_zeroAmountSafe() internal {
        eq(stateAfter.portalBal, stateBefore.portalBal, "SP-22: zero deposit moved portal USDC");
        eq(
            stateAfter.actorTokenBalance,
            stateBefore.actorTokenBalance,
            "SP-22: zero deposit moved the depositor's USDC"
        );
        eq(
            stateAfter.pendingDepositAmount,
            stateBefore.pendingDepositAmount,
            "SP-22: zero deposit created claimable value"
        );
        eq(stateAfter.inboxSent, stateBefore.inboxSent, "SP-22: zero deposit sent a message");
    }
}
