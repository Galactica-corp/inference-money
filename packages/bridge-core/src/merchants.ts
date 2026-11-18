/**
 * The merchant list as a client sees it, and the side capsule every restricted token call carries.
 *
 * A restricted call (a private transfer, a request opening, a payment) proves one side a merchant. The token's hint
 * picks which side from the tx's capsule, else by probing the node about each account; a wrong pick only fails the
 * proof. So clients attach the capsule, computed here from a list synced whole: every `MerchantAdded` event, then
 * every entry's switch-off state read at one block. Reading only the entries a call involves would tell the node whom
 * the client transacts with.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { getPublicEvents } from "@aztec-labs/aztec.js/events"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import {
	type AbiType,
	type ContractArtifact,
	decodeFunctionSignature,
	type EventMetadataDefinition,
	EventSelector,
} from "@aztec-labs/stdlib/abi"
import { DelayedPublicMutableValues, type ScheduledDelayChange } from "@aztec-labs/stdlib/delayed-public-mutable"
import { SimulationError } from "@aztec-labs/stdlib/errors"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import { Capsule } from "@aztec-labs/stdlib/tx"
import { tokenArtifact } from "./artifacts"
import { type TokenRule, tokenRefusalOf } from "./rules"
import { MERCHANT_SIDE_SLOT, type RequestStamp, STANDARD_TX_LIFETIME } from "./stamp"

/** The switch-off delay's bounds: the token's MERCHANT_MIN_DELAY (DelayedPublicMutable's floor) and MERCHANT_MAX_DELAY. */
export const MERCHANT_MIN_DELAY = 3600n
export const MERCHANT_MAX_DELAY = 86_400n

/** A token entry's or the guardian slot's delay at `at`; both start at MERCHANT_MIN_DELAY until one is scheduled. */
export function delayAt(sdc: ScheduledDelayChange, at: bigint): bigint {
	const delay = at < sdc.timestampOfChange ? sdc.pre : sdc.post
	return delay ?? MERCHANT_MIN_DELAY
}

/** Which side a restricted call proves, as the token's hint numbers them: its first account, its second, or none. */
export const Side = { First: 0, Second: 1, Neither: 2 } as const
export type Side = (typeof Side)[keyof typeof Side]

/**
 * An entry's switch-off state: `off` holds before `changeAt`, `scheduledOff` from then on. Its delay likewise: `delay`
 * before `delayChangeAt`, `scheduledDelay` from then on, either MERCHANT_MIN_DELAY while unset.
 */
export interface MerchantEntry {
	off: boolean
	scheduledOff: boolean
	changeAt: bigint
	delay: bigint | undefined
	scheduledDelay: bigint | undefined
	delayChangeAt: bigint
}

/** Every listed account's entry, read at `block`, whose timestamp is `at`. */
export interface MerchantList {
	block: number
	at: bigint
	entries: ReadonlyMap<string, MerchantEntry>
}

export type MerchantNode = Pick<AztecNode, "getBlockNumber" | "getBlockData" | "getPublicStorageAt" | "getPublicLogsByTags">

type StructType = Extract<AbiType, { kind: "struct" }>

/** A contract event's decoding definition, its selector derived the way aztec's codegen derives it. */
export async function contractEvent(artifact: ContractArtifact, name: string): Promise<EventMetadataDefinition> {
	const path = `${artifact.name}::${name}`
	const abiType = (artifact.outputs.structs.events as StructType[] | undefined)?.find((e) => e.path === path)
	if (!abiType) throw new Error(`the ${artifact.name} artifact has no ${path} event`)
	const signature = decodeFunctionSignature(
		name,
		abiType.fields.map((f) => ({ ...f, visibility: "private" as const })),
	)
	return { eventSelector: await EventSelector.fromSignature(signature), abiType, fieldNames: abiType.fields.map((f) => f.name) }
}

export const tokenEvent = (name: string): Promise<EventMetadataDefinition> => contractEvent(tokenArtifact, name)

async function listedAccounts(node: MerchantNode, token: AztecAddress, block: number): Promise<AztecAddress[]> {
	const added = await tokenEvent("MerchantAdded")
	const accounts: AztecAddress[] = []
	let afterEvent: Parameters<typeof getPublicEvents>[2]["afterEvent"]
	do {
		const page = await getPublicEvents<{ account: AztecAddress }>(node as AztecNode, added, {
			contractAddress: token,
			toBlock: BlockNumber(block + 1),
			afterEvent,
		})
		accounts.push(...page.events.map((e) => e.event.account))
		afterEvent = page.nextCursor
	} while (afterEvent)
	return accounts
}

function storageSlot(field: string): Fr {
	const layout = tokenArtifact.storageLayout[field]
	if (!layout) throw new Error(`the token artifact has no ${field} storage`)
	return layout.slot
}

/** Every listed merchant's entry at the latest block (or `block`), each read at that block. */
export async function syncMerchantList(node: MerchantNode, token: AztecAddress, block?: number): Promise<MerchantList> {
	const at = block ?? Number(await node.getBlockNumber())
	const data = await node.getBlockData(BlockNumber(at))
	if (!data) throw new Error(`The node has no block ${at}.`)
	const offSlot = storageSlot("merchant_off")
	const accounts = await listedAccounts(node, token, at)
	const entries = await Promise.all(
		accounts.map(async (account): Promise<[string, MerchantEntry]> => {
			const slot = await deriveStorageSlotInMap(offSlot, account)
			const { svc, sdc } = await DelayedPublicMutableValues.readFromTree(slot, (s) =>
				node.getPublicStorageAt(BlockNumber(at), token, s),
			)
			return [
				account.toString(),
				{
					off: !svc.previous[0]!.isZero(),
					scheduledOff: !svc.post[0]!.isZero(),
					changeAt: svc.timestampOfChange,
					delay: sdc.pre,
					scheduledDelay: sdc.post,
					delayChangeAt: sdc.timestampOfChange,
				},
			]
		}),
	)
	return { block: at, at: data.header.globalVariables.timestamp, entries: new Map(entries) }
}

