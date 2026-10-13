import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { DelayedPublicMutableValues } from "@aztec-labs/stdlib/delayed-public-mutable"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import {
	type BridgeManifest,
	delayAt,
	MERCHANT_MIN_DELAY,
	type MerchantList,
	type MerchantNode,
	syncMerchantList,
	tokenArtifact,
	tokenBridgeArtifact,
} from "@inference-money/bridge-core"

/** A delayed slot's delay in force at `at`, the one scheduled to follow, and when that takes over. */
export interface DelayState {
	current: bigint
	scheduled: bigint
	changeAt: bigint
}

/** A storage field's slot in `artifact`'s layout, `offset` fields into its packed value. */
export function layoutSlot(artifact: ContractArtifact, field: string, offset = 0): Fr {
	const layout = artifact.storageLayout[field]
	if (!layout) throw new Error(`${artifact.name} has no ${field} storage`)
	return layout.slot.add(new Fr(offset))
}

export const tokenSlot = (field: string): Fr => layoutSlot(tokenArtifact, field)

type Tip = "latest" | "finalized"

export const publicReader =
	(node: Pick<AztecNode, "getPublicStorageAt">, contract: string, tip: Tip = "latest") =>
	(slot: Fr) =>
		node.getPublicStorageAt(tip, AztecAddress.fromStringUnsafe(contract), slot)

/** The bridge's owner and the token's merchant admin, each with its proposed successor (zero: none). */
export interface Roles {
	owner: Fr
	pendingOwner: Fr
	admin: Fr
	pendingAdmin: Fr
}

export async function readRoles(node: Pick<AztecNode, "getPublicStorageAt">, m: BridgeManifest, tip: Tip = "latest"): Promise<Roles> {
	const [b, t] = [publicReader(node, m.l2.bridge.address, tip), publicReader(node, m.l2.token.address, tip)]
	const [owner, pendingOwner, admin, pendingAdmin] = await Promise.all([
		b(layoutSlot(tokenBridgeArtifact, "owner")),
		b(layoutSlot(tokenBridgeArtifact, "pending_owner")),
		t(layoutSlot(tokenArtifact, "merchant_admin")),
		t(layoutSlot(tokenArtifact, "pending_merchant_admin")),
	])
	return { owner, pendingOwner, admin, pendingAdmin }
}

async function delayOf(node: Pick<AztecNode, "getPublicStorageAt">, token: AztecAddress, slot: Fr, block: number, at: bigint) {
	const read = (s: Fr) => node.getPublicStorageAt(BlockNumber(block), token, s)
	const { sdc } = await DelayedPublicMutableValues.readFromTree(slot, read)
	return { current: delayAt(sdc, at), scheduled: sdc.post ?? MERCHANT_MIN_DELAY, changeAt: sdc.timestampOfChange }
}

/** A merchant's switch-off entry delay, read at `block` (timestamp `at`). */
export async function entryDelay(
	node: Pick<AztecNode, "getPublicStorageAt">,
	token: AztecAddress,
	account: AztecAddress,
	block: number,
	at: bigint,
): Promise<DelayState> {
	return delayOf(node, token, await deriveStorageSlotInMap(tokenSlot("merchant_off"), account), block, at)
}

/** The cancel-only guardian in force at the latest block, and the one scheduled to follow; zero is none. */
export async function readGuardian(
	node: Pick<AztecNode, "getBlockNumber" | "getBlockData" | "getPublicStorageAt">,
	token: AztecAddress,
): Promise<{ current: Fr; scheduled: Fr }> {
	const block = await node.getBlockNumber()
	const at = (await node.getBlockData(block))?.header.globalVariables.timestamp
	if (at === undefined) throw new Error(`The node has no block ${block}.`)
	const read = (s: Fr) => node.getPublicStorageAt(block, token, s)
	const { svc } = await DelayedPublicMutableValues.readFromTree(tokenSlot("merchant_guardian"), read)
	return { current: svc.getCurrentAt(at)[0] ?? Fr.ZERO, scheduled: svc.post[0] ?? Fr.ZERO }
}

/** The guardian slot's delay, read at `block` (timestamp `at`). */
export const guardianDelay = (node: Pick<AztecNode, "getPublicStorageAt">, token: AztecAddress, block: number, at: bigint) =>
	delayOf(node, token, tokenSlot("merchant_guardian"), block, at)

/** The delay setting, the guardian slot's delay and every listed entry, all read at the merchant list's block. */
export interface DelayReads {
	setting: bigint
	guardian: DelayState
	list: MerchantList
}

export async function readDelays(node: MerchantNode, token: AztecAddress): Promise<DelayReads> {
	const list = await syncMerchantList(node, token)
	const [setting, guardian] = await Promise.all([
		node.getPublicStorageAt(BlockNumber(list.block), token, tokenSlot("merchant_delay")),
		guardianDelay(node, token, list.block, list.at),
	])
	return { setting: setting.toBigInt(), guardian, list }
}
