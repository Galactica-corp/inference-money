// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {Handlers} from "./handlers/Handlers.sol";
import {TokenPortal} from "../../src/TokenPortal.sol";
import {ModalUsdc} from "./mocks/ModalUsdc.sol";

/// @notice Contract to be used for quick testing with Foundry
contract FoundryTester is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    function setUp() public {
        setup();
    }

    // forge test --match-test test_sequence -vvv
    function test_sequence() public {
        // Add here call sequence to Handler's functions to reproduce failing property
    }

    /// Harness smoke: every lifecycle leg succeeds once and lands in the model.
    function test_smoke_lifecycle() public {
        tokenPortal_depositToAztecPublic_clamped(0, 5e6, bytes32(uint256(1)), address(0));
        tokenPortal_depositToAztecPrivate_clamped(7e6, bytes32(uint256(2)));
        permit2DepositRouter_deposit_clamped(3e6, 1, bytes32(uint256(3)), false, 0);
        permit2DepositRouter_deposit_clamped(4e6, 0, bytes32(uint256(4)), true, 0);
        assertEq(ghosts.depositCount, 4, "deposits recorded");
        assertEq(ghosts.misnamedMessages, 0, "misnamed");

        l2_claim(0, 0);
        l2_claim(0, 1);
        l2_returnDeposit(0);
        l2_exit(0, 1e6, address(0), true, address(1));
        l2_exit(1, 2e6, address(1), false, address(0));
        l2_proveEpoch(2, 0);
        l2_proveEpoch(0, 5);
        assertEq(provenUnpaidExits.length, 3, "three proven exits");

        tokenPortal_withdraw_replay(0);
        tokenPortal_withdraw_tampered(0, 0, 9);
        tokenPortal_withdraw_tampered(0, 1, 9);
        tokenPortal_withdraw_tampered(0, 2, 9);
        tokenPortal_withdraw_tampered(0, 3, 9);
        tokenPortal_withdraw_wrongCaller(0, 1);
        tokenPortal_withdraw_clamped(0);
        tokenPortal_withdraw_clamped(0);
        tokenPortal_withdraw_clamped(0);
        assertEq(ghosts.withdrawCount, 3, "three payouts");
        tokenPortal_withdraw_replay(0);
        tokenPortal_withdraw_replay(1);

        tokenPortal_secondary(0, 1e6, bytes32(0), address(0));
        tokenPortal_secondary(1, 1e6, bytes32(0), address(0));
        tokenPortal_secondary(2, 0, bytes32(uint256(9)), address(0));
        tokenPortal_secondary(3, 0, bytes32(uint256(9)), address(0));
        tokenPortal_secondary(4, 0, bytes32(0), address(1));
        permit2DepositRouter_secondary(1e6, false, false, 0);
        permit2DepositRouter_secondary(1e6, true, true, 1);
        permit2DepositRouter_deposit_malformed(0, 1, bytes32(0));
        permit2DepositRouter_deposit_malformed(1, 1, bytes32(0));
        permit2DepositRouter_deposit_malformed(2, 1, bytes32(0));
        permit2DepositRouter_deposit_malformed(3, 1, bytes32(0));
        permit2DepositRouter_deposit_malformed(4, 1, bytes32(0));
        tokenPortal_deposit_overU128(true);
        tokenPortal_depositToAztecPublic_fieldBoundary(1e6, true);
        env_secondary(5, 1e6, 0, address(0));

        assertEq(
            ghosts.unbackedPayouts + ghosts.replayedPayouts + ghosts.tamperedPayouts + ghosts.wrongCallerPayouts
                + ghosts.strangerNamedDepositor + ghosts.reinitialized + ghosts.misboundRouter
                + ghosts.permit2RejectBypassed + ghosts.boundaryAccepted + ghosts.selfPayoutAccepted,
            0,
            "a hostile action succeeded"
        );
        assertEq(
            usdc.balanceOf(address(portal)),
            ghosts.deposited + ghosts.portalDonated - ghosts.withdrawn,
            "reserve != deposits + donations - withdrawals"
        );
        assertEq(
            usdc.balanceOf(address(portal)),
            ghosts.pendingDepositAmount + ghosts.l2Supply + ghosts.unpaidExitAmount + ghosts.portalDonated,
            "reserve != L2 obligations"
        );
    }

    /// Harness regression: two identical returns proven as sibling leaves make a "moved leaf index" a genuine payout
    /// of the sibling's message, which the tamper handler must not count as tampering.
    function test_harness_tamperSkipsIdenticalSibling() public {
        tokenPortal_depositToAztecPublic_clamped(0, 5e6, bytes32(0), address(0));
        tokenPortal_depositToAztecPrivate_clamped(5e6, bytes32(0));
        l2_returnDeposit(0);
        l2_returnDeposit(0);
        l2_proveEpoch(1, 0);
        assertEq(provenUnpaidExits.length, 2, "two proven sibling exits");
        tokenPortal_withdraw_tampered(0, 3, 0);
        tokenPortal_withdraw_tampered(1, 3, 0);
        assertEq(ghosts.tamperedPayouts, 0, "a genuine sibling payout counted as tampering");
        tokenPortal_withdraw_clamped(0);
        tokenPortal_withdraw_clamped(0);
        assertEq(ghosts.withdrawCount, 2, "both identical exits pay once each");
        tokenPortal_withdraw_replay(0);
        tokenPortal_withdraw_replay(1);
        assertEq(ghosts.replayedPayouts, 0, "replay");
    }

    /// GL-24 is not vacuous: an armed re-entry skips a donation, then fires inside a guarded deposit and is refused by
    /// the guard itself, for the portal and for the router.
    function test_harness_reentryRefusedByTheGuard() public {
        env_secondary(4, 0, 0, address(0));
        env_secondary(0, 1e6, 0, address(0));
        assertEq(usdc.hookFired(), 0, "fired on an unguarded donation");
        tokenPortal_depositToAztecPrivate_clamped(1e6, bytes32(uint256(1)));
        env_secondary(4, 1, 0, address(0));
        permit2DepositRouter_deposit_clamped(1e6, 0, bytes32(uint256(2)), true, 0);
        assertEq(usdc.hookFired(), 2, "both hooks fired");
        assertEq(usdc.hookReentrySucceeded(), 0, "a re-entry was not refused by the guard");
    }

    /// GL-29 and GL-32 under a rollup upgrade: deposits stop (liveness is not owed then), and a proven exit still
    /// pays through the bound Outbox.
    function test_harness_staleRollupStopsDepositsNotWithdrawals() public {
        tokenPortal_depositToAztecPublic_clamped(0, 5e6, bytes32(uint256(1)), address(0));
        l2_returnDeposit(0);
        l2_proveEpoch(0, 0);
        env_secondary(6, 0, 0, address(0));
        _tokenPortal_freshBinding(address(0));
        adv_depositLiveness(0, 1e6, false);
        vm.expectRevert(TokenPortal.RollupNotCanonical.selector);
        this.tokenPortal_depositToAztecPublic_clamped(0, 1e6, bytes32(uint256(2)), address(0));
        tokenPortal_withdraw_clamped(0);
        assertEq(ghosts.withdrawCount, 1, "the exit paid after the switch");
        property_depositsLive();
        property_staleRollupRefusesDeposits();
        env_secondary(6, 1, 0, address(0));
        adv_depositLiveness(0, 1e6, false);
        assertEq(ghosts.depositCount, 2, "deposits resume once the rollup is canonical again");
    }

    /// The signed-path probes refuse with their own selectors: a periphery-submitted deposit names its signer, its
    /// authorization cannot be replayed or used by another submitter, foreign signatures and unusable refund
    /// addresses are refused.
    function test_harness_signedPathProbes() public {
        tokenPortal_depositToAztecPrivate_forSigner(3e6, bytes32(uint256(7)), 1);
        assertEq(ghosts.depositCount, 1, "the periphery's deposit landed");
        tokenPortal_authorizationMisuse(false, 0);
        tokenPortal_authorizationMisuse(true, 1);
        tokenPortal_foreignSignature(false, 1e6, 1);
        tokenPortal_foreignSignature(true, 1e6, 1);
        tokenPortal_depositToAztecPublic_badRefund(0, 1e6, 0);
        tokenPortal_depositToAztecPublic_badRefund(1, 1e6, 0);
        tokenPortal_depositToAztecPublic_badRefund(2, 1e6, 0);
        assertEq(
            ghosts.authorizationMisused + ghosts.foreignSignatureAccepted + ghosts.boundaryAccepted
                + ghosts.misnamedMessages,
            0,
            "a signed-path probe was not refused for its own reason"
        );
    }

    /// The real-Permit2, deadline, rollback, refund and fee-mode probes reach their checks: each branch shows its
    /// effect, not only zero counters.
    function test_harness_permit2EdgeAndFeeProbes() public {
        tokenPortal_depositToAztecPublic_clamped(0, 5e6, bytes32(uint256(1)), address(1));
        assertTrue(depositMsgs[0].depositor == actors[1] && actors[1] != actor, "the refund names another actor");

        permit2DepositRouter_deposit_clamped(3e6, 1, bytes32(uint256(3)), false, 7);
        assertTrue(_nonceUsed(actor, 7), "Permit2 spent the signed nonce");
        uint256 sent = inbox.sent();
        permit2DepositRouter_secondary(1e6, true, false, 0);
        permit2DepositRouter_secondary(1e6, false, true, 1);
        permit2DepositRouter_deposit_malformed(4, 2e6, bytes32(0));
        permit2DepositRouter_digest(type(uint256).max, bytes32(type(uint256).max), bytes32(0), true, 1 << 200, 0);
        assertEq(inbox.sent(), sent, "a refused router deposit messaged the Inbox");
        assertTrue(permitNonce[actor] == 2 && !_nonceUsed(actor, 0) && !_nonceUsed(actor, 1), "a refusal spent a nonce");

        uint256 count = ghosts.depositCount;
        adv_deadlineEdge(false, true, false, 4e6);
        adv_deadlineEdge(true, false, false, 4e6);
        adv_deadlineEdge(true, true, false, 4e6);
        assertEq(ghosts.depositCount, count + 3, "a deposit at its deadline was refused");
        adv_deadlineEdge(false, true, true, 4e6);
        adv_deadlineEdge(true, true, true, 4e6);
        assertEq(ghosts.depositCount, count + 3, "a past deadline deposited");

        tokenPortal_authorizationRollback(6e6, bytes32(uint256(9)));
        Authorization memory a = lastAuthorization;
        bytes32 digest = portal.fundingAuthorizationDigest(a.depositor, a.submitter, a.amount, a.secretHash, a.deadline);
        assertTrue(ghosts.depositCount == count + 4 && portal.authorizationUsed(digest), "the retry did not deposit");

        usdc.setMode(ModalUsdc.Mode.SenderSurcharge);
        adv_depositLiveness(0, 5e6, false);
        adv_depositLiveness(1, 5e6, false);
        adv_depositLiveness(2, 5e6, false);
        assertEq(ghosts.depositCount, count + 6, "surcharged direct deposits did not land, or a router one ran");
        usdc.setMode(ModalUsdc.Mode.FeeOnTransfer);
        l2_returnDeposit(0);
        l2_proveEpoch(0, 0);
        tokenPortal_withdraw_clamped(0);
        assertEq(ghosts.withdrawCount, 1, "a withdraw under a recipient fee did not pay");

        assertEq(
            ghosts.permit2RejectBypassed + ghosts.boundaryAccepted + ghosts.depositLivenessBroken
                + ghosts.authorizationRollbackBroken + ghosts.misnamedMessages + ghosts.payableExitStuck,
            0,
            "a probe misfired"
        );
    }

    /// GL-26: the portal caps each deposit at u128, not the running total, so only the mock supply cap keeps a
    /// max-amount deposit followed by any other within u128.
    function test_harness_mockSupplyKeepsLiabilitiesInU128() public {
        tokenPortal_depositToAztecPublic_maxAmount(0, bytes32(uint256(1)));
        assertGt(ghosts.pendingDepositAmount, type(uint128).max / 2, "the max-amount deposit landed");
        vm.expectRevert();
        this.tokenPortal_depositToAztecPrivate_clamped(MAX_REALISTIC_AMOUNT - 1, bytes32(uint256(2)));
        property_l2LiabilitiesFitU128();
    }
}
