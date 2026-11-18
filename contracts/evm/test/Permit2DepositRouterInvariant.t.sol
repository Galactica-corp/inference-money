// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";

import {Permit2DepositRouter} from "../src/Permit2DepositRouter.sol";
import {TokenPortal} from "../src/TokenPortal.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {ITokenPortal} from "../src/interfaces/ITokenPortal.sol";
import {CapturingInbox, CapturingOutbox, FAKE_ROLLUP_VERSION, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockUsdc} from "./mocks/MockUsdc.sol";

/// Cross-call invariants for the router over the real portal. A handler drives randomized deposits (valid and
/// malformed), donations and Permit2 rejections from several actors; after every sequence:
///
///   R1  the router holds exactly the donations it was sent;
///   R2  the portal received exactly Σ(successful deposit amounts), and one Inbox message each;
///   R3  the router's allowance to the portal is zero between calls.
contract Permit2DepositRouterInvariantTest is Test {
    RouterHandler internal handler;

    function setUp() public {
        handler = new RouterHandler();
        targetContract(address(handler));
    }

    function invariant_routerHoldsExactlyTheDonations() public view {
        assertEq(handler.usdc().balanceOf(address(handler.router())), handler.ghostDonated(), "router != donations");
    }

    function invariant_portalReceivedExactlyTheDeposits() public view {
        assertEq(handler.usdc().balanceOf(address(handler.portal())), handler.ghostDeposited(), "portal != deposits");
        assertEq(handler.inbox().sent(), handler.ghostDepositCount(), "messages != deposits");
    }

    function invariant_noStandingAllowance() public view {
        assertEq(
            handler.usdc().allowance(address(handler.router()), address(handler.portal())), 0, "standing allowance"
        );
    }
}

contract RouterHandler is StdUtils {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockUsdc public usdc;
    MockPermit2 public permit2;
    CapturingInbox public inbox;
    TokenPortal public portal;
    Permit2DepositRouter public router;
    /// Key-held, so their private deposits pass the router's key-holder check.
    address[3] private actors = [vm.addr(0xA1), vm.addr(0xA2), vm.addr(0xA3)];
    mapping(address actor => uint256) private keys;

    uint256 public ghostDeposited;
    uint256 public ghostDonated;
    uint256 public ghostDepositCount;

    constructor() {
        usdc = new MockUsdc();
        permit2 = new MockPermit2();
        inbox = new CapturingInbox();
        portal = new TokenPortal();
        router = new Permit2DepositRouter(ISignatureTransfer(address(permit2)), ITokenPortal(address(portal)), usdc);
        portal.initialize(
            address(new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox()))))),
            address(usdc),
            bytes32(uint256(0x4B)),
            address(router),
            FAKE_ROLLUP_VERSION
        );
        for (uint256 i = 0; i < actors.length; i++) {
            keys[actors[i]] = 0xA1 + i;
            vm.prank(actors[i]);
            usdc.approve(address(permit2), type(uint256).max);
        }
    }

    /// Well-formed deposits must succeed; the ghost moves only on success.
    function deposit(uint256 actorSeed, uint256 amount, bool isPrivate, bytes32 recipient) external {
        amount = bound(amount, 1, type(uint128).max);
        if (!isPrivate) recipient = bytes32(bound(uint256(recipient), 1, Constants.MAX_FIELD_VALUE));
        address actor = actors[actorSeed % actors.length];
        usdc.mint(actor, amount);
        if (isPrivate) recipient = bytes32(0);
        bytes memory signature = _signature(actor, amount, recipient, isPrivate);
        vm.prank(actor);
        router.deposit(amount, recipient, bytes32(0), isPrivate, 0, 1, signature);
        ghostDeposited += amount;
        ghostDepositCount++;
    }

    /// Arbitrary, likely malformed intents: whatever the router does with them, the invariants must hold.
    function depositRaw(uint256 actorSeed, uint256 amount, bytes32 recipient, bool isPrivate) external {
        address actor = actors[actorSeed % actors.length];
        usdc.mint(actor, bound(amount, 0, type(uint128).max));
        bytes memory signature = _signature(actor, amount, recipient, isPrivate);
        vm.prank(actor);
        try router.deposit(amount, recipient, bytes32(0), isPrivate, 0, 1, signature) {
            ghostDeposited += amount;
            ghostDepositCount++;
        } catch {}
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, type(uint128).max);
        usdc.mint(address(router), amount);
        ghostDonated += amount;
    }

    function rejectedPermit(uint256 actorSeed, uint256 amount) external {
        amount = bound(amount, 1, type(uint128).max);
        address actor = actors[actorSeed % actors.length];
        usdc.mint(actor, amount);
        permit2.setReject(true);
        vm.prank(actor);
        try router.deposit(amount, bytes32(uint256(1)), bytes32(0), false, 0, 1, hex"") {} catch {}
        permit2.setReject(false);
    }

    /// The actor's own signature over the router's digest; computed before the prank its digest read would consume.
    function _signature(address actor, uint256 amount, bytes32 recipient, bool isPrivate)
        private
        view
        returns (bytes memory)
    {
        bytes32 digest = router.permitDigest(amount, recipient, bytes32(0), isPrivate, 0, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[actor], digest);
        return abi.encodePacked(r, s, v);
    }
}
