import { describe, expect, it } from "bun:test"
import { TESTNET } from "./networks"
import { checkFeePath, checkL1Wiring, checkNodeIdentity } from "./preflight"

const addr = (s: string) => ({ toString: () => s })
const IDENTITY = {
	nodeVersion: TESTNET.nodeVersion,
	l1ChainId: TESTNET.l1ChainId,
	rollupVersion: TESTNET.rollupVersion,
	l1ContractAddresses: {
		registryAddress: addr(TESTNET.registry),
		inboxAddress: addr(TESTNET.inbox),
		outboxAddress: addr(TESTNET.outbox),
		feeJuicePortalAddress: addr(TESTNET.feeJuicePortal),
		feeAssetHandlerAddress: addr(TESTNET.feeAssetHandler),
	},
}
const failed = (checks: { name: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.name)

describe("probe checks", () => {
	it("pass on the pinned identity, and each drifted field fails by name", () => {
		expect(failed(checkNodeIdentity(IDENTITY, TESTNET))).toEqual([])
		const drifted = {
			...IDENTITY,
			nodeVersion: "5.0.1",
			l1ContractAddresses: { ...IDENTITY.l1ContractAddresses, outboxAddress: addr("0x0000000000000000000000000000000000000001") },
		}
		expect(failed(checkNodeIdentity(drifted, TESTNET))).toEqual(["node version", "outbox"])
	})

	it("fail when the registry's canonical rollup is wired elsewhere (a rollup upgrade)", () => {
		const { l1ChainId: chainId, inbox, outbox, feeJuicePortal } = TESTNET
		const wiring = { chainId, inbox, outbox, feeJuicePortal, version: BigInt(TESTNET.rollupVersion) }
		expect(failed(checkL1Wiring(wiring, TESTNET))).toEqual([])
		expect(failed(checkL1Wiring({ ...wiring, version: 1n }, TESTNET))).toEqual(["registry → rollup → version"])
		expect(failed(checkL1Wiring({ ...wiring, feeJuicePortal: TESTNET.inbox }, TESTNET))).toEqual([
			"registry → rollup → fee juice portal",
		])
	})

	it("gate on the faucet covering the deploy, not on the sponsor's balance, which `demo fund` tops up", () => {
		const fee = { faucetMint: 1000n, deployBudget: 100n, sponsoredBudget: 500n, sponsorPublished: true, sponsorBalance: 0n }
		expect(failed(checkFeePath(fee))).toEqual([])
		expect(failed(checkFeePath({ ...fee, faucetMint: 10n }))).toEqual(["fee faucet mint ≥ deploy budget"])
	})
})
