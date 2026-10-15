// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {TokenPortal} from "../src/TokenPortal.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {MockUsdc} from "./mocks/MockUsdc.sol";
import {StubRouter, initializedPortal} from "./mocks/MockPortal.sol";

/// Content-hash ROUNDTRIP fuzzing for the real portal: for arbitrary inputs, the hash committed into the L1<>L2
/// message must equal an INDEPENDENT model (`sha256(preimage) >> 8`, computed without the Aztec Hash library the
/// portal itself uses, which would make the assertion a tautology). Deposits name their depositor every way the
/// portal allows: as a direct private deposit's caller, as a direct public deposit's refund address, and as the
/// router's argument. The keystone pins five points;
/// this covers every address and the whole u128 amount range the L2 side accepts.
contract PortalRoundtripFuzzTest is Test {
    bytes32 internal constant BRIDGE = bytes32(uint256(0x1111));
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    CapturingInbox internal inbox;
    CapturingOutbox internal outbox;
    TokenPortal internal portal;
    StubRouter internal router;
    MockUsdc internal usdc;

    function _model(bytes memory preimage) internal pure returns (bytes32) {
        return bytes32(uint256(sha256(preimage)) >> 8);
    }

    function setUp() public {
        inbox = new CapturingInbox();
        outbox = new CapturingOutbox();
        usdc = new MockUsdc();
        (portal, router) = initializedPortal(
            address(new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))))), address(usdc), BRIDGE
        );
    }

    /// Funds and approves whoever pays the deposit: the depositor itself, or the router naming it.
    function _payer(bool viaRouter, address depositor, uint256 amount) internal returns (address payer) {
        payer = viaRouter ? address(router) : depositor;
        vm.assume(payer != address(0) && payer != address(portal));
        assumeNotForgeAddress(payer);
        usdc.mint(payer, amount);
        vm.prank(payer);
        usdc.approve(address(portal), amount);
    }

    function testFuzz_depositPublic_contentHashMatchesIndependentModel(
        bool viaRouter,
        address depositor,
        bytes32 to,
        uint256 amount,
        bytes32 secret
    ) public {
        amount = bound(amount, 1, type(uint128).max);
        to = bytes32(bound(uint256(to), 0, Constants.MAX_FIELD_VALUE));
        vm.assume(depositor != address(0) && depositor != address(portal) && depositor != address(router));
        vm.assume(depositor != address(usdc) && depositor != address(inbox) && depositor != address(outbox));
        vm.assume(depositor != address(portal.registry()));
        address payer = _payer(viaRouter, depositor, amount);
        vm.prank(payer);
        if (viaRouter) portal.depositToAztecPublicFor(depositor, to, amount, secret);
        else portal.depositToAztecPublic(depositor, to, amount, secret);

        bytes memory preimage =
            abi.encodeWithSignature("mint_to_public(bytes32,uint256,address)", to, amount, depositor);
        assertEq(inbox.lastContentHash(), _model(preimage), "public content hash drifted");
        assertEq(inbox.lastSecretHash(), secret, "secret hash not forwarded");
        assertEq(inbox.lastVersion(), portal.rollupVersion(), "rollup version not forwarded");
        assertEq(inbox.lastBridge(), BRIDGE, "l2Bridge actor mismatch");
    }

    /// A direct deposit's depositor is the key holder of `key`, submitting its own authorization.
    function testFuzz_depositPrivate_contentHashMatchesIndependentModel(
        bool viaRouter,
        address depositor,
        uint256 key,
        uint256 amount,
        bytes32 secret
    ) public {
        amount = bound(amount, 1, type(uint128).max);
        bytes memory signature;
        if (!viaRouter) {
            key = bound(key, 1, SECP256K1_N - 1);
            depositor = vm.addr(key);
            bytes32 digest = portal.fundingAuthorizationDigest(depositor, depositor, amount, secret, block.timestamp);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
            signature = abi.encodePacked(r, s, v);
        }
        address payer = _payer(viaRouter, depositor, amount);
        vm.prank(payer);
        if (viaRouter) portal.depositToAztecPrivateFor(depositor, amount, secret);
        else portal.depositToAztecPrivate(depositor, amount, secret, block.timestamp, signature);

        bytes memory preimage = abi.encodeWithSignature("mint_to_private(uint256,address)", amount, depositor);
        assertEq(inbox.lastContentHash(), _model(preimage), "private content hash drifted");
        assertEq(inbox.lastSecretHash(), secret, "secret hash not forwarded");
    }

    function testFuzz_withdraw_messageReconstructionMatchesIndependentModel(
        address recipient,
        uint256 amount,
        bool withCaller,
        address callerOnL1
    ) public {
        amount = bound(amount, 1, type(uint128).max);
        vm.assume(recipient != address(0) && recipient != address(portal));
        usdc.mint(address(portal), amount);
        // The capturing outbox authorizes any caller, so any caller may drive the reconstruction.
        address caller = withCaller ? callerOnL1 : address(0);
        vm.prank(caller);
        portal.withdraw(recipient, amount, withCaller, Epoch.wrap(7), 3, 42, new bytes32[](0));

        DataStructures.L2ToL1Msg memory m = outbox.lastMsg();
        bytes memory preimage = abi.encodeWithSignature("withdraw(address,uint256,address)", recipient, amount, caller);
        assertEq(m.content, _model(preimage), "withdraw content drifted");
        assertEq(m.sender.actor, BRIDGE, "sender actor != l2Bridge");
        assertEq(m.sender.version, portal.rollupVersion(), "sender version != pinned rollup version");
        assertEq(m.recipient.actor, address(portal), "recipient actor != portal");
        assertEq(m.recipient.chainId, block.chainid, "recipient chain id mismatch");
    }
}
