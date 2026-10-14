// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {ECDSA} from "@oz/utils/cryptography/ECDSA.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {TokenPortal} from "../src/TokenPortal.sol";
import {CapturingInbox, CapturingOutbox, FAKE_ROLLUP_VERSION, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {StubRouter} from "./mocks/MockPortal.sol";
import {
    PortalIgnoresSubmitter,
    PortalUnsignedDepositor,
    PortalWithoutDeadline,
    PortalWithoutReplayCheck,
    PortalWithoutSignerCheck
} from "./mocks/Mutants.sol";
import {ProofCanary} from "./mocks/ProofCanary.sol";
import {PlainERC20} from "./mocks/TestTokens.sol";
import {HonestWallet, PermissiveWallet} from "./mocks/Wallets.sol";

/// The portal's signed private deposit. The depositor becomes the claiming account's binding and only exit, so it
/// must be a key holder that signed this exact deposit for this submitter, once. Signer rules are forge-only: halmos
/// cannot prove a foreign-signer refusal (its ecrecover is uninterpreted). Each `prove*` body runs against the portal
/// and, in a canary, against the mutant missing its rule.
contract FundingAuthorizationTest is ProofCanary {
    bytes32 internal constant BRIDGE = bytes32(uint256(0x4B));
    bytes32 internal constant SECRET_HASH = bytes32(uint256(0x5EC));
    uint256 internal constant AMOUNT = 1_000;
    uint256 internal constant DEADLINE = 1_800_000_000;
    uint256 internal constant KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    /// secp256k1's group order: an `s` above half of it is the high-s twin OZ refuses.
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // Pinned with `cast` from the EIP-712 spec, for a portal at PIN_PORTAL on chain 31337, depositor PIN_DEPOSITOR,
    // submitter PIN_SUBMITTER, amount 1e6, secret hash 0x33…33 and deadline 1.8e9.
    address internal constant PIN_PORTAL = 0x00000000000000000000000000000000000f0F7a;
    address internal constant PIN_DEPOSITOR = 0x1111111111111111111111111111111111111111;
    address internal constant PIN_SUBMITTER = 0x2222222222222222222222222222222222222222;
    bytes32 internal constant PIN_SECRET = 0x3333333333333333333333333333333333333333333333333333333333333333;
    bytes32 internal constant PIN_TYPEHASH = 0x924f4fb07f90fde04f0315fd46473842575243fa10abea2fd2e81cfd638988b2;
    bytes32 internal constant PIN_DOMAIN_SEPARATOR = 0x8eec773379b24598bae1f2fbbacc4f05aa161eecc18d04825b8eb10809a537b9;
    bytes32 internal constant PIN_STRUCT_HASH = 0xc06af54fed5e0d3950a5f227e12c29d6ce4bbd7c36bd3c9602b3cef6940938e9;
    bytes32 internal constant PIN_DIGEST = 0x42cea5f37760a9570292bd193b1fc9f71e1b06fa75fa2eb7005c9367569eacbc;

    string internal constant FOREIGN_SIGNER = "another key's signature deposited";
    string internal constant REUSED = "an authorization was used twice";
    string internal constant EXPIRED = "an expired authorization deposited";
    string internal constant FOREIGN_SUBMITTER = "another submitter used a periphery's authorization";
    string internal constant SIGNATURE_FIRST = "a signature chosen first named a keyless depositor";

    address internal depositor = vm.addr(KEY);
    address internal periphery = makeAddr("periphery");
    address internal stranger = makeAddr("stranger");
    CapturingInbox internal inbox;
    FakeRegistry internal registry;
    PlainERC20 internal token;
    TokenPortal internal portal;

    function setUp() public {
        vm.warp(DEADLINE - 1 days);
        inbox = new CapturingInbox();
        registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox()))));
        token = new PlainERC20("Tok", "TOK");
        portal = _bind(new TokenPortal());
    }

    /// Initializes `p` against the shared registry and token; the periphery and the stranger each hold and approve
    /// enough for any deposit here.
    function _bind(TokenPortal p) internal returns (TokenPortal) {
        p.initialize(
            address(registry),
            address(token),
            BRIDGE,
            address(new StubRouter(address(p), address(token))),
            FAKE_ROLLUP_VERSION
        );
        address[2] memory payers = [periphery, stranger];
        for (uint256 i; i < payers.length; i++) {
            token.mint(payers[i], 10 * AMOUNT);
            vm.prank(payers[i]);
            token.approve(address(p), type(uint256).max);
        }
        return p;
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// `key` signs `p`'s authorization for `dep` to be submitted by `submitter`, for AMOUNT, SECRET_HASH, DEADLINE.
    function _authorize(TokenPortal p, uint256 key, address dep, address submitter)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, p.fundingAuthorizationDigest(dep, submitter, AMOUNT, SECRET_HASH, DEADLINE));
    }

    function _privateContent(uint256 amount, address dep) internal pure returns (bytes32) {
        return Hash.sha256ToField(abi.encodeWithSignature("mint_to_private(uint256,address)", amount, dep));
    }

    /// Submits as `submitter` and requires the exact `selector`, no message and no pull.
    function _expectRefused(
        TokenPortal p,
        address submitter,
        address dep,
        uint256 amount,
        bytes32 secretHash,
        uint256 deadline,
        bytes memory signature,
        bytes4 selector,
        string memory accepted
    ) internal {
        uint256 sent = inbox.sent();
        uint256 paid = token.balanceOf(submitter);
        vm.prank(submitter);
        try p.depositToAztecPrivate(dep, amount, secretHash, deadline, signature) {
            assertTrue(false, accepted);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), selector, "refused for the wrong reason");
        }
        assertEq(inbox.sent(), sent, "a refused deposit sent a message");
        assertEq(token.balanceOf(submitter), paid, "a refused deposit pulled funds");
    }

    // ── Rules, each a body its canary reruns against the mutant ──────────────────────────────

    function proveRefusesForeignSigner(TokenPortal p) public {
        bytes memory signature = _authorize(p, OTHER_KEY, depositor, periphery);
        _expectRefused(
            p,
            periphery,
            depositor,
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            signature,
            TokenPortal.SignerIsNotTheDepositor.selector,
            FOREIGN_SIGNER
        );
    }

    function proveRefusesReuse(TokenPortal p) public {
        bytes memory signature = _authorize(p, KEY, depositor, periphery);
        vm.prank(periphery);
        p.depositToAztecPrivate(depositor, AMOUNT, SECRET_HASH, DEADLINE, signature);
        _expectRefused(
            p,
            periphery,
            depositor,
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            signature,
            TokenPortal.AuthorizationUsed.selector,
            REUSED
        );
    }

    function proveRefusesExpired(TokenPortal p) public {
        bytes memory signature = _authorize(p, KEY, depositor, periphery);
        vm.warp(DEADLINE + 1);
        _expectRefused(
            p,
            periphery,
            depositor,
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            signature,
            TokenPortal.AuthorizationExpired.selector,
            EXPIRED
        );
    }

    /// A mempool watcher replaying the periphery's authorization with its own funds would credit the depositor's
    /// account with money the periphery never sent, under the depositor's name.
    function proveRefusesForeignSubmitter(TokenPortal p) public {
        bytes memory signature = _authorize(p, KEY, depositor, periphery);
        _expectRefused(
            p,
            stranger,
            depositor,
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            signature,
            TokenPortal.SignerIsNotTheDepositor.selector,
            FOREIGN_SUBMITTER
        );
    }

    /// Choose the signature first, recover the address it signs for over a placeholder's digest, then name that
    /// keyless address: only a digest that covers the depositor makes the recovered address depend on it.
    function proveRefusesSignatureFirst(TokenPortal p) public {
        bytes32 placeholder = p.fundingAuthorizationDigest(address(0xA), periphery, AMOUNT, SECRET_HASH, DEADLINE);
        (bytes32 r, bytes32 s, uint8 v) = (bytes32(uint256(1)), bytes32(uint256(1)), 27);
        address keyless = ecrecover(placeholder, v, r, s);
        assertTrue(keyless != address(0), "the chosen signature recovers");
        _expectRefused(
            p,
            periphery,
            keyless,
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            abi.encodePacked(r, s, v),
            TokenPortal.SignerIsNotTheDepositor.selector,
            SIGNATURE_FIRST
        );
    }

    function test_refusesAForeignSigner() public {
        proveRefusesForeignSigner(portal);
    }

    function test_refusesReuse() public {
        proveRefusesReuse(portal);
    }

    function test_refusesAnExpiredAuthorization() public {
        proveRefusesExpired(portal);
    }

    function test_refusesAForeignSubmitter() public {
        proveRefusesForeignSubmitter(portal);
    }

    function test_refusesASignatureChosenFirst() public {
        proveRefusesSignatureFirst(portal);
    }

    // ── Acceptance and the remaining refusals ─────────────────────────────────────────────────

    /// The depositor signs, the periphery submits and pays; the message and the event name the depositor.
    function test_signedDeposit_namesTheSignerAndPullsFromTheSubmitter() public {
        bytes memory signature = _authorize(portal, KEY, depositor, periphery);
        bytes32 content = _privateContent(AMOUNT, depositor);
        vm.expectEmit(address(portal));
        emit TokenPortal.DepositToAztecPrivate(
            depositor, AMOUNT, SECRET_HASH, keccak256(abi.encode(content, SECRET_HASH)), 0
        );
        vm.prank(periphery);
        portal.depositToAztecPrivate(depositor, AMOUNT, SECRET_HASH, DEADLINE, signature);
        assertEq(inbox.lastContentHash(), content, "the message names the signer");
        assertEq(token.balanceOf(periphery), 9 * AMOUNT, "the submitter paid");
        assertEq(token.balanceOf(address(portal)), AMOUNT, "reserve");
        assertTrue(
            portal.authorizationUsed(
                portal.fundingAuthorizationDigest(depositor, periphery, AMOUNT, SECRET_HASH, DEADLINE)
            ),
            "the authorization is spent"
        );
    }

    /// The deadline is inclusive.
    function test_deadlineItselfStillDeposits() public {
        bytes memory signature = _authorize(portal, KEY, depositor, periphery);
        vm.warp(DEADLINE);
        vm.prank(periphery);
        portal.depositToAztecPrivate(depositor, AMOUNT, SECRET_HASH, DEADLINE, signature);
        assertEq(inbox.sent(), 1);
    }

    /// One honest signature, then each signed field changed alone: every variant is a different digest, so the
    /// signature recovers to someone else.
    function test_everySignedFieldIsBound() public {
        bytes memory signature = _authorize(portal, KEY, depositor, periphery);
        bytes4 refused = TokenPortal.SignerIsNotTheDepositor.selector;
        address other = makeAddr("other depositor");
        _expectRefused(portal, periphery, other, AMOUNT, SECRET_HASH, DEADLINE, signature, refused, "depositor");
        _expectRefused(portal, stranger, depositor, AMOUNT, SECRET_HASH, DEADLINE, signature, refused, "submitter");
        _expectRefused(portal, periphery, depositor, AMOUNT + 1, SECRET_HASH, DEADLINE, signature, refused, "amount");
        _expectRefused(
            portal,
            periphery,
            depositor,
            AMOUNT,
            SECRET_HASH ^ bytes32(uint256(1)),
            DEADLINE,
            signature,
            refused,
            "secret"
        );
        _expectRefused(portal, periphery, depositor, AMOUNT, SECRET_HASH, DEADLINE + 1, signature, refused, "deadline");
        vm.prank(periphery);
        portal.depositToAztecPrivate(depositor, AMOUNT, SECRET_HASH, DEADLINE, signature);
        assertEq(inbox.sent(), 1, "the unchanged authorization still deposits once");
    }

    /// OZ's recovery refuses what Permit2-style checks would accept or what recovers to nobody; a zero depositor is
    /// never the recovered key.
    function test_refusesMalformedSignaturesAndAZeroDepositor() public {
        bytes32 digest = portal.fundingAuthorizationDigest(depositor, periphery, AMOUNT, SECRET_HASH, DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest);
        bytes memory compact = abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        bytes memory twin = abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27));
        bytes memory garbage = abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27));

        _expectRefused(
            portal,
            periphery,
            depositor,
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            compact,
            ECDSA.ECDSAInvalidSignatureLength.selector,
            "compact"
        );
        _expectRefused(
            portal,
            periphery,
            depositor,
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            twin,
            ECDSA.ECDSAInvalidSignatureS.selector,
            "high-s"
        );
        _expectRefused(
            portal,
            periphery,
            depositor,
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            garbage,
            ECDSA.ECDSAInvalidSignature.selector,
            "garbage"
        );
        bytes memory forZero = _authorize(portal, KEY, address(0), periphery);
        _expectRefused(
            portal,
            periphery,
            address(0),
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            forZero,
            TokenPortal.SignerIsNotTheDepositor.selector,
            "zero depositor"
        );
    }

    /// A contract cannot be a private depositor, honest or not: no key recovers to its address, and ERC-1271 is never
    /// consulted. Such a wallet deposits privately with an owner key as the depositor.
    function test_refusesContractWalletsAsDepositors() public {
        HonestWallet honest = new HonestWallet(depositor);
        bytes memory ownerSigned = _authorize(portal, KEY, address(honest), periphery);
        _expectRefused(
            portal,
            periphery,
            address(honest),
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            ownerSigned,
            TokenPortal.SignerIsNotTheDepositor.selector,
            "an honest 1271 wallet"
        );
        _expectRefused(
            portal,
            periphery,
            address(new PermissiveWallet()),
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            "",
            ECDSA.ECDSAInvalidSignatureLength.selector,
            "a permissive 1271 wallet"
        );
    }

    /// A key-held account delegated under EIP-7702 still signs with its key, and that is all the portal reads.
    function test_a7702DelegatedDepositorSigns() public {
        vm.signAndAttachDelegation(address(new PermissiveWallet()), KEY);
        assertGt(depositor.code.length, 0, "the depositor carries a delegation");
        bytes memory signature = _authorize(portal, KEY, depositor, periphery);
        vm.prank(periphery);
        portal.depositToAztecPrivate(depositor, AMOUNT, SECRET_HASH, DEADLINE, signature);
        assertEq(inbox.lastContentHash(), _privateContent(AMOUNT, depositor));
    }

    /// The guards after the signature still refuse a signed deposit, and a refused deposit does not spend its
    /// authorization: the same signature deposits once the rollup is canonical again.
    function test_signedDeposit_guardsRunAndARefusalKeepsTheAuthorization() public {
        uint256 over = uint256(type(uint128).max) + 1;
        bytes memory zero =
            _sign(KEY, portal.fundingAuthorizationDigest(depositor, periphery, 0, SECRET_HASH, DEADLINE));
        bytes memory huge =
            _sign(KEY, portal.fundingAuthorizationDigest(depositor, periphery, over, SECRET_HASH, DEADLINE));
        _expectRefused(
            portal, periphery, depositor, 0, SECRET_HASH, DEADLINE, zero, TokenPortal.ZeroAmount.selector, "zero"
        );
        _expectRefused(
            portal,
            periphery,
            depositor,
            over,
            SECRET_HASH,
            DEADLINE,
            huge,
            TokenPortal.AmountExceedsL2Max.selector,
            "cap"
        );

        bytes memory signature = _authorize(portal, KEY, depositor, periphery);
        address bound = registry.rollup();
        registry.setCanonicalRollup(makeAddr("next rollup"));
        _expectRefused(
            portal,
            periphery,
            depositor,
            AMOUNT,
            SECRET_HASH,
            DEADLINE,
            signature,
            TokenPortal.RollupNotCanonical.selector,
            "stale rollup"
        );
        registry.setCanonicalRollup(bound);
        vm.prank(periphery);
        portal.depositToAztecPrivate(depositor, AMOUNT, SECRET_HASH, DEADLINE, signature);
        assertEq(inbox.sent(), 1, "the authorization survived the refusal");
    }

    /// aztec.js's stock `bridgeTokens{Public,Private}` call the canonical selectors, which this portal no longer has:
    /// they revert before any transfer instead of losing a secret or sending an unconsumable message.
    function test_stockAztecJsSelectorsRevert() public {
        vm.startPrank(periphery);
        (bool publicOk,) = address(portal)
            .call(
                abi.encodeWithSignature(
                    "depositToAztecPublic(bytes32,uint256,bytes32)", bytes32(uint256(1)), AMOUNT, SECRET_HASH
                )
            );
        (bool privateOk,) =
            address(portal).call(abi.encodeWithSignature("depositToAztecPrivate(uint256,bytes32)", AMOUNT, SECRET_HASH));
        vm.stopPrank();
        assertFalse(publicOk, "the stock public selector deposited");
        assertFalse(privateOk, "the stock private selector deposited");
        assertEq(inbox.sent(), 0, "no message");
        assertEq(token.balanceOf(periphery), 10 * AMOUNT, "nothing pulled");
    }

    /// The typehash, the domain separator, the struct hash and the digest equal values computed from the EIP-712
    /// spec with `cast`; the pinned four are consistent with each other. The runtime is etched at the pinned address:
    /// OZ's EIP712 rebuilds its domain separator whenever `address(this)` differs from the deploy-time one.
    function test_digestMatchesThePinnedLiterals() public {
        vm.etch(PIN_PORTAL, address(portal).code);
        TokenPortal pinned = TokenPortal(PIN_PORTAL);
        assertEq(block.chainid, 31337, "the pins assume forge's default chain id");
        assertEq(pinned.FUNDING_AUTHORIZATION_TYPEHASH(), PIN_TYPEHASH, "typehash");
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            pinned.eip712Domain();
        assertEq(name, "InferenceMoneyTokenPortal", "domain name");
        assertEq(version, "1", "domain version");
        assertEq(chainId, block.chainid, "domain chain id");
        assertEq(verifyingContract, PIN_PORTAL, "domain verifying contract");
        assertEq(
            keccak256(abi.encodePacked("\x19\x01", PIN_DOMAIN_SEPARATOR, PIN_STRUCT_HASH)), PIN_DIGEST, "pins agree"
        );
        assertEq(
            pinned.fundingAuthorizationDigest(PIN_DEPOSITOR, PIN_SUBMITTER, 1e6, PIN_SECRET, DEADLINE),
            PIN_DIGEST,
            "digest"
        );
    }

    /// A periphery's signed direct private deposit, the second one warm.
    function test_gas_depositPrivateSigned() public {
        bytes memory first = _authorize(portal, KEY, depositor, periphery);
        bytes memory second =
            _sign(KEY, portal.fundingAuthorizationDigest(depositor, periphery, AMOUNT, SECRET_HASH, DEADLINE - 1));
        vm.startPrank(periphery);
        portal.depositToAztecPrivate(depositor, AMOUNT, SECRET_HASH, DEADLINE, first);
        portal.depositToAztecPrivate(depositor, AMOUNT, SECRET_HASH, DEADLINE - 1, second);
        vm.stopPrank();
    }

    /// A direct public deposit naming a refund address, the second one warm.
    function test_gas_depositPublicDirect() public {
        vm.startPrank(periphery);
        portal.depositToAztecPublic(depositor, bytes32(uint256(1)), AMOUNT, SECRET_HASH);
        portal.depositToAztecPublic(depositor, bytes32(uint256(1)), AMOUNT, SECRET_HASH);
        vm.stopPrank();
    }

    // ── Canaries (forge) ─────────────────────────────────────────────────────────────────────

    function test_canary_signer_failsWithoutTheCheck() public {
        TokenPortal mutant = _bind(new PortalWithoutSignerCheck());
        _assertProofFails(abi.encodeCall(this.proveRefusesForeignSigner, (mutant)), FOREIGN_SIGNER);
    }

    function test_canary_replay_failsWithoutTheCheck() public {
        TokenPortal mutant = _bind(new PortalWithoutReplayCheck());
        _assertProofFails(abi.encodeCall(this.proveRefusesReuse, (mutant)), REUSED);
    }

    function test_canary_deadline_failsWithoutTheCheck() public {
        TokenPortal mutant = _bind(new PortalWithoutDeadline());
        _assertProofFails(abi.encodeCall(this.proveRefusesExpired, (mutant)), EXPIRED);
    }

    function test_canary_submitter_failsWhenNotSigned() public {
        TokenPortal mutant = _bind(new PortalIgnoresSubmitter());
        _assertProofFails(abi.encodeCall(this.proveRefusesForeignSubmitter, (mutant)), FOREIGN_SUBMITTER);
    }

    function test_canary_depositor_failsWhenNotSigned() public {
        TokenPortal mutant = _bind(new PortalUnsignedDepositor());
        _assertProofFails(abi.encodeCall(this.proveRefusesSignatureFirst, (mutant)), SIGNATURE_FIRST);
    }
}
