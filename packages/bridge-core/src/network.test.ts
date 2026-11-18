import { describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { PublicClient, WalletClient } from "viem"
import { assertNetworkIdentity, assertSigningContext, depositsOpen, NetworkMismatchError, walletChainIdOf } from "./network"
import { MANIFEST as M } from "./test/fixtures"

const ROLLUP = "0x00000000000000000000000000000000000000cc"
const OTHER = "0x00000000000000000000000000000000000000ee"

function l1Reads(over: Partial<Record<string, unknown>> = {}): PublicClient {
	const reads: Record<string, unknown> = {
		getCanonicalRollup: ROLLUP,
		rollup: ROLLUP.toUpperCase().replace("0X", "0x"),
		registry: M.l1.registry,
		inbox: M.l1.inbox.toUpperCase().replace("0X", "0x"),
		outbox: M.l1.outbox,
		rollupVersion: BigInt(M.l2.rollupVersion),
		...over,
	}
	return {
		getChainId: async () => (over.chainId as number | undefined) ?? M.l1.chainId,
		readContract: async ({ functionName }: { functionName: string }) => reads[functionName],
	} as unknown as PublicClient
}

const node = (over: Record<string, unknown> = {}) => ({
	getNodeInfo: async () => ({
		nodeVersion: M.l2.nodeVersion,
		l1ChainId: M.l1.chainId,
		rollupVersion: M.l2.rollupVersion,
		l1ContractAddresses: { registryAddress: M.l1.registry, inboxAddress: M.l1.inbox, outboxAddress: M.l1.outbox },
		...over,
	}),
})

describe("walletChainIdOf", () => {
	it("is testnet's wallet-visible id, never the bare rollup version", () => {
		expect(walletChainIdOf(11155111, 1821665230)).toBe(1816023401)
		expect(walletChainIdOf(11155111, 1821665230)).not.toBe(1821665230)
		expect(walletChainIdOf(0xffffffff, 1)).toBeGreaterThan(0)
	})
})

describe("assertNetworkIdentity", () => {
	it("passes on the manifest's network with deposits open (addresses compared case-insensitively)", async () => {
		expect(await assertNetworkIdentity(node(), l1Reads(), M)).toEqual({ depositsOpen: true })
	})

	it("passes with deposits closed once the registry's canonical rollup moved", async () => {
		const moved = l1Reads({ getCanonicalRollup: OTHER })
		expect(await assertNetworkIdentity(node(), moved, M)).toEqual({ depositsOpen: false })
		expect(await depositsOpen(moved, M)).toBe(false)
	})

	it.each([
		["node version", node({ nodeVersion: "5.0.1" }), l1Reads()],
		["node rollup", node({ rollupVersion: 1 }), l1Reads()],
		[
			"node outbox",
			node({ l1ContractAddresses: { registryAddress: M.l1.registry, inboxAddress: M.l1.inbox, outboxAddress: OTHER } }),
			l1Reads(),
		],
		["L1 chain", node(), l1Reads({ chainId: 1 })],
		["portal registry", node(), l1Reads({ registry: OTHER })],
		["portal outbox", node(), l1Reads({ outbox: OTHER })],
		["portal rollup version", node(), l1Reads({ rollupVersion: 1n })],
		["portal registry, after a switch", node(), l1Reads({ registry: OTHER, getCanonicalRollup: OTHER })],
	])("refuses a different %s", async (_, n, l1) => {
		await expect(assertNetworkIdentity(n, l1, M)).rejects.toBeInstanceOf(NetworkMismatchError)
	})
})

describe("assertSigningContext", () => {
	const account = "0x00000000000000000000000000000000000000aa" as const
	const l2Account = AztecAddress.fromBigIntUnsafe(7n)
	const l1 = (chainId: number, selected: string) => ({
		publicClient: l1Reads(),
		walletClient: { getChainId: async () => chainId, getAddresses: async () => [selected] } as unknown as WalletClient,
		account,
	})
	const aztec = (version: number, accounts: AztecAddress[]) => ({
		getChainInfo: async () => ({ chainId: new Fr(M.l1.chainId), version: new Fr(version) }),
		getAccounts: async () => accounts.map((item) => ({ item })),
	})

	it("passes when both wallets are on the reviewed chains and accounts", async () => {
		await assertSigningContext(l1(M.l1.chainId, account), aztec(M.l2.rollupVersion, [l2Account]), M, { l1Account: account, l2Account })
	})

	it("refuses a switched L1 chain or account, and a different Aztec rollup or account", async () => {
		const ok = aztec(M.l2.rollupVersion, [l2Account])
		for (const [ctx, wallet] of [
			[l1(1, account), ok],
			[l1(M.l1.chainId, "0x00000000000000000000000000000000000000bb"), ok],
			[l1(M.l1.chainId, account), aztec(1, [l2Account])],
			[l1(M.l1.chainId, account), aztec(M.l2.rollupVersion, [])],
		] as const) {
			await expect(assertSigningContext(ctx, wallet, M, { l1Account: account, l2Account })).rejects.toBeInstanceOf(
				NetworkMismatchError,
			)
		}
	})
})
