// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27 <0.9.0;

import {Clamp} from "./utils/Clamp.sol";
import {DecimalPrinter} from "./utils/DecimalPrinter.sol";
import {Deployer} from "./utils/Deployer.sol";
import {vm} from "./utils/Hevm.sol";
import {Logger} from "./utils/Logger.sol";
import {Math} from "./utils/Math.sol";
import {StringUtils} from "./utils/StringUtils.sol";
import {EnumerableSet} from "./utils/EnumerableSet.sol";

import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";

import {TokenPortal} from "../../src/TokenPortal.sol";
import {Permit2DepositRouter} from "../../src/Permit2DepositRouter.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {ITokenPortal} from "../../src/interfaces/ITokenPortal.sol";

import {CapturingInbox, FAKE_ROLLUP_VERSION, FakeRegistry, FakeRollup} from "../mocks/AztecFakes.sol";
import {IPermit2Errors, Permit2Digest} from "../mocks/Permit2Digest.sol";
import {Permit2Runtime} from "../mocks/Permit2Runtime.sol";
import {ModalUsdc} from "./mocks/ModalUsdc.sol";
import {RealOutboxStack} from "./mocks/RealOutboxStack.sol";

abstract contract Base is StringUtils, Clamp, Deployer, Math {
    using DecimalPrinter for uint256;

    string[] internal ACTOR_LABELS = ["Alice", "Bob", "Charlie"];
    uint256 internal constant BLOCK_INTERVAL = 12 seconds;
    /// 1B USDC (6 decimals) per actor: no realistic clamp ever runs a funded actor dry.
    uint256 internal constant INITIAL_TOKEN_BALANCE = 1e15;
    /// Upper clamp for "realistic" deposits and exits: 1M USDC.
    uint256 internal constant MAX_REALISTIC_AMOUNT = 1e12;
    /// Cap on the actor-originated supply: setup balances plus `_ensureFunds` mints, wherever they sit now (actors,
    /// the portal's escrow, the fee sink); donations excluded. Real USDC (about 2^57 base units) never nears the L2's
    /// u128 amount type, so an uncapped mock would only show GL-26 breaking on a supply no real deposit can reach.
    uint256 internal constant MOCK_SUPPLY_CAP = type(uint128).max;

    bytes32 internal constant L2_BRIDGE = bytes32(uint256(0xB41D6E));
    uint256 internal constant ROLLUP_VERSION = 4242;
    /// Outbox trees the model proves hold at most 4 leaves (height 2).
    uint256 internal constant MAX_LEAVES_PER_EPOCH = 4;
    uint256 internal constant MAX_CHECKPOINTS_PER_EPOCH = 32;

    // ―――――――――――――――――――――――――― Ghosts ――――――――――――――――――――――――――

    struct Ghosts {
        // L1 flows, moved only by successful calls
        uint256 deposited; // Σ successful deposit amounts (direct + router)
        uint256 depositCount; // successful deposits; each must have sent exactly one Inbox message
        uint256 portalDonated; // tokens minted straight to the portal
        uint256 routerDonated; // tokens minted straight to the router
        uint256 withdrawn; // Σ successful withdraw payouts
        uint256 withdrawCount;
        // L2 model (the bridge on Aztec, reduced to its accounting)
        uint256 pendingDepositAmount; // Σ deposit messages not yet consumed by a claim or a return
        uint256 claimed; // Σ deposits claimed (minted on L2)
        uint256 returned; // Σ deposits returned to their depositor (no mint, one exit)
        uint256 l2Supply; // claimed − Σ exits burned from L2 balances
        uint256 exited; // Σ L2→L1 withdraw messages created (exits + returns)
        uint256 unpaidExitAmount; // Σ withdraw messages not yet paid on L1 (proven or not)
        // Violations recorded by handlers; properties assert these stay zero.
        uint256 unbackedPayouts; // a withdraw succeeded that matches no proven, unpaid modelled exit
        uint256 replayedPayouts; // a paid exit paid again
        uint256 tamperedPayouts; // a proven exit paid with an altered recipient / amount / caller / position
        uint256 wrongCallerPayouts; // a caller-bound exit delivered by someone else
        uint256 strangerNamedDepositor; // a `...For` deposit succeeded from someone other than the router
        uint256 reinitialized; // a second initialize succeeded
        uint256 misnamedMessages; // a deposit's Inbox content hash did not match the independent model
        uint256 permit2RejectBypassed; // a router deposit succeeded although Permit2 refused the pull
        uint256 boundaryAccepted; // an out-of-range deposit (zero, > u128, `_to` > field, unusable refund) passed or misfired
        uint256 staleDepositAccepted; // a deposit succeeded while the registry's canonical rollup was not the portal's
        uint256 authorizationMisused; // a spent, or another submitter's, portal authorization deposited (or misfired)
        uint256 foreignSignatureAccepted; // a private deposit carrying another key's signature passed (or misfired)
        uint256 authorizationRollbackBroken; // a refused deposit spent its Permit2 nonce or portal authorization
        uint256 selfPayoutAccepted; // a proven exit to the portal itself paid out
        uint256 misboundRouter; // a fresh portal/router accepted a stranger's init, a foreign router or a code-less dependency
        // Flow splits and liveness counters
        uint256 l2OffAccount; // claimed L2 balance sitting on field elements outside L2_ACCOUNTS
        uint256 directDeposited; // Σ successful direct portal deposits
        uint256 routerDeposited; // Σ successful router deposits
        uint256 actorMinted; // Σ USDC minted to actors by `_ensureFunds`
        uint256 payableExitStuck; // a healthy-environment withdraw of a proven, unpaid, caller-satisfied exit reverted
        uint256 depositLivenessBroken; // a Normal-environment 1..MAX_REALISTIC_AMOUNT deposit by a funded caller reverted
        uint256 inexactAccepted; // a FeeOnTransfer deposit or SenderSurcharge withdraw of >= 100 units succeeded
        uint256 foreignDomainPaid; // a foreign-domain Outbox leaf paid out of the portal
        // A transfer hook re-entering the portal or router is read straight from `usdc.hookReentrySucceeded()`.
    }

    Ghosts internal ghosts;

    /// One L1→L2 deposit message as the L2 bridge would see it.
    struct DepositMsg {
        address depositor;
        bytes32 to; // zero for private deposits (the recipient is bound inside the secret)
        uint256 amount;
        bool isPrivate;
        bool consumed;
    }

    /// One L2→L1 withdraw message (an exit or a return) and, once proven, where it sits in the Outbox.
    struct ExitMsg {
        address recipient;
        uint256 amount;
        address caller; // zero: anyone may deliver it
        bool proven;
        bool paid;
        uint256 epoch;
        uint256 numCheckpoints;
        uint256 leafIndex;
        uint256 pathLen;
        bytes32[2] path;
    }

    DepositMsg[] internal depositMsgs;
    uint256[] internal pendingDeposits; // indexes into depositMsgs, unconsumed
    ExitMsg[] internal exitMsgs;
    uint256[] internal unprovenExits; // indexes into exitMsgs, FIFO
    uint256[] internal provenUnpaidExits; // indexes into exitMsgs
    uint256[] internal paidExits; // indexes into exitMsgs
    mapping(bytes32 => uint256) internal l2Balance;
    bytes32[3] internal L2_ACCOUNTS = [bytes32(uint256(0xA11CE)), bytes32(uint256(0xB0B)), bytes32(uint256(0xCA401))];
    uint256 internal nextEpoch;

    // ―――――――――――――――――――――――――― Actors ――――――――――――――――――――――――――

    address[] internal actors;
    address internal actor;
    /// Actors are key-held EOAs, so they can sign the portal's private-deposit authorizations.
    mapping(address actor => uint256) internal actorKey;
    /// Spent into each authorization's deadline, so two identical deposits never share a digest.
    uint256 internal authorizationNonce;
    /// Where each signer's search for an unspent Permit2 nonce resumes.
    mapping(address signer => uint256) internal permitNonce;
    /// The nonce of each signer's last successful router deposit, for the replay probe.
    mapping(address signer => uint256) internal lastRouterNonce;

    /// The deposit witness written out from the router's documented intent, never read from its constants: a drift
    /// in the router's own encoding then fails the real Permit2's signature check instead of moving both sides.
    bytes32 internal constant SPEC_WITNESS_TYPEHASH =
        keccak256("DepositWitness(bytes32 aztecRecipient,bytes32 secretHash,bool isPrivate)");
    string internal constant SPEC_WITNESS_TYPE_STRING =
        "DepositWitness witness)DepositWitness(bytes32 aztecRecipient,bytes32 secretHash,bool isPrivate)TokenPermissions(address token,uint256 amount)";

    /// The last portal authorization that deposited, kept for the replay and foreign-submitter probes.
    struct Authorization {
        address depositor;
        address submitter;
        uint256 amount;
        bytes32 secretHash;
        uint256 deadline;
        bytes signature;
    }

    Authorization internal lastAuthorization;
    address internal admin;

    modifier asActor() virtual {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    modifier asAdmin() virtual {
        vm.startPrank(admin);
        _;
        vm.stopPrank();
    }

    // ―――――――――――――――――――――――― Contracts ―――――――――――――――――――――――――

    ModalUsdc internal usdc;
    ISignatureTransfer internal permit2;
    CapturingInbox internal inbox;
    Outbox internal outbox;
    FakeRollup internal rollup;
    FakeRegistry internal registry;
    TokenPortal internal portal;
    Permit2DepositRouter internal router;

    // ―――――――――――――――――――――――――― Setup ―――――――――――――――――――――――――――

    /// Deploys `runtime` byte for byte behind a 12-byte init stub. Medusa 1.5.1 faults inside code placed with
    /// `etch` (a stack underflow in Permit2's dispatch) where the same bytes run cleanly once deployed.
    function _deployRuntime(bytes memory runtime) internal returns (address deployed) {
        bytes memory init = abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
        assembly ("memory-safe") {
            deployed := create(0, add(init, 0x20), mload(init))
        }
        require(deployed != address(0), "runtime deploy failed");
    }

    /// Mirrors the project's deploy order (test/mocks/RouterFixture.sol): portal (this contract is its initializer),
    /// router naming portal + token, then the portal's one `initialize` binding registry, token, L2 bridge and router.
    /// The Aztec side is the capturing Inbox and the REAL Outbox, as in PortalWithdrawRealOutbox.t.sol; Permit2 is its
    /// real runtime, the code the local deploy installs, deployed at a fresh address.
    function setup() internal {
        usdc = new ModalUsdc();
        permit2 = ISignatureTransfer(_deployRuntime(Permit2Runtime.CODE));
        require(keccak256(address(permit2).code) == Permit2Runtime.KECCAK, "Permit2 runtime differs from its pin");
        inbox = new CapturingInbox();
        RealOutboxStack stack = new RealOutboxStack(address(inbox));
        outbox = stack.outbox();
        rollup = stack.rollup();
        registry = new FakeRegistry(address(rollup));

        portal = new TokenPortal();
        router = new Permit2DepositRouter(ISignatureTransfer(address(permit2)), ITokenPortal(address(portal)), usdc);
        portal.initialize(address(registry), address(usdc), L2_BRIDGE, address(router), FAKE_ROLLUP_VERSION);

        nextEpoch = 1;

        vm.label(address(usdc), "USDC");
        vm.label(address(permit2), "Permit2");
        vm.label(address(inbox), "Inbox");
        vm.label(address(outbox), "Outbox");
        vm.label(address(rollup), "Rollup");
        vm.label(address(portal), "TokenPortal");
        vm.label(address(router), "Router");

        setupActors();
    }

    function setupActors() internal {
        admin = address(this);
        vm.label(admin, "Admin");

        for (uint256 i; i < ACTOR_LABELS.length; i++) {
            uint256 key = uint256(keccak256(bytes(ACTOR_LABELS[i])));
            address _actor = vm.addr(key);
            actorKey[_actor] = key;
            actors.push(_actor);
            vm.label(_actor, ACTOR_LABELS[i]);
            // Real holders approve both spenders once: the portal for direct deposits, Permit2 for signed ones.
            usdc.mint(_actor, INITIAL_TOKEN_BALANCE);
            vm.startPrank(_actor);
            usdc.approve(address(portal), type(uint256).max);
            usdc.approve(address(permit2), type(uint256).max);
            vm.stopPrank();
        }
        actor = actors[0];
    }

    // ――――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    function toActor(address addy) internal view returns (address) {
        return actors[uint256(uint160(addy)) % actors.length];
    }

    function toActorNotCurrent(address addy) internal view returns (address) {
        address _actor = actors[uint256(uint160(addy)) % actors.length];
        if (_actor == actor) {
            _actor = actors[(uint256(uint160(addy)) + 1) % actors.length];
        }
        return _actor;
    }

    function toL2Account(uint256 seed) internal view returns (bytes32) {
        return L2_ACCOUNTS[seed % L2_ACCOUNTS.length];
    }

    /// An actor other than `not`, chosen by `seed`.
    function _otherActor(address not, uint256 seed) internal view returns (address other) {
        other = actors[seed % actors.length];
        if (other == not) other = actors[(seed + 1) % actors.length];
    }

    /// `depositor`'s fresh authorization for `submitter`'s private deposit; the deadline it signed is returned with it.
    function _authorize(address depositor, address submitter, uint256 amount, bytes32 secretHash)
        internal
        returns (uint256 deadline, bytes memory signature)
    {
        // A year out, so a probe replaying it later meets the replay rule, not the expiry one.
        deadline = block.timestamp + 365 days + authorizationNonce++;
        signature = _authorizeUntil(depositor, submitter, amount, secretHash, deadline);
    }

    /// `depositor`'s authorization for `submitter`'s private deposit, valid through `deadline`. Computed before any
    /// prank its digest read would consume.
    function _authorizeUntil(address depositor, address submitter, uint256 amount, bytes32 secretHash, uint256 deadline)
        internal
        returns (bytes memory)
    {
        bytes32 digest = portal.fundingAuthorizationDigest(depositor, submitter, amount, secretHash, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(actorKey[depositor], digest);
        return abi.encodePacked(r, s, v);
    }

    /// The digest Permit2 verifies for this router deposit, from Permit2's spec and the witness written out above.
    function _specPermitDigest(
        uint256 amount,
        bytes32 recipient,
        bytes32 secretHash,
        bool isPrivate,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return Permit2Digest.digest(
            Permit2Digest.Params({
                chainId: block.chainid,
                permit2: address(permit2),
                token: address(usdc),
                amount: amount,
                spender: address(router),
                nonce: nonce,
                deadline: deadline,
                witness: keccak256(abi.encode(SPEC_WITNESS_TYPEHASH, recipient, secretHash, isPrivate)),
                witnessTypeString: SPEC_WITNESS_TYPE_STRING
            })
        );
    }

    /// `signer`'s signature over the spec digest, so only a router that hands Permit2 the signed intent gets a pull.
    function _permitSignature(
        address signer,
        uint256 amount,
        bytes32 recipient,
        bytes32 secretHash,
        bool isPrivate,
        uint256 nonce,
        uint256 deadline
    ) internal returns (bytes memory) {
        bytes32 digest = _specPermitDigest(amount, recipient, secretHash, isPrivate, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(actorKey[signer], digest);
        return abi.encodePacked(r, s, v);
    }

    /// Whether Permit2 has spent `owner`'s unordered `nonce`. Reads Permit2, so never between a prank and its call.
    function _nonceUsed(address owner, uint256 nonce) internal view returns (bool) {
        return (permit2.nonceBitmap(owner, nonce >> 8) >> (nonce & 0xff)) & 1 == 1;
    }

    /// The next nonce `signer` has not spent, skipping any a fuzzed deposit already took.
    function _freshNonce(address signer) internal returns (uint256 nonce) {
        nonce = permitNonce[signer];
        while (_nonceUsed(signer, nonce)) nonce++;
        permitNonce[signer] = nonce + 1;
    }

    /// A boundary probe's revert is a refusal only with its rule's own selector; any other revert could hide the rule.
    function _requireRefusal(bytes memory reason, bytes4 selector) internal {
        if (bytes4(reason) != selector) ghosts.boundaryAccepted++;
    }

    /// Mints the shortfall (plus room for a 1% surcharge) within `MOCK_SUPPLY_CAP`; false once the cap leaves `who`
    /// unable to pay `amount`.
    function _ensureFunds(address who, uint256 amount) internal returns (bool funded) {
        uint256 need = amount + amount / 50 + 1;
        uint256 bal = usdc.balanceOf(who);
        if (bal < need) {
            uint256 actorSide = usdc.totalSupply() - ghosts.portalDonated - ghosts.routerDonated;
            uint256 room = MOCK_SUPPLY_CAP > actorSide ? MOCK_SUPPLY_CAP - actorSide : 0;
            uint256 mint = need - bal < room ? need - bal : room;
            usdc.mint(who, mint);
            ghosts.actorMinted += mint;
            bal += mint;
        }
        return bal >= amount;
    }

    /// The largest deposit `who` can fund up to the L2's u128 ceiling, once `MOCK_SUPPLY_CAP` binds.
    function _largestFundable(address who) internal returns (uint256 amount) {
        _ensureFunds(who, type(uint128).max);
        amount = usdc.balanceOf(who);
        if (amount > type(uint128).max) amount = type(uint128).max;
    }

    /// Normal token mode, nothing armed, and neither the current actor nor the portal blacklisted.
    function _cleanEnv() internal view returns (bool) {
        return _cleanEnvIn(ModalUsdc.Mode.Normal);
    }

    /// `_cleanEnv` with the token in `mode`.
    function _cleanEnvIn(ModalUsdc.Mode mode) internal view returns (bool) {
        return usdc.mode() == mode && usdc.hookPayload().length == 0 && !usdc.blacklisted(actor)
            && !usdc.blacklisted(address(portal));
    }

    /// `_cleanEnv` for a deposit: also the portal's rollup still canonical, since deposits stop after an upgrade while
    /// withdrawals do not (so withdrawal guards keep `_cleanEnv` alone).
    function _depositEnvClean() internal view returns (bool) {
        return _cleanEnv() && _canonical();
    }

    function _canonical() internal view returns (bool) {
        return registry.getCanonicalRollup() == address(portal.rollup());
    }

    /// Whether the real Outbox has consumed the leaf of a proven exit; false if the view reverts.
    function _leafConsumed(ExitMsg storage e) internal view returns (bool consumed) {
        try outbox.hasMessageBeenConsumedAtEpoch(Epoch.wrap(e.epoch), (1 << e.pathLen) + e.leafIndex) returns (bool c) {
            consumed = c;
        } catch {}
    }

    function _toField(bytes32 value) internal pure returns (bytes32) {
        return bytes32(uint256(value) % (Constants.MAX_FIELD_VALUE + 1));
    }

    function sumActorsBalances() internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            sumOfBalances += actors[i].balance;
        }
    }

    function sumActorsERC20Balances(address _token) internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            bytes memory data = abi.encodeWithSignature("balanceOf(address)", actors[i]);
            (bool success, bytes memory result) = _token.staticcall(data);
            require(success, "sumActorsERC20Balances: failed to get balance");
            sumOfBalances += abi.decode(result, (uint256));
        }
    }

    function skipBlocks(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + blocks * BLOCK_INTERVAL);
    }

    function skipTime(uint256 time) internal {
        uint256 blocks = (time + BLOCK_INTERVAL - 1) / BLOCK_INTERVAL;
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + time);
    }

    // ――――――――――――――――――――――― Message model ――――――――――――――――――――――――

    /// Independent model of Aztec's `sha256ToField` (top byte dropped), so a portal encoding drift shows up as a
    /// failed proof or a misnamed message instead of being hashed away by the same library.
    function _fieldHash(bytes memory preimage) internal pure returns (bytes32) {
        return bytes32(uint256(sha256(preimage)) >> 8);
    }

    function _depositContent(DepositMsg memory d) internal pure returns (bytes32) {
        return d.isPrivate
            ? _fieldHash(abi.encodeWithSignature("mint_to_private(uint256,address)", d.amount, d.depositor))
            : _fieldHash(
                abi.encodeWithSignature("mint_to_public(bytes32,uint256,address)", d.to, d.amount, d.depositor)
            );
    }

    function _exitLeaf(address recipient, uint256 amount, address caller) internal view returns (bytes32) {
        bytes32 content =
            _fieldHash(abi.encodeWithSignature("withdraw(address,uint256,address)", recipient, amount, caller));
        return Hash.sha256ToField(
            DataStructures.L2ToL1Msg({
                sender: DataStructures.L2Actor(L2_BRIDGE, ROLLUP_VERSION),
                recipient: DataStructures.L1Actor(address(portal), block.chainid),
                content: content
            })
        );
    }

    function _parent(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return Hash.sha256ToField(bytes.concat(left, right));
    }

    /// Records a successful deposit as a pending L1→L2 message and checks the Inbox saw the modelled content.
    function _recordDeposit(address depositor, bytes32 to, uint256 amount, bool isPrivate) internal {
        DepositMsg memory d = DepositMsg(depositor, isPrivate ? bytes32(0) : to, amount, isPrivate, false);
        if (inbox.lastContentHash() != _depositContent(d) || inbox.lastSender() != address(portal)) {
            ghosts.misnamedMessages++;
        }
        pendingDeposits.push(depositMsgs.length);
        depositMsgs.push(d);
        ghosts.deposited += amount;
        ghosts.depositCount++;
        ghosts.pendingDepositAmount += amount;
    }

    /// Removes and returns the pending deposit at `seed`, or `type(uint256).max` when none is pending.
    function _takePendingDeposit(uint256 seed) internal returns (uint256 idx) {
        uint256 n = pendingDeposits.length;
        if (n == 0) return type(uint256).max;
        uint256 pos = seed % n;
        idx = pendingDeposits[pos];
        pendingDeposits[pos] = pendingDeposits[n - 1];
        pendingDeposits.pop();
        depositMsgs[idx].consumed = true;
        ghosts.pendingDepositAmount -= depositMsgs[idx].amount;
    }

    function _createExit(address recipient, uint256 amount, address caller) internal {
        ExitMsg storage e = exitMsgs.push();
        e.recipient = recipient;
        e.amount = amount;
        e.caller = caller;
        unprovenExits.push(exitMsgs.length - 1);
        ghosts.exited += amount;
        ghosts.unpaidExitAmount += amount;
    }

    function _removeProvenUnpaid(uint256 pos) internal returns (uint256 idx) {
        uint256 n = provenUnpaidExits.length;
        idx = provenUnpaidExits[pos];
        provenUnpaidExits[pos] = provenUnpaidExits[n - 1];
        provenUnpaidExits.pop();
    }

    /// Marks the proven, unpaid exit matching a successful withdraw as paid. Returns false when nothing matches.
    function _settleWithdraw(
        address recipient,
        uint256 amount,
        address caller,
        uint256 epoch,
        uint256 numCheckpoints,
        uint256 leafIndex
    ) internal returns (bool matched) {
        for (uint256 pos; pos < provenUnpaidExits.length; pos++) {
            ExitMsg storage e = exitMsgs[provenUnpaidExits[pos]];
            if (
                e.recipient == recipient && e.amount == amount && e.caller == caller && e.epoch == epoch
                    && e.numCheckpoints == numCheckpoints && e.leafIndex == leafIndex
            ) {
                uint256 idx = _removeProvenUnpaid(pos);
                exitMsgs[idx].paid = true;
                paidExits.push(idx);
                ghosts.unpaidExitAmount -= amount;
                return true;
            }
        }
    }

    function _exitPath(ExitMsg storage e) internal view returns (bytes32[] memory path) {
        path = new bytes32[](e.pathLen);
        for (uint256 i; i < e.pathLen; i++) {
            path[i] = e.path[i];
        }
    }
}
