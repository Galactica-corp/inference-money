export interface Gas {
	daGas: number
	l2Gas: number
}

export interface FeesPerGas {
	feePerDaGas: bigint
	feePerL2Gas: bigint
}

/** The L2 txs a testnet deploy sends, paid from the deployer's own Fee Juice: one faucet mint, bridged. */
export const TESTNET_DEPLOY_TXS = [
	"deploy deployer account",
	// Standard contracts the node lacks (testnet: all three), a class and an instance tx each.
	"publish AuthRegistry class",
	"publish AuthRegistry instance",
	"publish PublicChecks class",
	"publish PublicChecks instance",
	"publish HandshakeRegistry class",
	"publish HandshakeRegistry instance",
	"deploy token_minter_proxy",
	"deploy Token",
	"deploy token_bridge",
	"proxy.set_token + proxy.set_bridge",
	"propose both admin roles",
] as const

/**
 * The L2 txs a testnet bring-up sends through the sponsor after the deploy: admin accept, the demo merchants, demo fund
 * and setup, one smoke.
 */
export const TESTNET_SPONSORED_TXS = [
	"deploy admin account",
	"accept both admin roles",
	"list galactica and supplier",
	"deploy galactica",
	"claim the sponsor's Fee Juice",
	"deploy alice",
	"deploy bob",
	"deploy supplier",
	"claim alice's binding deposit",
	"claim bob's binding deposit",
	"claim galactica's float",
	"smoke: claim",
	"smoke: open request",
	"smoke: pay",
	"smoke: refund",
	"smoke: exit",
] as const

/**
 * Per-tx gas estimate. Testnet txs sampled 2026-09-25 paid ≤ 2.02 FJ at p90 with 2.02e12 FJ-wei (1e-18 FJ) per L2 gas
 * (≈ 1.0M L2 gas) and a zero DA fee; 1.5M L2 gas bounds that with margin.
 */
export const ESTIMATED_GAS_PER_TX: Gas = { daGas: 20_000, l2Gas: 1_500_000 }

/** Fee Juice bound for a batch of txs: estimated gas at the worst predicted fee of each dimension, times `headroom`. */
export function feeBudget(p: { txCount: number; gasPerTx: Gas; predicted: readonly FeesPerGas[]; headroom: bigint }): bigint {
	if (p.predicted.length === 0) throw new Error("no predicted fees: cannot bound the budget")
	let worstDa = 0n
	let worstL2 = 0n
	for (const f of p.predicted) {
		if (f.feePerDaGas > worstDa) worstDa = f.feePerDaGas
		if (f.feePerL2Gas > worstL2) worstL2 = f.feePerL2Gas
	}
	const perTx = BigInt(p.gasPerTx.daGas) * worstDa + BigInt(p.gasPerTx.l2Gas) * worstL2
	return perTx * BigInt(p.txCount) * p.headroom
}
