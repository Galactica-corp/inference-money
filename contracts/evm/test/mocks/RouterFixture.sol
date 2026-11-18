// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {TokenPortal} from "../../src/TokenPortal.sol";
import {Permit2DepositRouter} from "../../src/Permit2DepositRouter.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {ITokenPortal} from "../../src/interfaces/ITokenPortal.sol";
import {CapturingInbox, CapturingOutbox, FAKE_ROLLUP_VERSION, FakeRegistry, FakeRollup} from "./AztecFakes.sol";
import {MockPermit2} from "./MockPermit2.sol";

/// The router over a REAL `TokenPortal` whose Inbox message is captured: deposits are observed through the portal's
/// balance and `lastMintWas*`, which require the message to name `user`, the signer. Permit2 is the recording mock,
/// which checks no signature; the router's own key-holder check does, and the Sepolia fork suite drives the real one.
abstract contract RouterFixture is Test {
    bytes32 internal constant L2_BRIDGE = bytes32(uint256(0xB41D6E));
    bytes32 internal constant RECIPIENT = bytes32(uint256(0x1234));
    bytes32 internal constant SECRET_HASH = bytes32(uint256(0x5EC7E7));

    address internal user = makeAddr("user");
    /// forge-std derives `makeAddr(name)` from this key.
    uint256 internal userKey = uint256(keccak256("user"));
    MockPermit2 internal permit2;
    CapturingInbox internal inbox;
    CapturingOutbox internal outbox;
    FakeRegistry internal registry;
    TokenPortal internal portal;
    Permit2DepositRouter internal router;
    IERC20 internal token;

    /// Deploys the stack over `token_`, which must already exist, in the deploy order: portal, router, then the
    /// portal's initialize naming the router. The user approves Permit2 like a real holder.
    function _deployStack(IERC20 token_) internal {
        token = token_;
        permit2 = new MockPermit2();
        inbox = new CapturingInbox();
        outbox = new CapturingOutbox();
        registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(outbox))));
        portal = new TokenPortal();
        router = new Permit2DepositRouter(ISignatureTransfer(address(permit2)), ITokenPortal(address(portal)), token_);
        portal.initialize(address(registry), address(token_), L2_BRIDGE, address(router), FAKE_ROLLUP_VERSION);
        vm.prank(user);
        token_.approve(address(permit2), type(uint256).max);
    }

    function _deposit(uint256 amount, bool isPrivate) internal returns (bytes32 key, uint256 index) {
        bytes32 recipient = isPrivate ? bytes32(0) : RECIPIENT;
        bytes memory signature = _permitSignature(userKey, amount, recipient, isPrivate, 0, 1);
        vm.prank(user);
        return router.deposit(amount, recipient, SECRET_HASH, isPrivate, 0, 1, signature);
    }

    /// `key`'s signature over the router's Permit2 digest for SECRET_HASH. Computed before any `prank` or
    /// `expectRevert`, which its digest read would otherwise consume.
    function _permitSignature(
        uint256 key,
        uint256 amount,
        bytes32 recipient,
        bool isPrivate,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = router.permitDigest(amount, recipient, SECRET_HASH, isPrivate, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Independent model of Aztec's `sha256ToField`: the top byte is dropped, so a field element always fits.
    function _model(bytes memory preimage) internal pure returns (bytes32) {
        return bytes32(uint256(sha256(preimage)) >> 8);
    }

    function lastMintWasPublic(bytes32 to, uint256 amount) internal view returns (bool) {
        return inbox.lastContentHash()
            == _model(abi.encodeWithSignature("mint_to_public(bytes32,uint256,address)", to, amount, user));
    }

    function lastMintWasPrivate(uint256 amount) internal view returns (bool) {
        return
            inbox.lastContentHash() == _model(abi.encodeWithSignature("mint_to_private(uint256,address)", amount, user));
    }
}
