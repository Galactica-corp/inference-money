import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Address, PublicClient } from "viem"
import { REGISTRY_ABI, TOKEN_PORTAL_ABI } from "./abi"
import type { BridgeManifest } from "./manifest"
import type { L1Ctx } from "./types"

/**
 * The chain id Aztec wallets present to dapps: `(l1ChainId XOR rollupVersion)` as an unsigned 32-bit integer. Never the
 * bare rollup version, which no wallet recognizes.
 */
export const walletChainIdOf = (l1ChainId: number, rollupVersion: number): number => (l1ChainId ^ rollupVersion) >>> 0

export interface NodeIdentitySource {
	getNodeInfo(): Promise<{
		nodeVersion: string
		l1ChainId: number
		rollupVersion: number
		l1ContractAddresses: {
			registryAddress: { toString(): string }
			inboxAddress: { toString(): string }
			outboxAddress: { toString(): string }
		}
	}>
}

export interface L2ChainSource {
	getChainInfo(): Promise<{ chainId: { toBigInt(): bigint }; version: { toBigInt(): bigint } }>
	getAccounts(): Promise<{ item: AztecAddress }[]>
}

/** Thrown before anything is signed: the connected network or signer is not the one the manifest names. */
export class NetworkMismatchError extends Error {
	constructor(readonly mismatches: string[]) {
		super(`Refusing to continue: ${mismatches.join("; ")}.`)
		this.name = "NetworkMismatchError"
	}
}

type Pin = [label: string, actual: unknown, expected: unknown]

const addr = (a: { toString(): string }) => a.toString().toLowerCase()

function mismatches(pins: Pin[]): string[] {
	return pins
		.filter(([, actual, expected]) => actual !== expected)
		.map(([label, actual, expected]) => `${label} is ${String(actual)}, expected ${String(expected)}`)
}

/** A verdict read from any chain but the manifest's says nothing about its contracts. */
export async function assertReaderChain(l1: Pick<PublicClient, "getChainId">, chainId: number): Promise<void> {
	const actual = await l1.getChainId()
	if (actual !== chainId) throw new NetworkMismatchError([`the L1 reader's chain is ${actual}, expected ${chainId}`])
}

/**
 * The portal's own deposit test: its bound rollup is still the registry's canonical one. Once Aztec makes another rollup
 * canonical every deposit reverts (`RollupNotCanonical`), while exits keep paying from the bound rollup's outbox.
 */
export async function depositsOpen(l1: Pick<PublicClient, "readContract">, m: BridgeManifest): Promise<boolean> {
	const [canonical, bound] = await Promise.all([
		l1.readContract({ address: m.l1.registry, abi: REGISTRY_ABI, functionName: "getCanonicalRollup" }),
		l1.readContract({ address: m.l1.portal, abi: TOKEN_PORTAL_ABI, functionName: "rollup" }),
	])
	return addr(canonical) === addr(bound)
}

/**
 * The node and the portal must both be on the manifest's network. The portal's stored registry, inbox, outbox and
 * version are pinned rather than the canonical rollup's, so the gate still passes after a rollup switch; it then
 * reports `depositsOpen: false`. A node that followed the new rollup still fails it.
 */
export async function assertNetworkIdentity(
	node: NodeIdentitySource,
	l1: PublicClient,
	m: BridgeManifest,
): Promise<{ depositsOpen: boolean }> {
	const portal = { address: m.l1.portal, abi: TOKEN_PORTAL_ABI } as const
	const [info, chainId, registry, inbox, outbox, version] = await Promise.all([
		node.getNodeInfo(),
		l1.getChainId(),
		l1.readContract({ ...portal, functionName: "registry" }),
		l1.readContract({ ...portal, functionName: "inbox" }),
		l1.readContract({ ...portal, functionName: "outbox" }),
		l1.readContract({ ...portal, functionName: "rollupVersion" }),
	])
	const l1c = info.l1ContractAddresses
	const bad = mismatches([
		["the node version", info.nodeVersion, m.l2.nodeVersion],
		["the node's L1 chain", info.l1ChainId, m.l1.chainId],
		["the node's rollup version", info.rollupVersion, m.l2.rollupVersion],
		["the node's registry", addr(l1c.registryAddress), addr(m.l1.registry)],
		["the node's inbox", addr(l1c.inboxAddress), addr(m.l1.inbox)],
		["the node's outbox", addr(l1c.outboxAddress), addr(m.l1.outbox)],
		["the L1 chain", chainId, m.l1.chainId],
		["the portal's registry", addr(registry), addr(m.l1.registry)],
		["the portal's inbox", addr(inbox), addr(m.l1.inbox)],
		["the portal's outbox", addr(outbox), addr(m.l1.outbox)],
		["the portal's rollup version", version, BigInt(m.l2.rollupVersion)],
	])
	if (bad.length > 0) throw new NetworkMismatchError(bad)
	return { depositsOpen: await depositsOpen(l1, m) }
}

/**
 * The wallets that will sign are on the manifest's chains and still on the accounts the user reviewed. Call it
 * immediately before and after every signature: a wallet can switch chain or account while its prompt is open.
 */
export async function assertSigningContext(
	l1: L1Ctx,
	wallet: L2ChainSource | null,
	m: BridgeManifest,
	expected: { l1Account: Address; l2Account?: AztecAddress },
): Promise<void> {
	const [chainId, [selected]] = await Promise.all([l1.walletClient.getChainId(), l1.walletClient.getAddresses()])
	const pins: Pin[] = [
		["the L1 wallet's chain", chainId, m.l1.chainId],
		["the L1 wallet's account", addr(selected ?? "none"), addr(expected.l1Account)],
		["the signing account", addr(l1.account), addr(expected.l1Account)],
	]
	if (wallet) {
		const [info, accounts] = await Promise.all([wallet.getChainInfo(), expected.l2Account ? wallet.getAccounts() : []])
		pins.push(["the Aztec wallet's L1 chain", info.chainId.toBigInt(), BigInt(m.l1.chainId)])
		pins.push(["the Aztec wallet's rollup version", info.version.toBigInt(), BigInt(m.l2.rollupVersion)])
		const l2 = expected.l2Account
		if (l2 && !accounts.some((a) => a.item.equals(l2))) pins.push(["the Aztec account", "not in the wallet", l2.toString()])
	}
	const bad = mismatches(pins)
	if (bad.length > 0) throw new NetworkMismatchError(bad)
}
