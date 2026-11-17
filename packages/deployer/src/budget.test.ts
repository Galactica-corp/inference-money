import { describe, expect, it } from "bun:test"
import {
	ESTIMATED_GAS_PER_TX,
	feeBudget,
	MAINNET_ADMIN_RESERVE_TXS,
	MAINNET_ADMIN_TXS,
	MAINNET_DEPLOY_TXS,
	MAINNET_HEADROOM,
	MAINNET_L1_GAS,
	mainnetFunding,
} from "./budget"

describe("feeBudget", () => {
	it("charges every tx its estimated gas at the worst fee of each dimension, independently", () => {
		const budget = feeBudget({
			txCount: 2,
			gasPerTx: { daGas: 10, l2Gas: 100 },
			predicted: [
				{ feePerDaGas: 5n, feePerL2Gas: 1n },
				{ feePerDaGas: 1n, feePerL2Gas: 3n },
			],
			headroom: 3n,
		})
		expect(budget).toBe((10n * 5n + 100n * 3n) * 2n * 3n)
	})

	it("refuses to bound a budget with no fee prediction", () => {
		expect(() => feeBudget({ txCount: 1, gasPerTx: { daGas: 1, l2Gas: 1 }, predicted: [], headroom: 1n })).toThrow(/no predicted fees/)
	})
})

describe("mainnetFunding", () => {
	it("bounds the deployer's Fee Juice at twice the worst fee, the admin's reserve once, and ETH at 3× the gas bound", () => {
		const predicted = [{ feePerDaGas: 0n, feePerL2Gas: 2n * 10n ** 12n }]
		const f = mainnetFunding(predicted, 10n ** 9n)
		const perTx = BigInt(ESTIMATED_GAS_PER_TX.l2Gas) * 2n * 10n ** 12n + BigInt(ESTIMATED_GAS_PER_TX.daGas) * 0n
		expect(f.deployer).toBe(perTx * BigInt(MAINNET_DEPLOY_TXS.length) * MAINNET_HEADROOM)
		expect(f.admin).toBe(perTx * (BigInt(MAINNET_ADMIN_TXS.length) * MAINNET_HEADROOM + BigInt(MAINNET_ADMIN_RESERVE_TXS)))
		expect(f.eth).toBe(MAINNET_L1_GAS * 10n ** 9n * 3n)
	})
})
