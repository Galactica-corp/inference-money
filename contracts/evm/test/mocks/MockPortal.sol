// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {TokenPortal} from "../../src/TokenPortal.sol";
import {ITokenPortal} from "../../src/interfaces/ITokenPortal.sol";
import {FAKE_ROLLUP_VERSION} from "./AztecFakes.sol";

/// A non-hashing stand-in for `TokenPortal`: it pulls the deposit and records it. The symbolic suites need it
/// because halmos 0.3.3 cannot model the sha256 precompile the real portal hashes with. `shortBy` makes it pull
/// less than asked, the misbehavior the router's settle check exists for.
contract MockTokenPortal is ITokenPortal {
    IERC20 public immutable token;
    uint256 public shortBy;
    uint256 public calls;
    uint256 public lastAmount;
    address public lastDepositor;
    bytes32 public lastTo;
    bytes32 public lastSecretHash;
    bool public lastPrivate;

    constructor(IERC20 token_) {
        token = token_;
    }

    function setShortBy(uint256 v) external {
        shortBy = v;
    }

    function depositToAztecPublicFor(address _depositor, bytes32 _to, uint256 _amount, bytes32 _secretHash)
        external
        returns (bytes32, uint256)
    {
        _record(_depositor, _to, _amount, _secretHash, false);
        return (bytes32(uint256(0xABCD)), calls - 1);
    }

    function depositToAztecPrivateFor(address _depositor, uint256 _amount, bytes32 _secretHash)
        external
        returns (bytes32, uint256)
    {
        _record(_depositor, bytes32(0), _amount, _secretHash, true);
        return (bytes32(uint256(0x9012)), calls - 1);
    }

    function _record(address depositor, bytes32 to, uint256 amount, bytes32 secretHash, bool isPrivate) private {
        SafeERC20.safeTransferFrom(token, msg.sender, address(this), amount - shortBy);
        lastDepositor = depositor;
        lastTo = to;
        lastAmount = amount;
        lastSecretHash = secretHash;
        lastPrivate = isPrivate;
        calls++;
    }
}

/// The binding `TokenPortal.initialize` checks, with no router behind it. Lets a suite initialize a portal over a
/// token with no code, and call the router-only deposits by pranking this address.
contract StubRouter {
    address public immutable PORTAL;
    address public immutable TOKEN;

    constructor(address portal, address token) {
        PORTAL = portal;
        TOKEN = token;
    }
}

/// A portal bound to `registry`'s rollup over `token`, with a `StubRouter` as its router. The calling contract deploys
/// it, so it is also the portal's initializer.
function initializedPortal(address registry, address token, bytes32 l2Bridge)
    returns (TokenPortal portal, StubRouter router)
{
    portal = new TokenPortal();
    router = new StubRouter(address(portal), token);
    portal.initialize(registry, token, l2Bridge, address(router), FAKE_ROLLUP_VERSION);
}
