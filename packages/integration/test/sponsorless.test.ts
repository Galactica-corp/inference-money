import { describe, expect, it } from "bun:test"
import { FeeJuicePaymentMethodWithClaim } from "@aztec-labs/aztec.js/fee"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import { type BridgeManifest, isBridgePaused, randomSecret } from "@galactica-net/inference-money-core"
import { acceptAdmin, deployBridge, type L2Fees, proposeAdmin, readRoles, setPaused } from "@galactica-net/inference-money-core/deploy"
import {
	accountFor,
	bridgeFeeJuice,
	buildBridgeContracts,
	claimAdminFeeJuice,
	type FeeJuiceSource,
	l1Signer,
	verifyDeployment,
} from "@galactica-net/inference-money-deployer"
import { L1_CHAIN_ID } from "@galactica-net/inference-money-local-network"
import { type Address, type Hex, parseAbi } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { harness, INTEGRATION } from "./harness"

const HANDLER_ABI = parseAbi(["function mint(address)", "function mintAmount() view returns (uint256)"])
const PORTAL_ABI = parseAbi(["function UNDERLYING() view returns (address)"])
const quiet = () => {}

/**
 * Mainnet's fee path on this run's network: no sponsor, no faucet at bridge time. The L1 key holds the fee asset already
 * (minted here first), bridges set amounts of it, and every L2 tx, the admin's included, pays from Fee Juice.
 */
describe.skipIf(!INTEGRATION)("a deployment without a sponsor", () => {
	it("deploys from held fee asset, funds the admin, who accepts, pauses and unpauses from its own Fee Juice", async () => {
		const { node, wallet, l1, manifest: base, runId } = harness()
		const key = generatePrivateKey()
		const signer = l1Signer(l1.rpcUrl, L1_CHAIN_ID, privateKeyToAccount(key))
		await l1.test.setBalance({ address: signer.account.address, value: 10n ** 20n })
		const { feeJuicePortalAddress, feeAssetHandlerAddress } = (await node.getNodeInfo()).l1ContractAddresses
		if (!feeAssetHandlerAddress) throw new Error("the local network deployed no fee asset handler")
		const handler = feeAssetHandlerAddress.toString() as Address
		const feeJuicePortal = feeJuicePortalAddress.toString() as Address
		const feeAsset = await l1.publicClient.readContract({ address: feeJuicePortal, abi: PORTAL_ABI, functionName: "UNDERLYING" })
		const minted = await l1.publicClient.readContract({ address: handler, abi: HANDLER_ABI, functionName: "mintAmount" })
		const mint = await signer.walletClient.writeContract({
			address: handler,
			abi: HANDLER_ABI,
			functionName: "mint",
			args: [signer.account.address],
			account: signer.account,
			chain: signer.chain,
		})
		await l1.publicClient.waitForTransactionReceipt({ hash: mint })

		// No handler pinned: the funder can only bridge what it holds, as on mainnet.
		const pins = { l1ChainId: L1_CHAIN_ID, feeJuicePortal, feeAsset }
		const bridge = (to: Parameters<typeof bridgeFeeJuice>[0]["to"], source: FeeJuiceSource, waitReady = true) =>
			bridgeFeeJuice({ node, pins, l1RpcUrl: l1.rpcUrl, l1PrivateKey: key as Hex, to, source, waitReady, log: quiet })
		const quarter = minted / 4n
		const fees: L2Fees = {
			accountDeploy: async (account) => new FeeJuicePaymentMethodWithClaim(account, await bridge(account, { amount: quarter })),
			tx: undefined,
		}

		const deployerSecret = randomSecret()
		const adminSecret = randomSecret()
		const admin = await accountFor(wallet, adminSecret)
		const adminClaim = await bridge(admin, { amount: quarter }, false)
		const evm = buildBridgeContracts(runId, false, process.env)
		const deployed = await deployBridge({
			network: "local",
			l1: signer,
			evm,
			node,
			nodeUrl: base.l2.nodeUrl,
			wallet,
			usdc: base.l1.usdc,
			permit2: base.l1.permit2,
			deployerSecret,
			sourceCommit: base.sourceCommit,
			fees,
			sponsoredFpc: undefined,
			log: quiet,
		})
		expect(deployed.l2.sponsoredFpc).toBeUndefined()
		const deployer = await accountFor(wallet, deployerSecret)
		await proposeAdmin(wallet, deployed, deployer, admin)
		await claimAdminFeeJuice({ network: "mainnet", wallet, node, deployer, admin, claim: adminClaim, log: quiet })
		expect(await getFeeJuiceBalance(admin, node)).toBe(quarter)

		expect(await acceptAdmin(wallet, node, deployed, adminSecret, quiet)).toEqual(admin)
		const m: BridgeManifest = { ...deployed, l2: { ...deployed.l2, admin: admin.toString() as Hex } }
		const s = { wallet, node, m }
		await setPaused(s, admin, true)
		expect(await isBridgePaused(node, m)).toBe(true)
		await setPaused(s, admin, false)
		expect(await isBridgePaused(node, m)).toBe(false)
		expect(await getFeeJuiceBalance(admin, node)).toBeLessThan(quarter)

		const failing = (await verifyDeployment(m, evm, l1.publicClient, node)).filter((c) => !c.ok).map((c) => c.name)
		expect(failing).toEqual([])

		// A claim nobody sent yet: the next admin's account deploy consumes it itself.
		const nextSecret = randomSecret()
		const next = await accountFor(wallet, nextSecret)
		const kept = await bridge(next, { amount: quarter / 2n })
		await proposeAdmin(wallet, m, admin, next)
		const viaClaim = new FeeJuicePaymentMethodWithClaim(next, kept)
		expect(await acceptAdmin(wallet, node, m, nextSecret, quiet, viaClaim)).toEqual(next)
		const roles = await readRoles(node, m)
		expect([roles.owner.toString(), roles.admin.toString()]).toEqual([next.toString(), next.toString()])
	})

	it("refuses an admin accept before proving when the admin holds no Fee Juice and nothing pays for it", async () => {
		const { node, wallet, manifest } = harness()
		const sponsorless = { ...manifest, l2: { ...manifest.l2, sponsoredFpc: undefined } }
		await expect(acceptAdmin(wallet, node, sponsorless, randomSecret(), quiet)).rejects.toThrow("holds no Fee Juice")
	})
})