/** Whether `account` is a switched-on merchant at `at`, and whether its entry has a switch scheduled after `at`. */
export function merchantStatus(list: MerchantList, account: AztecAddress, at = list.at): { merchant: boolean; pending: boolean } {
	const e = list.entries.get(account.toString())
	if (!e) return { merchant: false, pending: false }
	return { merchant: !(at < e.changeAt ? e.off : e.scheduledOff), pending: e.changeAt > at && e.off !== e.scheduledOff }
}

/** How long a read of `e` at `at` must assume its value holds: aztec's `get_effective_minimum_delay_at`. */
export function effectiveMinimumDelayAt(e: MerchantEntry, at: bigint): bigint {
	const pre = e.delay ?? MERCHANT_MIN_DELAY
	const post = e.scheduledDelay ?? MERCHANT_MIN_DELAY
	if (e.delayChangeAt <= at) return post - 1n
	const throughChange = e.delayChangeAt - at + post
	return (pre < throughChange ? pre : throughChange) - 1n
}

/**
 * The last second a read of `e` at `at` holds, given its effective minimum delay `d`: aztec's `get_time_horizon`, under
 * which a change scheduled to the current value (a cancel, a switch back on) caps nothing.
 */
export function timeHorizon(e: MerchantEntry, at: bigint, d: bigint): bigint {
	if (at >= e.changeAt || e.off === e.scheduledOff) return at + d
	return at + d < e.changeAt - 1n ? at + d : e.changeAt - 1n
}

/** The expiry cap proving `account` a merchant at `at` puts on the tx (the token hint's horizon); 0n if unlisted. */
export function merchantHorizon(list: MerchantList, account: AztecAddress, at = list.at): bigint {
	const e = list.entries.get(account.toString())
	return e ? timeHorizon(e, at, effectiveMinimumDelayAt(e, at)) : 0n
}

/**
 * The side a transfer or request proves, by the token hint's rules: a merchant side is always kept; a merchant
 * `first` is proven whenever `keepFirst` (the call publishes it, or opens a request for it, which is then stamped) or
 * its read leaves the standard expiry; otherwise, of two merchants, the one whose read caps the tx's expiry latest,
 * `first` on a tie.
 */
export function merchantSide(list: MerchantList, first: AztecAddress, second: AztecAddress, keepFirst: boolean): Side {
	const a = merchantStatus(list, first)
	if (a.merchant && (keepFirst || merchantHorizon(list, first) >= list.at + STANDARD_TX_LIFETIME)) return Side.First
	const b = merchantStatus(list, second)
	if (b.merchant && (!a.merchant || merchantHorizon(list, second) > merchantHorizon(list, first))) return Side.Second
	return a.merchant ? Side.First : Side.Neither
}

/**
 * The side a payment into a request (its live stamp, if any) proves, by the token hint's order: a fresh stamp, which
 * caps no expiry; else a merchant payer whose read, taken when the stamp was read, leaves the standard expiry; else a
 * live stamp, whose cap tells only the request's hour where a shortened payer's would name the payer; else any
 * merchant payer; else neither.
 */
export function paymentSide(list: MerchantList, stamp: RequestStamp | undefined, from: AztecAddress): Side {
	if (stamp?.state === "fresh") return Side.First
	const payer = merchantStatus(list, from, stamp?.at).merchant
	if (payer && (!stamp || merchantHorizon(list, from, stamp.at) >= stamp.at + STANDARD_TX_LIFETIME)) return Side.Second
	return stamp ? Side.First : Side.Neither
}

/** The capsule that tells the token which side to prove; one serves every restricted call in its tx. */
export const sideCapsule = (token: AztecAddress, side: Side): Capsule => new Capsule(token, MERCHANT_SIDE_SLOT, [new Fr(side)])

// The refusals a stale list can cause: it named a side that is no longer a merchant, or missed one that now is.
const STALE_LIST_RULES: ReadonlySet<TokenRule> = new Set(["transfer", "request", "payment", "notRegistered", "switchedOff"])

/** A token rule's refusal, in its exact text, that the client drew from its merchant list before proving anything. */
export class ListRefusal extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ListRefusal"
	}
}

// A node's reply arrives as a plain Error, even after it has taken the tx; a SimulationError comes only from proving
// or simulating before the send.
function refusedBeforeSend(e: unknown): boolean {
	let current: unknown = e
	for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
		if (current instanceof ListRefusal || current instanceof SimulationError) return true
		current = current.cause
	}
	return false
}

/**
 * Runs `attempt` on `list`; when it fails on a merchant rule before anything was sent and `resync` is given, retries
 * once on a fresh list.
 */
export async function withFreshList<T>(
	list: MerchantList,
	resync: (() => Promise<MerchantList>) | undefined,
	attempt: (list: MerchantList) => Promise<T>,
): Promise<T> {
	try {
		return await attempt(list)
	} catch (e) {
		const rule = tokenRefusalOf(e)
		if (!resync || !rule || !STALE_LIST_RULES.has(rule) || !refusedBeforeSend(e)) throw e
		return attempt(await resync())
	}
}
