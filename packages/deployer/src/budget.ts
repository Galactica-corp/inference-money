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

/**
 * The L2 txs a mainnet deploy sends from the deployer's own Fee Juice: AuthRegistry is already published there
 * (checked 2026-11-17), so two standard contracts, plus the public claim that funds the admin.
 */
export const MAINNET_DEPLOY_TXS = [
	"deploy deployer account",
	"publish PublicChecks class",
	"publish PublicChecks instance",
	"publish HandshakeRegistry class",
	"publish HandshakeRegistry instance",
	"deploy token_minter_proxy",
	"deploy Token",
	"deploy token_bridge",
	"proxy.set_token + proxy.set_bridge",
	"propose both admin roles",
	"claim the admin's Fee Juice",
] as const

/** Admin txs a mainnet deploy pre-funds, so an emergency pause never waits on a top-up. */
export const MAINNET_ADMIN_RESERVE_TXS = 20

/** The admin's own txs on mainnet: its account deploy and the accept, then the reserve. */
export const MAINNET_ADMIN_TXS = ["deploy admin account", "accept both admin roles"] as const

/** Fee Juice is not withdrawable from L2, so a mainnet deploy bridges a bound, not a balance: 2× today's worst fee. */
export const MAINNET_HEADROOM = 2n

/**
 * A bound on the L1 gas a mainnet deploy and its sweep spend: the portal and router creates, `initialize`, an approve
 * and a deposit for each of the two Fee Juice bridges, and the sweep's two transfers.
 */
export const MAINNET_L1_GAS = 8_000_000n

export interface MainnetFunding {
	/** Fee Juice (= fee asset units) bridged to the deployer. */
	deployer: bigint
	/** Fee Juice bridged to the admin's address and claimed for it: its own txs with headroom, then the reserve. */
	admin: bigint
	/** ETH the L1 key needs at `gasPrice` for {@link MAINNET_L1_GAS}, times 3 for a fee spike mid-run. */
	eth: bigint
}

/** What a mainnet deploy bridges and spends, from the node's predicted fees and the L1 gas price. */
export function mainnetFunding(predicted: readonly FeesPerGas[], gasPrice: bigint): MainnetFunding {
	const bound = (txCount: number, headroom: bigint) => feeBudget({ txCount, gasPerTx: ESTIMATED_GAS_PER_TX, predicted, headroom })
	return {
		deployer: bound(MAINNET_DEPLOY_TXS.length, MAINNET_HEADROOM),
		// The reserve is margin already: its txs are counted once.
		admin: bound(MAINNET_ADMIN_TXS.length, MAINNET_HEADROOM) + bound(MAINNET_ADMIN_RESERVE_TXS, 1n),
		eth: MAINNET_L1_GAS * gasPrice * 3n,
	}
}

/** 18-decimal units as a short decimal string. */
export const units18 = (v: bigint): string => (Number(v / 10n ** 14n) / 1e4).toFixed(4)
