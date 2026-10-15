// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {TokenPortal} from "../../src/TokenPortal.sol";
import {Permit2DepositRouter} from "../../src/Permit2DepositRouter.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {ITokenPortal} from "../../src/interfaces/ITokenPortal.sol";

// One-rule-deleted mutants for the formal suites' forge canaries: each symbolic proof must FAIL against the
// mutant missing the rule it relies on, or the proof is not actually exercising that rule.

contract PortalWithoutInitOnce is TokenPortal {
    function _requireInitializable() internal view override {
        if (msg.sender != initializer) revert NotInitializer();
    }
}

contract PortalWithoutInitializerCheck is TokenPortal {
    function _requireInitializable() internal view override {
        if (address(registry) != address(0)) revert AlreadyInitialized();
    }
}

contract PortalWithoutVersionCheck is TokenPortal {
    function _requireRollupVersion(uint256) internal view override {}
}

contract PortalWithoutCap is TokenPortal {
    function _requireDeposit(uint256) internal pure override {}
}

contract PortalWithoutRouterCheck is TokenPortal {
    function _requireRouter() internal view override {}
}

contract PortalWithoutRecipientCheck is TokenPortal {
    function _requireRecipient(bytes32) internal pure override {}
}

contract PortalWithoutZeroCheck is TokenPortal {
    function _requireNonZero(uint256) internal pure override {}
}

contract PortalWithoutCanonicalCheck is TokenPortal {
    function _requireCanonical() internal view override {}
}

contract PortalWithoutDepositorCheck is TokenPortal {
    function _requireDepositor(address) internal view override {}
}

contract PortalWithoutDeadline is TokenPortal {
    function _requireUnexpired(uint256) internal view override {}
}

contract PortalWithoutReplayCheck is TokenPortal {
    function _consumeAuthorization(bytes32) internal override {}
}

contract PortalWithoutSignerCheck is TokenPortal {
    function _requireSigner(address, bytes32, bytes calldata) internal pure override {}
}

/// The submitter left out of the signed struct: anyone may submit a signature meant for one periphery.
contract PortalIgnoresSubmitter is TokenPortal {
    function _fundingStructHash(address depositor, address, uint256 amount, bytes32 secretHash, uint256 deadline)
        internal
        pure
        override
        returns (bytes32)
    {
        return super._fundingStructHash(depositor, address(0), amount, secretHash, deadline);
    }
}

/// The depositor left out of the signed struct: a signature chosen first recovers to whatever keyless address the
/// submitter then names.
contract PortalUnsignedDepositor is TokenPortal {
    function _fundingStructHash(address, address submitter, uint256 amount, bytes32 secretHash, uint256 deadline)
        internal
        pure
        override
        returns (bytes32)
    {
        return super._fundingStructHash(address(0), submitter, amount, secretHash, deadline);
    }
}

contract RouterWithoutZeroCheck is Permit2DepositRouter {
    constructor(ISignatureTransfer p, ITokenPortal portal, IERC20 token) Permit2DepositRouter(p, portal, token) {}

    function _checkIntent(uint256 amount, bytes32 aztecRecipient, bool isPrivate) internal pure override {
        if (amount > type(uint128).max) revert AmountExceedsL2Max();
        if (isPrivate && aztecRecipient != bytes32(0)) revert PrivateDepositNamesRecipient();
        if (!isPrivate && aztecRecipient == bytes32(0)) revert PublicDepositNeedsRecipient();
    }
}

contract RouterWithoutCap is Permit2DepositRouter {
    constructor(ISignatureTransfer p, ITokenPortal portal, IERC20 token) Permit2DepositRouter(p, portal, token) {}

    function _checkIntent(uint256 amount, bytes32 aztecRecipient, bool isPrivate) internal pure override {
        if (amount == 0) revert ZeroAmount();
        if (isPrivate && aztecRecipient != bytes32(0)) revert PrivateDepositNamesRecipient();
        if (!isPrivate && aztecRecipient == bytes32(0)) revert PublicDepositNeedsRecipient();
    }
}

contract RouterWithoutPrivateRule is Permit2DepositRouter {
    constructor(ISignatureTransfer p, ITokenPortal portal, IERC20 token) Permit2DepositRouter(p, portal, token) {}

    function _checkIntent(uint256 amount, bytes32 aztecRecipient, bool isPrivate) internal pure override {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountExceedsL2Max();
        if (!isPrivate && aztecRecipient == bytes32(0)) revert PublicDepositNeedsRecipient();
    }
}

contract RouterWithoutPublicRule is Permit2DepositRouter {
    constructor(ISignatureTransfer p, ITokenPortal portal, IERC20 token) Permit2DepositRouter(p, portal, token) {}

    function _checkIntent(uint256 amount, bytes32 aztecRecipient, bool isPrivate) internal pure override {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountExceedsL2Max();
        if (isPrivate && aztecRecipient != bytes32(0)) revert PrivateDepositNamesRecipient();
    }
}

contract RouterWithoutSettleCheck is Permit2DepositRouter {
    constructor(ISignatureTransfer p, ITokenPortal portal, IERC20 token) Permit2DepositRouter(p, portal, token) {}

    function _checkSettled(uint256) internal view override {}
}

contract RouterWithoutSignerCheck is Permit2DepositRouter {
    constructor(ISignatureTransfer p, ITokenPortal portal, IERC20 token) Permit2DepositRouter(p, portal, token) {}

    function _requireSigner(bytes32, bytes calldata) internal view override {}
}

contract RouterNamesItself is Permit2DepositRouter {
    constructor(ISignatureTransfer p, ITokenPortal portal, IERC20 token) Permit2DepositRouter(p, portal, token) {}

    function _depositor() internal view override returns (address) {
        return address(this);
    }
}
