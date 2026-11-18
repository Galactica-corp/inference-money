// SPDX-License-Identifier: Apache-2.0
// Copyright 2024 Aztec Labs.
// Modified 2026 by the inference-money contributors. Derived from the canonical Aztec TokenPortal
// (aztec-packages l1-contracts/test/portals/TokenPortal.sol), with these changes:
//   - Deposit messages name their depositor: `mint_to_public(bytes32,uint256,address)` and
//     `mint_to_private(uint256,address)`. A public deposit names the refund address its caller passes (never zero,
//     this portal, the router, the token, the Inbox, the Outbox or the registry). A direct private deposit names the
//     key holder whose EIP-712 `FundingAuthorization` (bound to this portal, the submitting `msg.sender`, the amount,
//     the secret hash and a deadline) it carries, usable once. The bound router's `...For` deposits name the Permit2
//     signer it pulled from. Every deposit pulls from `msg.sender`. `withdraw`'s message is the canonical one.
//   - Deposits refuse a zero amount, and refuse once the registry's canonical rollup is no longer the bound one.
//   - `initialize` is deployer-only and init-once, and binds the router, which must name this portal and token, and
//     the canonical rollup only if its version is the one the caller expects. The L2 bridge address is derived from
//     this contract's address, so the binding cannot move into the constructor.
//   - Deposits cap `amount` at u128 (the L2 amount type), public deposits require `_to` to be a field element (an
//     Aztec address), and every deposit must raise the portal's balance by exactly `amount`.
//   - `withdraw` must lower the portal's balance by exactly `amount`.
//   - Deposits and `withdraw` are nonReentrant.
//   - `initialize` and `withdraw` emit events (`PortalInitialized`, `Withdraw`).
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {ECDSA} from "@oz/utils/cryptography/ECDSA.sol";
import {EIP712} from "@oz/utils/cryptography/EIP712.sol";

import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";

import {IDepositRouter} from "./interfaces/IDepositRouter.sol";
import {ITokenPortal} from "./interfaces/ITokenPortal.sol";

