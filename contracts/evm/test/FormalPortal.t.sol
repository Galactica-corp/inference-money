// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";
import {TokenPortal} from "../src/TokenPortal.sol";
import {CapturingInbox, CapturingOutbox, FAKE_ROLLUP_VERSION, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {StubRouter, initializedPortal} from "./mocks/MockPortal.sol";
import {
    PortalWithoutCanonicalCheck,
    PortalWithoutCap,
    PortalWithoutDeadline,
    PortalWithoutDepositorCheck,
    PortalWithoutInitializerCheck,
    PortalWithoutInitOnce,
    PortalWithoutRecipientCheck,
    PortalWithoutRouterCheck,
    PortalWithoutVersionCheck,
    PortalWithoutZeroCheck
} from "./mocks/Mutants.sol";
import {ProofCanary} from "./mocks/ProofCanary.sol";
import {PlainERC20} from "./mocks/TestTokens.sol";

/// SYMBOLIC proofs for the portal's guards, run by halmos (`check_` prefix), not forge. Arguments are symbolic, so
/// each proof covers the whole input domain:
///
///   check_initializedBindingsCannotChange  — a second initialize never rebinds anything, the router included
///   check_initialize_rejectsNonInitializer — no caller but the deployer can make the first initialize
///   check_initialize_rejectsVersionMismatch — no first initialize binds a canonical rollup of another version than
///                                              the one its caller expects
///   check_deposit_rejectsAmountAboveU128   — no deposit above the L2 amount type reaches the Inbox
///   check_depositFor_rejectsNonRouter      — no caller but the bound router can name a depositor
///   check_depositPublic_rejectsOutOfFieldRecipient — no public deposit to a recipient above the field reaches the
///                                                     Inbox, directly or through the router
///   check_deposit_rejectsZeroAmount        — no zero deposit reaches the Inbox, publicly or through the router
///   check_deposit_rejectsStaleRollup       — once the registry's canonical rollup moves, no deposit reaches the
///                                             bound rollup's Inbox
///   check_depositPublic_rejectsBadRefund   — no public deposit names zero, the portal, the router, the token, the
///                                             Inbox or the Outbox as its refund address
///
/// Every proof asserts the exact revert selector: a bare `catch` would accept a fixture failing for its own reasons,
/// and assumes valid values for every guard that runs before the one it targets. Failures are signalled with assertions
/// only, because halmos cannot observe `revert(string)`. Every guard runs before any sha256, which halmos 0.3.3 cannot
/// model. Each forge canary runs its proof's body against a mutant with that one rule deleted and requires the body to
/// fail on that rule's assertion.
contract FormalPortalTest is ProofCanary {
    address internal constant UNDERLYING_A = address(0xA11CE);
    bytes32 internal constant BRIDGE_A = bytes32(uint256(0x1111));
    address internal constant UNDERLYING_B = address(0xBEEF);
    bytes32 internal constant BRIDGE_B = bytes32(uint256(0x2222));
    string internal constant STRANGER_DEPOSITED = "a stranger named a depositor";
    string internal constant ZERO_DEPOSITED = "a zero deposit succeeded";
    string internal constant STALE_DEPOSITED = "a deposit reached a rollup that is no longer canonical";
    string internal constant BAD_REFUND_DEPOSITED = "a public deposit named a refund address no return can leave";
    string internal constant EXPIRED_DEPOSITED = "an expired authorization deposited";
    string internal constant WRONG_VERSION_BOUND = "initialize bound a rollup of another version than expected";

    TokenPortal internal locked;
    StubRouter internal routerA;
    TokenPortal internal fresh;
    TokenPortal internal funded;
    PlainERC20 internal token;
    FakeRegistry internal regA;
    FakeRegistry internal regB;
    CapturingInbox internal inboxA;
    FakeRollup internal rollupB;

    function setUp() public {
        inboxA = new CapturingInbox();
        regA = new FakeRegistry(address(new FakeRollup(address(inboxA), address(new CapturingOutbox()))));
        rollupB = new FakeRollup(address(new CapturingInbox()), address(new CapturingOutbox()));
        regB = new FakeRegistry(address(rollupB));

        (locked, routerA) = initializedPortal(address(regA), UNDERLYING_A, BRIDGE_A);
        fresh = new TokenPortal();

        token = new PlainERC20("Tok", "TOK");
        (funded,) = initializedPortal(address(regA), address(token), BRIDGE_A);
        token.mint(address(this), type(uint256).max);
        token.approve(address(funded), type(uint256).max);
    }

    function check_initializedBindingsCannotChange(
        address candidateUnderlying,
        bytes32 candidateBridge,
        address candidateRouter,
        uint256 candidateVersion
    ) public {
        proveInitOnce(locked, candidateUnderlying, candidateBridge, candidateRouter, candidateVersion);
    }

    function check_initialize_rejectsNonInitializer(
        address caller,
        address candidateUnderlying,
        bytes32 candidateBridge,
        address candidateRouter,
        uint256 candidateVersion
    ) public {
        proveInitializerOnly(fresh, caller, candidateUnderlying, candidateBridge, candidateRouter, candidateVersion);
    }

    function check_initialize_rejectsVersionMismatch(uint256 expected) public {
        proveRejectsVersionMismatch(fresh, expected);
    }

    function check_deposit_rejectsAmountAboveU128(bytes32 to, uint256 amount, bytes32 secretHash) public {
        proveCap(funded, to, amount, secretHash);
    }

    function check_depositFor_rejectsNonRouter(
        address caller,
        address depositor,
        bytes32 to,
        uint256 amount,
        bytes32 secretHash
    ) public {
        proveRouterOnly(funded, caller, depositor, to, amount, secretHash);
    }

    function check_depositPublic_rejectsOutOfFieldRecipient(
        address depositor,
        bytes32 to,
        uint256 amount,
        bytes32 secretHash
    ) public {
        proveRecipientInField(funded, depositor, to, amount, secretHash);
    }

    function check_deposit_rejectsZeroAmount(address depositor, bytes32 to, bytes32 secretHash) public {
        proveRejectsZero(funded, depositor, to, secretHash);
    }

    function check_deposit_rejectsStaleRollup(
        address depositor,
        bytes32 to,
        uint256 amount,
        bytes32 secretHash,
        address canonical
    ) public {
        proveRejectsStaleRollup(funded, depositor, to, amount, secretHash, canonical);
    }

    function check_depositPublic_rejectsBadRefund(uint8 which, bytes32 to, uint256 amount, bytes32 secretHash) public {
        proveRejectsBadRefund(funded, which, to, amount, secretHash);
    }

    function check_depositPrivate_rejectsExpired(
        address depositor,
        uint256 amount,
        bytes32 secretHash,
        uint256 deadline,
        uint256 timestamp
    ) public {
        proveRejectsExpired(funded, depositor, amount, secretHash, deadline, timestamp, new bytes(65));
    }

    /// `p` was initialized against registry A by this contract, so the call clears the deployer-only guard and meets
    /// the init-once guard alone.
    function proveInitOnce(
        TokenPortal p,
        address candidateUnderlying,
        bytes32 candidateBridge,
        address candidateRouter,
        uint256 candidateVersion
    ) public {
        try p.initialize(address(regB), candidateUnderlying, candidateBridge, candidateRouter, candidateVersion) {
            assertTrue(false, "re-initialized an already-initialized portal");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.AlreadyInitialized.selector, "rejected for the wrong reason");
            _assertBoundToA(p);
        }
    }

    /// `p` is uninitialized and was deployed by this contract.
    function proveInitializerOnly(
        TokenPortal p,
        address caller,
        address candidateUnderlying,
        bytes32 candidateBridge,
        address candidateRouter,
        uint256 candidateVersion
    ) public {
        vm.assume(caller != address(this));
        vm.prank(caller);
        try p.initialize(address(regB), candidateUnderlying, candidateBridge, candidateRouter, candidateVersion) {
            assertTrue(false, "a non-initializer initialized the portal");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.NotInitializer.selector, "rejected for the wrong reason");
            assertEq(address(p.registry()), address(0), "a rejected initialize bound a registry");
            assertEq(p.router(), address(0), "a rejected initialize bound a router");
        }
    }

    /// `p` is uninitialized and was deployed by this contract; its router is valid, so only the version can refuse it.
    function proveRejectsVersionMismatch(TokenPortal p, uint256 expected) public {
        vm.assume(expected != rollupB.getVersion());
        address router = address(new StubRouter(address(p), UNDERLYING_B));
        try p.initialize(address(regB), UNDERLYING_B, BRIDGE_B, router, expected) {
            assertTrue(false, WRONG_VERSION_BOUND);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.RollupVersionMismatch.selector, "rejected for the wrong reason");
            assertEq(address(p.registry()), address(0), "a rejected initialize bound a registry");
        }
    }

    /// `p` is bound to registry A (so to `inboxA`) and may pull any amount from this contract. The private leg goes
    /// through the router: a direct private deposit checks its signature before the cap, which halmos cannot model
    /// (FundingAuthorization.t.sol pins the signed cap refusal).
    function proveCap(TokenPortal p, bytes32 to, uint256 amount, bytes32 secretHash) public {
        vm.assume(amount > type(uint128).max);
        uint256 sent = inboxA.sent();
        try p.depositToAztecPublic(address(this), to, amount, secretHash) {
            assertTrue(false, "public deposit above u128 succeeded");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.AmountExceedsL2Max.selector, "public: rejected for the wrong reason");
        }
        vm.prank(p.router());
        try p.depositToAztecPrivateFor(address(this), amount, secretHash) {
            assertTrue(false, "private deposit above u128 succeeded");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.AmountExceedsL2Max.selector, "private: rejected for the wrong reason");
        }
        assertEq(inboxA.sent(), sent, "a message was sent for an unclaimable amount");
    }

    /// `p` is bound to registry A (so to `inboxA`) and may pull any amount from this contract. Every other guard is
    /// satisfied, so the recipient guard is the only rule that can refuse it.
    function proveRecipientInField(TokenPortal p, address depositor, bytes32 to, uint256 amount, bytes32 secretHash)
        public
    {
        vm.assume(uint256(to) > Constants.MAX_FIELD_VALUE);
        vm.assume(amount != 0 && amount <= type(uint128).max);
        _assumeValidRefund(p, depositor);
        uint256 sent = inboxA.sent();
        uint256 reserve = p.underlying().balanceOf(address(p));
        try p.depositToAztecPublic(depositor, to, amount, secretHash) {
            assertTrue(false, "a public deposit to an out-of-field recipient succeeded");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.RecipientExceedsFieldMax.selector, "rejected for the wrong reason");
        }
        vm.prank(p.router());
        try p.depositToAztecPublicFor(depositor, to, amount, secretHash) {
            assertTrue(false, "a routed deposit to an out-of-field recipient succeeded");
        } catch (bytes memory reason) {
            assertEq(
                bytes4(reason), TokenPortal.RecipientExceedsFieldMax.selector, "routed: rejected for the wrong reason"
            );
        }
        assertEq(inboxA.sent(), sent, "a message was sent to a recipient no claim can name");
        assertEq(p.underlying().balanceOf(address(p)), reserve, "an unclaimable deposit moved funds");
    }

    /// `p` is bound to registry A (so to `inboxA`) and to a router other than `caller`.
    function proveRouterOnly(
        TokenPortal p,
        address caller,
        address depositor,
        bytes32 to,
        uint256 amount,
        bytes32 secretHash
    ) public {
        vm.assume(caller != p.router());
        uint256 sent = inboxA.sent();
        uint256 reserve = p.underlying().balanceOf(address(p));
        vm.prank(caller);
        try p.depositToAztecPublicFor(depositor, to, amount, secretHash) {
            assertTrue(false, STRANGER_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.NotRouter.selector, "public: rejected for the wrong reason");
        }
        vm.prank(caller);
        try p.depositToAztecPrivateFor(depositor, amount, secretHash) {
            assertTrue(false, STRANGER_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.NotRouter.selector, "private: rejected for the wrong reason");
        }
        assertEq(inboxA.sent(), sent, "a stranger's deposit sent a message");
        assertEq(p.underlying().balanceOf(address(p)), reserve, "a stranger's deposit moved funds");
    }

    /// `p` is bound to registry A (so to `inboxA`) and may pull any amount from this contract. The zero guard runs
    /// first, so nothing else needs assuming.
    function proveRejectsZero(TokenPortal p, address depositor, bytes32 to, bytes32 secretHash) public {
        uint256 sent = inboxA.sent();
        uint256 reserve = p.underlying().balanceOf(address(p));
        try p.depositToAztecPublic(depositor, to, 0, secretHash) {
            assertTrue(false, ZERO_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.ZeroAmount.selector, "public: rejected for the wrong reason");
        }
        vm.prank(p.router());
        try p.depositToAztecPrivateFor(depositor, 0, secretHash) {
            assertTrue(false, ZERO_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.ZeroAmount.selector, "routed: rejected for the wrong reason");
        }
        assertEq(inboxA.sent(), sent, "a zero deposit sent a message");
        assertEq(p.underlying().balanceOf(address(p)), reserve, "a zero deposit moved funds");
    }

    /// `p` is bound to registry A's rollup (so to `inboxA`) and may pull any amount from this contract; registry A then
    /// names any other rollup canonical. Every other guard is satisfied.
    function proveRejectsStaleRollup(
        TokenPortal p,
        address depositor,
        bytes32 to,
        uint256 amount,
        bytes32 secretHash,
        address canonical
    ) public {
        vm.assume(canonical != address(p.rollup()));
        vm.assume(amount != 0 && amount <= type(uint128).max);
        vm.assume(uint256(to) <= Constants.MAX_FIELD_VALUE);
        _assumeValidRefund(p, depositor);
        FakeRegistry(address(p.registry())).setCanonicalRollup(canonical);
        uint256 sent = inboxA.sent();
        uint256 reserve = p.underlying().balanceOf(address(p));
        try p.depositToAztecPublic(depositor, to, amount, secretHash) {
            assertTrue(false, STALE_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.RollupNotCanonical.selector, "public: rejected for the wrong reason");
        }
        vm.prank(p.router());
        try p.depositToAztecPublicFor(depositor, to, amount, secretHash) {
            assertTrue(false, STALE_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.RollupNotCanonical.selector, "routed: rejected for the wrong reason");
        }
        vm.prank(p.router());
        try p.depositToAztecPrivateFor(depositor, amount, secretHash) {
            assertTrue(false, STALE_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.RollupNotCanonical.selector, "private: rejected for the wrong reason");
        }
        assertEq(inboxA.sent(), sent, "a deposit messaged a rollup that is no longer canonical");
        assertEq(p.underlying().balanceOf(address(p)), reserve, "a refused deposit moved funds");
    }

    /// `p` is bound to registry A (so to `inboxA`) and may pull any amount from this contract. `which` picks zero, the
    /// portal, the router, the token, the Inbox, the Outbox or the registry; every guard before the refund address is
    /// satisfied.
    function proveRejectsBadRefund(TokenPortal p, uint8 which, bytes32 to, uint256 amount, bytes32 secretHash) public {
        vm.assume(amount != 0 && amount <= type(uint128).max);
        vm.assume(uint256(to) <= Constants.MAX_FIELD_VALUE);
        // A conditional, not an array: halmos cannot index memory by a symbolic offset.
        uint8 pick = which % 7;
        address depositor = pick == 0
            ? address(0)
            : pick == 1
                ? address(p)
                : pick == 2
                    ? p.router()
                    : pick == 3
                        ? address(p.underlying())
                        : pick == 4 ? address(p.inbox()) : pick == 5 ? address(p.outbox()) : address(p.registry());
        uint256 sent = inboxA.sent();
        uint256 reserve = p.underlying().balanceOf(address(p));
        try p.depositToAztecPublic(depositor, to, amount, secretHash) {
            assertTrue(false, BAD_REFUND_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.InvalidDepositor.selector, "public: rejected for the wrong reason");
        }
        vm.prank(p.router());
        try p.depositToAztecPublicFor(depositor, to, amount, secretHash) {
            assertTrue(false, BAD_REFUND_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.InvalidDepositor.selector, "routed: rejected for the wrong reason");
        }
        assertEq(inboxA.sent(), sent, "a deposit with an unusable refund address sent a message");
        assertEq(p.underlying().balanceOf(address(p)), reserve, "a refused deposit moved funds");
    }

    /// `p` is bound to registry A (so to `inboxA`) and may pull any amount from this contract. Expiry is checked before
    /// the signature, so any signature, valid or not, meets that rule alone.
    function proveRejectsExpired(
        TokenPortal p,
        address depositor,
        uint256 amount,
        bytes32 secretHash,
        uint256 deadline,
        uint256 timestamp,
        bytes memory signature
    ) public {
        vm.assume(deadline < timestamp);
        vm.warp(timestamp);
        uint256 sent = inboxA.sent();
        uint256 reserve = p.underlying().balanceOf(address(p));
        try p.depositToAztecPrivate(depositor, amount, secretHash, deadline, signature) {
            assertTrue(false, EXPIRED_DEPOSITED);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TokenPortal.AuthorizationExpired.selector, "rejected for the wrong reason");
        }
        assertEq(inboxA.sent(), sent, "an expired authorization sent a message");
        assertEq(p.underlying().balanceOf(address(p)), reserve, "an expired authorization moved funds");
    }

    function _assumeValidRefund(TokenPortal p, address depositor) internal view {
        vm.assume(depositor != address(0) && depositor != address(p) && depositor != p.router());
        vm.assume(
            depositor != address(p.underlying()) && depositor != address(p.inbox()) && depositor != address(p.outbox())
        );
        vm.assume(depositor != address(p.registry()));
    }

    function _assertBoundToA(TokenPortal p) internal view {
        FakeRollup rollupA = FakeRollup(regA.getCanonicalRollup());
        assertEq(address(p.registry()), address(regA), "registry rebound");
        assertEq(address(p.underlying()), UNDERLYING_A, "underlying rebound");
        assertEq(p.l2Bridge(), BRIDGE_A, "l2Bridge rebound");
        assertEq(p.router(), address(routerA), "router rebound");
        assertEq(address(p.rollup()), address(rollupA), "rollup rebound");
        assertEq(address(p.outbox()), rollupA.getOutbox(), "outbox rebound");
        assertEq(address(p.inbox()), rollupA.getInbox(), "inbox rebound");
        assertEq(p.rollupVersion(), rollupA.getVersion(), "rollupVersion rebound");
    }

    // ── Canaries (forge) ─────────────────────────────────────────────────────────────────

    function test_canary_initOnce_failsWithoutTheGuard() public {
        PortalWithoutInitOnce mutant = new PortalWithoutInitOnce();
        mutant.initialize(
            address(regA),
            UNDERLYING_A,
            BRIDGE_A,
            address(new StubRouter(address(mutant), UNDERLYING_A)),
            FAKE_ROLLUP_VERSION
        );
        address rebound = address(new StubRouter(address(mutant), UNDERLYING_B));
        _assertProofFails(
            abi.encodeCall(this.proveInitOnce, (mutant, UNDERLYING_B, BRIDGE_B, rebound, FAKE_ROLLUP_VERSION)),
            "re-initialized an already-initialized portal"
        );
    }

    function test_canary_initializerCheck_failsWithoutTheGuard() public {
        PortalWithoutInitializerCheck mutant = new PortalWithoutInitializerCheck();
        address router = address(new StubRouter(address(mutant), UNDERLYING_B));
        _assertProofFails(
            abi.encodeCall(
                this.proveInitializerOnly,
                (mutant, makeAddr("attacker"), UNDERLYING_B, BRIDGE_B, router, FAKE_ROLLUP_VERSION)
            ),
            "a non-initializer initialized the portal"
        );
    }

    function test_canary_u128Cap_failsWithoutTheGuard() public {
        TokenPortal mutant = _fundedMutant(new PortalWithoutCap());
        _assertProofFails(
            abi.encodeCall(this.proveCap, (mutant, bytes32(uint256(1)), uint256(type(uint128).max) + 1, bytes32(0))),
            "public deposit above u128 succeeded"
        );
    }

    function test_canary_recipient_failsWithoutTheGuard() public {
        TokenPortal mutant = _fundedMutant(new PortalWithoutRecipientCheck());
        _assertProofFails(
            abi.encodeCall(
                this.proveRecipientInField, (mutant, address(this), bytes32(type(uint256).max), 1e6, bytes32(0))
            ),
            "a public deposit to an out-of-field recipient succeeded"
        );
    }

    /// The stranger holds and approves the amount, so with the guard deleted nothing else stops the deposit.
    function test_canary_routerCheck_failsWithoutTheGuard() public {
        PortalWithoutRouterCheck mutant = new PortalWithoutRouterCheck();
        mutant.initialize(
            address(regA),
            address(token),
            BRIDGE_A,
            address(new StubRouter(address(mutant), address(token))),
            FAKE_ROLLUP_VERSION
        );
        address stranger = makeAddr("stranger");
        token.transfer(stranger, 2e6);
        vm.prank(stranger);
        token.approve(address(mutant), 2e6);
        _assertProofFails(
            abi.encodeCall(
                this.proveRouterOnly, (mutant, stranger, makeAddr("victim"), bytes32(uint256(1)), 1e6, bytes32(0))
            ),
            STRANGER_DEPOSITED
        );
    }

    function test_canary_zeroAmount_failsWithoutTheGuard() public {
        TokenPortal mutant = _fundedMutant(new PortalWithoutZeroCheck());
        _assertProofFails(
            abi.encodeCall(this.proveRejectsZero, (mutant, address(this), bytes32(uint256(1)), bytes32(0))),
            ZERO_DEPOSITED
        );
    }

    function test_canary_staleRollup_failsWithoutTheGuard() public {
        TokenPortal mutant = _fundedMutant(new PortalWithoutCanonicalCheck());
        _assertProofFails(
            abi.encodeCall(
                this.proveRejectsStaleRollup,
                (mutant, address(this), bytes32(uint256(1)), 1e6, bytes32(0), address(rollupB))
            ),
            STALE_DEPOSITED
        );
    }

    function test_canary_version_failsWithoutTheGuard() public {
        TokenPortal mutant = new PortalWithoutVersionCheck();
        _assertProofFails(
            abi.encodeCall(this.proveRejectsVersionMismatch, (mutant, FAKE_ROLLUP_VERSION + 1)), WRONG_VERSION_BOUND
        );
    }

    function test_canary_badRefund_failsWithoutTheGuard() public {
        TokenPortal mutant = _fundedMutant(new PortalWithoutDepositorCheck());
        _assertProofFails(
            abi.encodeCall(this.proveRejectsBadRefund, (mutant, 0, bytes32(uint256(1)), 1e6, bytes32(0))),
            BAD_REFUND_DEPOSITED
        );
    }

    /// With the expiry rule deleted, a valid signature carries an expired authorization all the way to the Inbox.
    function test_canary_expiry_failsWithoutTheGuard() public {
        TokenPortal mutant = _fundedMutant(new PortalWithoutDeadline());
        uint256 key = 0xA11CE;
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest = mutant.fundingAuthorizationDigest(vm.addr(key), address(this), 1e6, bytes32(0), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        _assertProofFails(
            abi.encodeCall(
                this.proveRejectsExpired,
                (mutant, vm.addr(key), 1e6, bytes32(0), deadline, deadline + 1, abi.encodePacked(r, s, v))
            ),
            EXPIRED_DEPOSITED
        );
    }

    /// A one-unit deposit lands: the zero proof refuses exactly zero, not small amounts.
    function test_canary_oneUnitDeposits() public {
        uint256 sent = inboxA.sent();
        funded.depositToAztecPublic(address(this), bytes32(uint256(1)), 1, bytes32(0));
        assertEq(inboxA.sent(), sent + 1);
    }

    /// The canonical-rollup refusal is the registry's answer alone: naming the bound rollup again re-opens deposits.
    function test_canary_canonicalAgainDeposits() public {
        FakeRollup bound = FakeRollup(address(funded.rollup()));
        regA.setCanonicalRollup(address(rollupB));
        vm.expectRevert(TokenPortal.RollupNotCanonical.selector);
        funded.depositToAztecPublic(address(this), bytes32(uint256(1)), 1e6, bytes32(0));
        regA.setCanonicalRollup(address(bound));
        uint256 sent = inboxA.sent();
        funded.depositToAztecPublic(address(this), bytes32(uint256(1)), 1e6, bytes32(0));
        assertEq(inboxA.sent(), sent + 1);
    }

    /// Any refund address but the seven refused ones lands, the depositor's own or a third party's.
    function test_canary_anyOtherRefundAddressDeposits() public {
        uint256 sent = inboxA.sent();
        funded.depositToAztecPublic(makeAddr("refund"), bytes32(uint256(1)), 1e6, bytes32(0));
        assertEq(inboxA.sent(), sent + 1);
    }

    /// A mutant bound to registry A (so to `inboxA`) over `token`, which this contract has approved it to pull.
    function _fundedMutant(TokenPortal mutant) internal returns (TokenPortal) {
        mutant.initialize(
            address(regA),
            address(token),
            BRIDGE_A,
            address(new StubRouter(address(mutant), address(token))),
            FAKE_ROLLUP_VERSION
        );
        token.approve(address(mutant), type(uint256).max);
        return mutant;
    }

    /// Registry B binds every field of a fresh portal: the init-once proof never reaches B on a passing run, so this
    /// is what says B is a working registry rather than an untested one.
    function test_canary_registryBBindsAFreshPortal() public {
        address router = address(new StubRouter(address(fresh), UNDERLYING_B));
        fresh.initialize(address(regB), UNDERLYING_B, BRIDGE_B, router, FAKE_ROLLUP_VERSION);
        assertEq(address(fresh.registry()), address(regB), "registry");
        assertEq(address(fresh.underlying()), UNDERLYING_B, "underlying");
        assertEq(fresh.l2Bridge(), BRIDGE_B, "l2Bridge");
        assertEq(fresh.router(), router, "router");
        assertEq(address(fresh.rollup()), address(rollupB), "rollup");
        assertEq(address(fresh.outbox()), rollupB.getOutbox(), "outbox");
        assertEq(address(fresh.inbox()), rollupB.getInbox(), "inbox");
        assertEq(fresh.rollupVersion(), rollupB.getVersion(), "rollupVersion");
    }

    /// The largest field element still deposits: the recipient proof's assumption is the only thing excluding success.
    function test_canary_fieldMaxRecipientDeposits() public {
        uint256 sent = inboxA.sent();
        funded.depositToAztecPublic(address(this), bytes32(Constants.MAX_FIELD_VALUE), 1e6, bytes32(0));
        assertEq(inboxA.sent(), sent + 1);
    }

    /// Exactly u128 max still deposits: the cap proof's assumption is the only thing excluding success.
    function test_canary_u128MaxDeposits() public {
        uint256 sent = inboxA.sent();
        funded.depositToAztecPublic(address(this), bytes32(uint256(1)), type(uint128).max, bytes32(0));
        assertEq(inboxA.sent(), sent + 1);
    }

    /// The bound router does deposit for someone else: the router proof's assumption is the only thing excluding
    /// success.
    function test_canary_theRouterDepositsFor() public {
        address router = funded.router();
        token.transfer(router, 1e6);
        vm.startPrank(router);
        token.approve(address(funded), 1e6);
        uint256 sent = inboxA.sent();
        funded.depositToAztecPrivateFor(makeAddr("signer"), 1e6, bytes32(0));
        vm.stopPrank();
        assertEq(inboxA.sent(), sent + 1);
    }
}
