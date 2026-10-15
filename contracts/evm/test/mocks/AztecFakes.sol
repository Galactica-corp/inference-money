// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";

// The Aztec side every portal/router suite drives: an Inbox and an Outbox that capture exactly what was put on the
// wire, behind a registry -> rollup pair with a pinned version. The capturing Outbox authorizes anything any number
// of times; PortalWithdrawRealOutbox.t.sol is where the real membership proof and nullifier run.

contract CapturingInbox {
    bytes32 public lastContentHash;
    bytes32 public lastSecretHash;
    bytes32 public lastBridge;
    uint256 public lastVersion;
    address public lastSender;
    uint256 public sent;

    function sendL2Message(DataStructures.L2Actor calldata actor, bytes32 contentHash, bytes32 secretHash)
        external
        returns (bytes32 key, uint256 index)
    {
        lastContentHash = contentHash;
        lastSecretHash = secretHash;
        lastBridge = actor.actor;
        lastVersion = actor.version;
        lastSender = msg.sender;
        key = keccak256(abi.encode(contentHash, secretHash));
        index = sent++;
    }
}

contract CapturingOutbox {
    DataStructures.L2ToL1Msg private stored;
    uint256 public consumed;

    // A public struct variable's getter flattens members, so the struct needs an explicit accessor.
    function lastMsg() external view returns (DataStructures.L2ToL1Msg memory) {
        return stored;
    }

    function consume(DataStructures.L2ToL1Msg calldata message, Epoch, uint256, uint256, bytes32[] calldata) external {
        stored = message;
        consumed++;
    }
}

uint256 constant FAKE_ROLLUP_VERSION = 4242;

contract FakeRollup {
    uint256 public constant VERSION = FAKE_ROLLUP_VERSION;
    address public immutable inbox;
    address public immutable outbox;
    uint256 internal version = FAKE_ROLLUP_VERSION;

    constructor(address inbox_, address outbox_) {
        inbox = inbox_;
        outbox = outbox_;
    }

    function getInbox() external view returns (address) {
        return inbox;
    }

    function getOutbox() external view returns (address) {
        return outbox;
    }

    function getVersion() external view returns (uint256) {
        return version;
    }

    /// Another rollup generation: a registry that switches to this rollup moves the canonical version.
    function setVersion(uint256 version_) external {
        version = version_;
    }
}

contract FakeRegistry {
    address public rollup;

    constructor(address rollup_) {
        rollup = rollup_;
    }

    function getCanonicalRollup() external view returns (address) {
        return rollup;
    }

    /// A governance upgrade: the portal stays bound to the old rollup, which is no longer canonical.
    function setCanonicalRollup(address rollup_) external {
        rollup = rollup_;
    }
}
