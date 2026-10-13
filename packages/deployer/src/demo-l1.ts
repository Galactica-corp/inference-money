import type { BridgeManifest } from "@galactica-net/inference-money-core"
import { type L1Signer, l1Chain, writeEvm } from "@galactica-net/inference-money-core/deploy"
import { approvePermit2, DEMO_L1_TARGET, demoL1, MERCHANTS, USERS, usdcOf } from "@galactica-net/inference-money-demo"
import { type Address, createTestClient, erc20Abi, http, parseAbi } from "viem"

const MOCK_USDC_ABI = parseAbi(["function mint(address to, uint256 amount)"])

/** Where top-ups come from: anvil itself on local, the keyed L1 account on testnet. ETH arrives before USDC. */
export interface Faucet {
	eth(to: Address, target: bigint, short: bigint): Promise<void>
	usdc(to: L1Signer, short: bigint): Promise<void>
}

/** Local only: anvil sets the balance, and MockUsdc mints to anyone, so the recipient mints its own. */
export function anvilFaucet(rpcUrl: string, m: BridgeManifest): Faucet {
	const test = createTestClient({ chain: l1Chain(rpcUrl, m.l1.chainId), mode: "anvil", transport: http(rpcUrl) })
	return {
		eth: (address, target) => test.setBalance({ address, value: target }),
		usdc: async (to, short) => {
			await writeEvm(to, "MockUsdc mint", m.l1.usdc, MOCK_USDC_ABI, "mint", [to.account.address, short])
		},
	}
}

/** Transfers from `funder`, which must hold enough of both. */
export function signerFaucet(funder: L1Signer, m: BridgeManifest): Faucet {
	return {
		eth: async (to, _target, short) => {
			const hash = await funder.walletClient.sendTransaction({ to, value: short, account: funder.account, chain: funder.chain })
			const receipt = await funder.publicClient.waitForTransactionReceipt({ hash })
			if (receipt.status !== "success") throw new Error(`ETH transfer to ${to} reverted (tx ${hash})`)
		},
		usdc: async (to, short) => {
			await writeEvm(funder, "USDC transfer", m.l1.usdc, erc20Abi, "transfer", [to.account.address, short])
		},
	}
}

/** Tops each cast member's Ethereum account up to {@link DEMO_L1_TARGET} and approves Permit2 from each; holdings above it stay. */
export async function fundDemoL1(rpcUrl: string, m: BridgeManifest, faucet: Faucet, log: (m: string) => void): Promise<void> {
	for (const actor of [...USERS, ...MERCHANTS]) {
		const signer = demoL1(rpcUrl, m, actor)
		const address = signer.account.address
		const target = DEMO_L1_TARGET[actor]
		const eth = target.eth - (await signer.publicClient.getBalance({ address }))
		if (eth > 0n) await faucet.eth(address, target.eth, eth)
		const usdc = target.usdc - (await usdcOf(signer, m, address))
		if (usdc > 0n) await faucet.usdc(signer, usdc)
		await approvePermit2(signer, m, target.usdc)
		log(`${actor}'s Ethereum account ${address}: topped up to ${target.eth} wei and ${target.usdc} USDC units`)
	}
}
