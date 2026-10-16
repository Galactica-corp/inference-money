/**
 * Permit2 `PermitWitnessTransferFrom` typed data for `Permit2DepositRouter.deposit`. The witness struct must match the
 * router's `DEPOSIT_WITNESS_TYPE_STRING` byte for byte or every signature fails; permit2.test.ts pins it to the same
 * literals as contracts/evm/test/WitnessHash.t.sol.
 */
import { type Address, encodeAbiParameters, type Hex, keccak256, toHex } from "viem"
import { type ReadBackOptions, readBack } from "./l1-receipt"

export const DEPOSIT_WITNESS_TYPE = "DepositWitness(bytes32 aztecRecipient,bytes32 secretHash,bool isPrivate)"
export const DEPOSIT_WITNESS_TYPEHASH = keccak256(toHex(DEPOSIT_WITNESS_TYPE))

/** Permit2 checks `block.timestamp <= deadline`; 30 min absorbs wallet-prompt latency. */
export const PERMIT_DEADLINE_SECONDS = 1800n

export interface DepositWitness {
	/** Zero for a private deposit: its recipient is committed inside `secretHash`. */
	aztecRecipient: Hex
	secretHash: Hex
	isPrivate: boolean
}

export interface DepositPermit {
	token: Address
	amount: bigint
	/** The router: Permit2 pays out only to this spender. */
	spender: Address
	nonce: bigint
	deadline: bigint
}

export const DEPOSIT_PERMIT_TYPES = {
	PermitWitnessTransferFrom: [
		{ name: "permitted", type: "TokenPermissions" },
		{ name: "spender", type: "address" },
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
		{ name: "witness", type: "DepositWitness" },
	],
	TokenPermissions: [
		{ name: "token", type: "address" },
		{ name: "amount", type: "uint256" },
	],
	DepositWitness: [
		{ name: "aztecRecipient", type: "bytes32" },
		{ name: "secretHash", type: "bytes32" },
		{ name: "isPrivate", type: "bool" },
	],
} as const

export function depositPermitTypedData(permit: DepositPermit, witness: DepositWitness, permit2: Address, chainId: number) {
	return {
		domain: { name: "Permit2", chainId, verifyingContract: permit2 },
		types: DEPOSIT_PERMIT_TYPES,
		primaryType: "PermitWitnessTransferFrom" as const,
		message: {
			permitted: { token: permit.token, amount: permit.amount },
			spender: permit.spender,
			nonce: permit.nonce,
			deadline: permit.deadline,
			witness,
		},
	}
}

export type DepositTypedData = ReturnType<typeof depositPermitTypedData>

/** The router's `hashWitness`. */
export function hashDepositWitness(w: DepositWitness): Hex {
	return keccak256(
		encodeAbiParameters(
			[{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bool" }],
			[DEPOSIT_WITNESS_TYPEHASH, w.aztecRecipient, w.secretHash, w.isPrivate],
		),
	)
}

/** SignatureTransfer nonces are an unordered bitmap: any unused value works, so a random one never collides in practice. */
export function randomPermitNonce(): bigint {
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return BigInt(toHex(bytes))
}

export type Permit2ApprovalStatus = "sufficient" | "approving" | "waiting" | "approved"

/**
 * Approves the maximum only while the allowance is short, then reads it back ({@link readBack}): an approve that
 * "succeeds" against the wrong token or spender still fails closed.
 */
export async function ensurePermit2Allowance(deps: {
	allowance: () => Promise<bigint>
	approveMax: () => Promise<Hex>
	waitReceipt: (txHash: Hex) => Promise<{ status?: string }>
	needed: bigint
	onStatus?: (status: Permit2ApprovalStatus, txHash?: Hex) => void
	readBack?: ReadBackOptions
}): Promise<{ approved: boolean; txHash?: Hex }> {
	if ((await deps.allowance()) >= deps.needed) {
		deps.onStatus?.("sufficient")
		return { approved: false }
	}
	deps.onStatus?.("approving")
	const txHash = await deps.approveMax()
	deps.onStatus?.("waiting", txHash)
	const receipt = await deps.waitReceipt(txHash)
	if (receipt.status !== undefined && receipt.status !== "success") {
		throw new Error(`The Permit2 approval ${txHash} reverted; nothing can be deposited.`)
	}
	if ((await readBack(deps.allowance, (a) => a >= deps.needed, deps.readBack)) < deps.needed) {
		throw new Error(`The Permit2 allowance is still short after approval ${txHash}: wrong token or spender.`)
	}
	deps.onStatus?.("approved", txHash)
	return { approved: true, txHash }
}