contract TokenPortal is ITokenPortal, ReentrancyGuardTransient, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice What a private depositor signs: the depositor itself (so the digest depends on the address it must
    /// recover to), the one address allowed to submit it, and the deposit.
    bytes32 public constant FUNDING_AUTHORIZATION_TYPEHASH = keccak256(
        "FundingAuthorization(address depositor,address submitter,uint256 amount,bytes32 secretHash,uint256 deadline)"
    );

    error AlreadyInitialized();
    error NotInitializer();
    /// @notice The router names another portal or token, so its deposits would mint against the wrong reserve.
    error RouterMismatch();
    error NotRouter();
    /// @notice The L2 side holds amounts as u128; a larger deposit could never be claimed.
    error AmountExceedsL2Max();
    /// @notice An Aztec address is a field element, so neither a claim nor a return could ever name a larger `_to`.
    error RecipientExceedsFieldMax();
    /// @notice The token moved a different amount than requested (fee-on-transfer, surcharge, upgrade).
    error InexactTransfer();
    error ZeroAmount();
    /// @notice The registry's canonical rollup moved on; a deposit to the old one's Inbox might never be consumed.
    error RollupNotCanonical();
    /// @notice The canonical rollup is not the version the L2 side was deployed on, so its messages could never reach
    /// the bridge.
    error RollupVersionMismatch(uint256 expected, uint256 actual);
    /// @notice A public refund address of zero, this portal, the router, the underlying token, the Inbox, the Outbox
    /// or the registry: a returned deposit could never leave it.
    error InvalidDepositor();
    error AuthorizationExpired(uint256 deadline);
    error AuthorizationUsed();
    error SignerIsNotTheDepositor();

    event DepositToAztecPublic(
        address indexed depositor, bytes32 to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index
    );

    event DepositToAztecPrivate(
        address indexed depositor, uint256 amount, bytes32 secretHashForL2MessageConsumption, bytes32 key, uint256 index
    );

    /// @notice The portal's whole binding, including the Outbox that is `withdraw`'s only authority.
    event PortalInitialized(
        address registry,
        address indexed underlying,
        bytes32 l2Bridge,
        address router,
        address rollup,
        address inbox,
        address outbox,
        uint256 rollupVersion
    );

    /// @notice `amount` is the reserve's debit and the message's amount, not what the recipient nets under a token fee.
    /// `callerOnL1` is the caller the message was hashed with: zero when anyone could execute it.
    event Withdraw(address indexed recipient, uint256 amount, address callerOnL1);

    IRegistry public registry;
    IERC20 public underlying;
    bytes32 public l2Bridge;
    /// @notice The one contract whose `...For` deposits may name a depositor other than itself.
    address public router;

    IRollup public rollup;
    IOutbox public outbox;
    IInbox public inbox;
    uint256 public rollupVersion;

    /// @notice The only address allowed to call `initialize`. Deploy and initialize are separate transactions, so
    /// without it a front-run of the first `initialize` could bind an attacker registry whose outbox drains the reserve.
    address public immutable initializer;

    /// @notice Keyed by EIP-712 digest; the digest covers the secret hash, so honest authorizations never collide.
    mapping(bytes32 digest => bool) public authorizationUsed;

    constructor() EIP712("InferenceMoneyTokenPortal", "1") {
        initializer = msg.sender;
    }

    /**
     * @notice Initialize the portal
     * @param _registry - The registry address
     * @param _underlying - The underlying token address
     * @param _l2Bridge - The L2 bridge address
     * @param _router - The deposit router, which must already name this portal and `_underlying`
     * @param _expectedRollupVersion - The version of the rollup the L2 bridge lives on; the registry's canonical rollup
     * must have it
     */
    function initialize(
        address _registry,
        address _underlying,
        bytes32 _l2Bridge,
        address _router,
        uint256 _expectedRollupVersion
    ) external {
        _requireInitializable();
        if (IDepositRouter(_router).PORTAL() != address(this) || IDepositRouter(_router).TOKEN() != _underlying) {
            revert RouterMismatch();
        }

        registry = IRegistry(_registry);
        underlying = IERC20(_underlying);
        l2Bridge = _l2Bridge;
        router = _router;

        rollup = IRollup(address(registry.getCanonicalRollup()));
        outbox = rollup.getOutbox();
        inbox = rollup.getInbox();
        rollupVersion = rollup.getVersion();
        _requireRollupVersion(_expectedRollupVersion);

        emit PortalInitialized(
            _registry, _underlying, _l2Bridge, _router, address(rollup), address(inbox), address(outbox), rollupVersion
        );
    }

    /**
     * @notice Deposit funds into the portal and adds an L2 message which can only be consumed publicly on Aztec
     * @param _depositor - The L1 address a returned deposit pays; no exit reads it. Unsigned, so it names no identity.
     * @param _to - The aztec address of the recipient
     * @param _amount - The amount to deposit, pulled from `msg.sender`
     * @param _secretHash - The hash of the secret consumable message; the Inbox refuses one above
     * `Constants.MAX_FIELD_VALUE`
     * @return The key of the entry in the Inbox and its leaf index
     */
    function depositToAztecPublic(address _depositor, bytes32 _to, uint256 _amount, bytes32 _secretHash)
        external
        nonReentrant
        returns (bytes32, uint256)
    {
        return _depositPublic(_depositor, _to, _amount, _secretHash);
    }

    /// @notice `depositToAztecPublic` for the router, naming the signer it pulled the funds from as the depositor.
    function depositToAztecPublicFor(address _depositor, bytes32 _to, uint256 _amount, bytes32 _secretHash)
        external
        nonReentrant
        returns (bytes32, uint256)
    {
        _requireRouter();
        return _depositPublic(_depositor, _to, _amount, _secretHash);
    }

    /**
     * @notice Deposit funds into the portal and adds an L2 message which can only be consumed privately on Aztec
     * @dev The depositor becomes the claiming account's binding and only exit, so it must be a key holder that signed
     * this exact deposit for this submitter; the funds still come from `msg.sender`. Each authorization works once.
     * @param _depositor - The key holder whose `FundingAuthorization` signature this is
     * @param _amount - The amount to deposit, pulled from `msg.sender`
     * @param _secretHashForL2MessageConsumption - The hash of the secret consumable L1 to L2 message; the Inbox refuses
     * one above `Constants.MAX_FIELD_VALUE`
     * @param _deadline - The last timestamp the authorization is valid at
     * @param _signature - The depositor's 65-byte, low-s ECDSA signature over `fundingAuthorizationDigest`
     * @return The key of the entry in the Inbox and its leaf index
     */
    function depositToAztecPrivate(
        address _depositor,
        uint256 _amount,
        bytes32 _secretHashForL2MessageConsumption,
        uint256 _deadline,
        bytes calldata _signature
    ) external nonReentrant returns (bytes32, uint256) {
        _requireUnexpired(_deadline);
        bytes32 digest =
            fundingAuthorizationDigest(_depositor, msg.sender, _amount, _secretHashForL2MessageConsumption, _deadline);
        _consumeAuthorization(digest);
        _requireSigner(_depositor, digest, _signature);
        return _depositPrivate(_depositor, _amount, _secretHashForL2MessageConsumption);
    }

    /// @notice The EIP-712 digest `_depositor` signs to let `_submitter` make this private deposit.
    function fundingAuthorizationDigest(
        address _depositor,
        address _submitter,
        uint256 _amount,
        bytes32 _secretHash,
        uint256 _deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(_fundingStructHash(_depositor, _submitter, _amount, _secretHash, _deadline));
    }

    /// @notice `depositToAztecPrivate` for the router, naming the signer it pulled the funds from as the depositor.
    function depositToAztecPrivateFor(address _depositor, uint256 _amount, bytes32 _secretHashForL2MessageConsumption)
        external
        nonReentrant
        returns (bytes32, uint256)
    {
        _requireRouter();
        return _depositPrivate(_depositor, _amount, _secretHashForL2MessageConsumption);
    }

    /**
     * @notice Withdraw funds from the portal
     * @dev Second part of withdraw, must be initiated from L2 first as it will consume a message from outbox
     * @param _recipient - The address to send the funds to
     * @param _amount - The amount to withdraw
     * @param _withCaller - Flag to use `msg.sender` as caller, otherwise address(0)
     * Must match the caller of the message (specified from L2) to consume it.
     * @param _epoch - The epoch the message is in
     * @param _numCheckpointsInEpoch - The number of checkpoints in that epoch
     * @param _leafIndex - The index of the message in the epoch's tree
     * @param _path - The sibling path of the message
     */
    function withdraw(
        address _recipient,
        uint256 _amount,
        bool _withCaller,
        Epoch _epoch,
        uint256 _numCheckpointsInEpoch,
        uint256 _leafIndex,
        bytes32[] calldata _path
    ) external nonReentrant {
        address callerOnL1 = _withCaller ? msg.sender : address(0);
        // The signature only tags the action so the hash is unique to it; nothing calls it.
        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(l2Bridge, rollupVersion),
            recipient: DataStructures.L1Actor(address(this), block.chainid),
            content: Hash.sha256ToField(
                abi.encodeWithSignature("withdraw(address,uint256,address)", _recipient, _amount, callerOnL1)
            )
        });

        outbox.consume(message, _epoch, _numCheckpointsInEpoch, _leafIndex, _path);

        // Checks the portal's debit, not the recipient's credit: the reserve is ours to protect, what the recipient
        // nets is the token's business. A transfer to the portal itself never debits, so it reverts here unless zero,
        // and the L2 bridge never emits a zero exit or return.
        uint256 before = underlying.balanceOf(address(this));
        underlying.safeTransfer(_recipient, _amount);
        if (before - underlying.balanceOf(address(this)) != _amount) revert InexactTransfer();
        emit Withdraw(_recipient, _amount, callerOnL1);
    }

    function _depositPublic(address _depositor, bytes32 _to, uint256 _amount, bytes32 _secretHash)
        private
        returns (bytes32, uint256)
    {
        _requireNonZero(_amount);
        _requireDeposit(_amount);
        _requireRecipient(_to);
        _requireDepositor(_depositor);
        _requireCanonical();

        DataStructures.L2Actor memory actor = DataStructures.L2Actor(l2Bridge, rollupVersion);
        // The signature only tags the action; nothing calls it.
        bytes32 contentHash = Hash.sha256ToField(
            abi.encodeWithSignature("mint_to_public(bytes32,uint256,address)", _to, _amount, _depositor)
        );

        _pullExact(_amount);
        (bytes32 key, uint256 index) = inbox.sendL2Message(actor, contentHash, _secretHash);
        // The event carries the Inbox's key and index, so it follows the send; every entry point is nonReentrant.
        // slither-disable-next-line reentrancy-events
        emit DepositToAztecPublic(_depositor, _to, _amount, _secretHash, key, index);

        return (key, index);
    }

    function _depositPrivate(address _depositor, uint256 _amount, bytes32 _secretHash)
        private
        returns (bytes32, uint256)
    {
        _requireNonZero(_amount);
        _requireDeposit(_amount);
        _requireCanonical();

        DataStructures.L2Actor memory actor = DataStructures.L2Actor(l2Bridge, rollupVersion);
        // The signature only tags the action; nothing calls it.
        bytes32 contentHash =
            Hash.sha256ToField(abi.encodeWithSignature("mint_to_private(uint256,address)", _amount, _depositor));

        _pullExact(_amount);
        (bytes32 key, uint256 index) = inbox.sendL2Message(actor, contentHash, _secretHash);
        // As in `_depositPublic`: the event needs the send's key and index.
        // slither-disable-next-line reentrancy-events
        emit DepositToAztecPrivate(_depositor, _amount, _secretHash, key, index);

        return (key, index);
    }

    // The guards below are virtual only so the formal suite's canaries can delete one rule at a time and watch the
    // matching proof fail.

    function _requireInitializable() internal view virtual {
        if (msg.sender != initializer) revert NotInitializer();
        // `registry` is zero only before the first initialize, so a live portal can never be repointed.
        if (address(registry) != address(0)) revert AlreadyInitialized();
    }

    function _requireRollupVersion(uint256 _expected) internal view virtual {
        if (rollupVersion != _expected) revert RollupVersionMismatch(_expected, rollupVersion);
    }

    /// @dev Runs before any hashing or pull, so a stranger's `...For` call learns nothing and moves nothing.
    function _requireRouter() internal view virtual {
        if (msg.sender != router) revert NotRouter();
    }

    function _requireDeposit(uint256 _amount) internal pure virtual {
        if (_amount > type(uint128).max) revert AmountExceedsL2Max();
    }

    /// @dev The Inbox range-checks the content hash, never the fields hashed into it.
    function _requireRecipient(bytes32 _to) internal pure virtual {
        if (uint256(_to) > Constants.MAX_FIELD_VALUE) revert RecipientExceedsFieldMax();
    }

    function _requireNonZero(uint256 _amount) internal pure virtual {
        if (_amount == 0) revert ZeroAmount();
    }

    /// @dev A non-zero withdraw to the portal never debits it, so it reverts; the router is ownerless and must settle
    /// to its starting balance on every deposit, and USDC, the Inbox, the Outbox and the registry have no way to send
    /// USDC they hold, so nothing could ever move a refund out of them. Permit2 is refused by the SDK: the portal does
    /// not store it.
    function _requireDepositor(address _depositor) internal view virtual {
        if (
            _depositor == address(0) || _depositor == address(this) || _depositor == router
                || _depositor == address(underlying) || _depositor == address(inbox) || _depositor == address(outbox)
                || _depositor == address(registry)
        ) {
            revert InvalidDepositor();
        }
    }

    /// @dev Deposits only: `withdraw` keeps consuming the Outbox bound at initialize, so every proven exit still pays
    /// after an upgrade.
    function _requireCanonical() internal view virtual {
        if (address(registry.getCanonicalRollup()) != address(rollup)) revert RollupNotCanonical();
    }

    function _requireUnexpired(uint256 _deadline) internal view virtual {
        // A validator's few seconds of timestamp skew only shift an expiry the signer chose.
        // forge-lint: disable-start(block-timestamp)
        // slither-disable-next-line timestamp
        if (block.timestamp > _deadline) revert AuthorizationExpired(_deadline);
        // forge-lint: disable-end(block-timestamp)
    }

    /// @dev A later revert in the same deposit rolls the bit back, so a failed deposit never burns its authorization.
    function _consumeAuthorization(bytes32 _digest) internal virtual {
        if (authorizationUsed[_digest]) revert AuthorizationUsed();
        authorizationUsed[_digest] = true;
    }

    /// @dev ECDSA only, never ERC-1271: a contract cannot be a private depositor, since a permissive `isValidSignature`
    /// would let anyone bind deposits to it. `recoverCalldata` refuses compact, high-s and unrecoverable signatures.
    function _requireSigner(address _depositor, bytes32 _digest, bytes calldata _signature) internal pure virtual {
        if (ECDSA.recoverCalldata(_digest, _signature) != _depositor) revert SignerIsNotTheDepositor();
    }

    function _fundingStructHash(
        address _depositor,
        address _submitter,
        uint256 _amount,
        bytes32 _secretHash,
        uint256 _deadline
    ) internal pure virtual returns (bytes32) {
        return keccak256(
            abi.encode(FUNDING_AUTHORIZATION_TYPEHASH, _depositor, _submitter, _amount, _secretHash, _deadline)
        );
    }

    /// @dev A short pull would mint more on L2 than the reserve holds (silent insolvency), so it reverts.
    function _pullExact(uint256 _amount) private {
        uint256 before = underlying.balanceOf(address(this));
        underlying.safeTransferFrom(msg.sender, address(this), _amount);
        if (underlying.balanceOf(address(this)) - before != _amount) revert InexactTransfer();
    }
}
