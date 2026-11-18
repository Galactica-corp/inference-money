// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

/// Permit2's own errors (Uniswap/permit2 SignatureTransfer + SignatureVerification).
interface IPermit2Errors {
    error InvalidContractSignature();
    error InvalidNonce();
    error InvalidSigner();
    error SignatureExpired(uint256 signatureDeadline);
}

/// Re-derives the EIP-712 digest Permit2 verifies in `permitWitnessTransferFrom`, from its public spec: the domain
/// has no version field, and the witness type string is appended to the struct's type stub.
library Permit2Digest {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    string internal constant STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    struct Params {
        uint256 chainId;
        address permit2;
        address token;
        uint256 amount;
        address spender;
        uint256 nonce;
        uint256 deadline;
        bytes32 witness;
        string witnessTypeString;
    }

    function domainSeparator(uint256 chainId, address permit2) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Permit2"), chainId, permit2));
    }

    function digest(Params memory p) internal pure returns (bytes32) {
        bytes32 typehash = keccak256(abi.encodePacked(STUB, p.witnessTypeString));
        bytes32 permitted = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, p.token, p.amount));
        bytes32 structHash = keccak256(abi.encode(typehash, permitted, p.spender, p.nonce, p.deadline, p.witness));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(p.chainId, p.permit2), structHash));
    }
}
