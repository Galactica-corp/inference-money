// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TokenPortal} from "../src/TokenPortal.sol";
import {CapturingInbox, CapturingOutbox, FAKE_ROLLUP_VERSION, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {StubRouter} from "./mocks/MockPortal.sol";

/// Always-on regressions for both initialize guards against the real portal: the fast, readable failure that still runs
/// when halmos does not. `FormalPortal.t.sol` proves the same guards over all arguments and callers.
contract PortalReinitTest is Test {
    address internal constant USDC = address(0xA11CE);
    bytes32 internal constant BRIDGE = bytes32(uint256(0x1111));
    address internal constant EVIL_TOKEN = address(0xDEAD);
    bytes32 internal constant EVIL_BRIDGE = bytes32(uint256(0x6666));

    function _registry() internal returns (FakeRegistry) {
        return new FakeRegistry(address(new FakeRollup(address(new CapturingInbox()), address(new CapturingOutbox()))));
    }

    function test_initializeIsOnceOnly() public {
        TokenPortal portal = new TokenPortal();
        FakeRegistry reg = _registry();
        StubRouter router = new StubRouter(address(portal), USDC);
        portal.initialize(address(reg), USDC, BRIDGE, address(router), FAKE_ROLLUP_VERSION);
        assertEq(address(portal.underlying()), USDC, "first init sets underlying");
        assertEq(portal.l2Bridge(), BRIDGE, "first init sets l2Bridge");
        assertEq(portal.router(), address(router), "first init sets router");
        assertEq(address(portal.rollup()), reg.getCanonicalRollup(), "first init derives the rollup");

        // Even the initializer cannot rebind: the canonical portal allows exactly this.
        FakeRegistry evil = _registry();
        address evilRouter = address(new StubRouter(address(portal), EVIL_TOKEN));
        vm.expectRevert(TokenPortal.AlreadyInitialized.selector);
        portal.initialize(address(evil), EVIL_TOKEN, EVIL_BRIDGE, evilRouter, FAKE_ROLLUP_VERSION);

        assertEq(address(portal.registry()), address(reg), "registry unchanged after rejected re-init");
        assertEq(address(portal.underlying()), USDC, "underlying unchanged after rejected re-init");
        assertEq(portal.l2Bridge(), BRIDGE, "l2Bridge unchanged after rejected re-init");
        assertEq(portal.router(), address(router), "router unchanged after rejected re-init");
    }

    /// Deploy and initialize are separate transactions: a front-run of the FIRST initialize must revert instead of
    /// binding an attacker registry whose outbox would authorize draining every deposit.
    function test_frontRunOfFirstInitializeReverts() public {
        TokenPortal portal = new TokenPortal();
        FakeRegistry evil = _registry();
        address evilRouter = address(new StubRouter(address(portal), EVIL_TOKEN));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(TokenPortal.NotInitializer.selector);
        portal.initialize(address(evil), EVIL_TOKEN, EVIL_BRIDGE, evilRouter, FAKE_ROLLUP_VERSION);

        assertEq(address(portal.registry()), address(0), "attacker bound a registry");
        portal.initialize(
            address(_registry()), USDC, BRIDGE, address(new StubRouter(address(portal), USDC)), FAKE_ROLLUP_VERSION
        );
        assertEq(address(portal.underlying()), USDC, "the deployer still initializes after the failed front-run");
    }

    /// The deploy puts the L2 side on the rollup its node serves, then initializes: a governance switch in between must
    /// leave the portal unbound rather than bound to a rollup the bridge does not live on.
    function test_initializeRefusesACanonicalRollupOfAnotherVersion() public {
        TokenPortal portal = new TokenPortal();
        FakeRegistry reg = _registry();
        uint256 deployedOn = FAKE_ROLLUP_VERSION;
        FakeRollup next = new FakeRollup(address(new CapturingInbox()), address(new CapturingOutbox()));
        next.setVersion(deployedOn + 1);
        reg.setCanonicalRollup(address(next));
        address router = address(new StubRouter(address(portal), USDC));

        vm.expectRevert(abi.encodeWithSelector(TokenPortal.RollupVersionMismatch.selector, deployedOn, deployedOn + 1));
        portal.initialize(address(reg), USDC, BRIDGE, router, deployedOn);
        assertEq(address(portal.registry()), address(0), "a refused initialize bound a registry");

        portal.initialize(address(reg), USDC, BRIDGE, router, deployedOn + 1);
        assertEq(address(portal.rollup()), address(next), "the slot stays open for the version actually canonical");
    }
}
