/**
 * Split deposits' derivations: the TS mirror of the Noir `claim_secret` split functions, pinned by the keystone.
 *
 * A split deposit is one private deposit whose secret commits to a merchant, a price, the merchant's payment reference
 * and a commitment to the buyer's change. `claim_split` pays the price to the merchant and leaves the rest as an IOU (a
 * bridge nullifier); `claim_change` hands it to the account behind the commitment, which the merchant never learns.
 */
import type { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/sync"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"

/** `poseidon2_hash_bytes(<name>) as u32` for each name, equal to the Noir literals; the test re-derives them. */
export const DOM_SEP__TOKEN_BRIDGE_SPLIT_CLAIM = 2878369513
export const DOM_SEP__TOKEN_BRIDGE_SPLIT_CHANGE = 1854012931
export const DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU = 2366609694
export const DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU_SPENT = 3143065046

/** What a split deposit's secret commits to. */
export interface SplitTerms {
	merchant: AztecAddress
	/** Base units; at most the deposit. */
	price: bigint
	/** The reference the merchant handed out for this payment. */
	paymentRef: Fr
	changeCommitment: Fr
	/** MUST be a fresh `randomSecret()`: the secret hash is public on L1. */
	salt: Fr
}

/** `changeSalt` MUST be a fresh `randomSecret()`: the commitment hides the buyer only as well as it does. */
export const splitChangeCommitment = (buyer: AztecAddress, changeSalt: Fr): Fr =>
	poseidon2HashWithSeparator([buyer.toField(), changeSalt], DOM_SEP__TOKEN_BRIDGE_SPLIT_CHANGE)

export const splitSecret = (terms: SplitTerms): Fr =>
	poseidon2HashWithSeparator(
		[terms.merchant.toField(), new Fr(terms.price), terms.paymentRef, terms.changeCommitment, terms.salt],
		DOM_SEP__TOKEN_BRIDGE_SPLIT_CLAIM,
	)

export const splitSecretHash = (terms: SplitTerms): Promise<Fr> => computeSecretHash(splitSecret(terms))

/** The IOU a claimed split deposit leaves for `change`: unique per message through its leaf index. */
export const splitIou = (changeCommitment: Fr, change: bigint, depositor: EthAddress, secret: Fr, messageLeafIndex: bigint): Fr =>
	poseidon2HashWithSeparator(
		[changeCommitment, new Fr(change), depositor.toField(), secret, new Fr(messageLeafIndex)],
		DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU,
	)

/** The marker `claim_change` or `return_change` pushes; only the change's owner can compute it. */
export const splitIouSpent = (iou: Fr, changeSalt: Fr): Fr =>
	poseidon2HashWithSeparator([iou, changeSalt], DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU_SPENT)
