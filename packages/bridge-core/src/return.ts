import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { TxHash } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import type { Address } from "viem"
import { tokenBridgeArtifact } from "./artifacts"
import {
	assertPlainDeposit,
	type ClaimableNode,
	type ClaimWait,
	type FeeChoice,
	feeFor,
	messageNullifier,
	type NullifierNode,
	sponsorFailure,
	type WaitClaimableOptions,
	waitConsumable,
} from "./claim"
import type { ClaimTicket } from "./deposit"
import { type ExitNode, type ExitTicket, expectedExitMessage, locateWithdrawal } from "./exit"
import type { BridgeManifest } from "./manifest"
import type { StageSink } from "./types"

/**
 * The return was sent but its withdrawal could not be located yet. Returning again would fail on the consumed message:
 * resume with `exitTicketFromTx` from these fields, or from the deposit ticket alone with {@link depositFate}.
 */
export class ReturnUnconfirmedError extends Error {
	constructor(
		readonly l2TxHash: TxHash,
		readonly depositor: Address,
		readonly amount: bigint,
		options?: ErrorOptions,
	) {
		super(
			`Return ${l2TxHash} was sent, but its withdrawal could not be located yet. Do not return it again; resume it from this hash.`,
			options,
		)
		this.name = "ReturnUnconfirmedError"
	}
}

/**
 * The return reverted with the rest of its app logic: the deposit is unconsumed, so it can still be claimed or returned.
 * Until `final`, a prune can re-include the tx and return the deposit after all; {@link depositFate} then finds it.
 */
export class ReturnRevertedError extends Error {
	constructor(
		readonly l2TxHash: TxHash,
		readonly final: boolean,
	) {
		super(`The return ${l2TxHash} was rejected on Aztec, so the deposit is untouched. If the bridge is paused, wait for it to resume.`)
		this.name = "ReturnRevertedError"
	}
}

function returnCall(t: ClaimTicket, wallet: Wallet, m: BridgeManifest) {
	assertPlainDeposit(t)
	const bridge = Contract.at(AztecAddress.fromStringUnsafe(m.l2.bridge.address), tokenBridgeArtifact, wallet)
	const { amount, recipient, kind } = t.draft.intent
	const ret = kind === "private" ? bridge.methods.return_deposit_private! : bridge.methods.return_deposit_public!
	return ret(recipient, amount, t.draft.secretOrSalt, new Fr(t.leafIndex), EthAddress.fromString(t.depositor))
}

/** {@link waitConsumable} for the return of `t` from `from`'s wallet; call it before {@link returnDeposit}. */
export function waitReturnable(
	t: ClaimTicket,
	node: ClaimableNode,
	wallet: Wallet,
	m: BridgeManifest,
	from: AztecAddress,
	on?: StageSink<ClaimWait>,
	opts: WaitClaimableOptions = {},
): Promise<void> {
	return waitConsumable(t, node, () => returnCall(t, wallet, m).simulate({ from }), on, opts)
}

/**
 * Sends an unclaimed deposit back to the Ethereum address it came from: consumes its message on L2, mints nothing, and
 * emits the withdraw an exit to `t.depositor` would, which anyone may finish on L1 (`finishWithdrawal`) once its epoch
 * is proven. Whoever holds the claim data may send it, paid per {@link FeeChoice}. A merchant's public deposit is
 * claimed, never returned. Failures after the send mirror `exitToL1`'s: {@link ReturnUnconfirmedError} carries the
 * hash, and only a checkpointed revert with no withdraw message is a {@link ReturnRevertedError}.
 */
export async function returnDeposit(
	t: ClaimTicket,
	wallet: Wallet,
	node: ExitNode,
	m: BridgeManifest,
	opts: { from: AztecAddress; fee?: FeeChoice },
): Promise<ExitTicket> {
	const { amount, kind } = t.draft.intent
	const fee = feeFor(kind, m, opts.fee)
	let txHash: TxHash
	try {
		txHash = (await returnCall(t, wallet, m).send({ from: opts.from, fee, wait: NO_WAIT })).txHash
	} catch (e) {
		throw (fee && sponsorFailure(e, "return")) || e
	}
	const located = await locateWithdrawal(t.depositor, amount, txHash, node, m).catch((cause: unknown) => {
		throw new ReturnUnconfirmedError(txHash, t.depositor, amount, { cause })
	})
	if (typeof located === "string") throw new ReturnRevertedError(txHash, located === "reverted")
	return located
}

export type FateNode = NullifierNode & Pick<AztecNode, "getBlock">

/**
 * `withdrawal`: the consuming tx emitted a withdraw of this amount to the depositor, as a return does and a claim never
 * does. It is a candidate, not proof of a return: one tx can batch this deposit's claim with another return or exit of
 * the same amount to the same address. Either way, finishing it on L1 pays the depositor.
 */
export type DepositFate = { consumed: false } | { consumed: true; l2TxHash: TxHash; withdrawal: boolean }

/**
 * What consumed `t`'s message, read at a checkpoint from the chain with the ticket alone, since whoever claimed or
 * returned it need not share the tx. A withdrawal is finished like any exit's: `exitTicketFromTx(l2TxHash, t.depositor,
 * amount, …)`, then `finishWithdrawal`.
 */
export async function depositFate(t: ClaimTicket, node: FateNode, m: BridgeManifest): Promise<DepositFate> {
	const nullifier = await messageNullifier(t, m)
	const [hit] = await node.findLeavesIndexes("checkpointed", MerkleTreeId.NULLIFIER_TREE, [nullifier])
	if (!hit) return { consumed: false }
	const block = await node.getBlock(hit.l2BlockNumber, { includeTransactions: true })
	const effect = block?.body.txEffects.find((e) => e.nullifiers.some((n) => n.equals(nullifier)))
	if (!effect) throw new Error(`Block ${hit.l2BlockNumber} holds no tx with this deposit's nullifier.`)
	const payout = await expectedExitMessage(t.depositor, t.draft.intent.amount, m)
	return { consumed: true, l2TxHash: effect.txHash, withdrawal: effect.l2ToL1Msgs.some((msg) => msg.equals(payout)) }
}
