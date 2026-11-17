import { rmSync } from "node:fs"
import { join } from "node:path"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { L2AmountClaim } from "@aztec-labs/aztec.js/ethereum"
import { FeeJuicePaymentMethodWithClaim } from "@aztec-labs/aztec.js/fee"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { type BridgeManifest, readBack, sponsoredFpcArtifact, sponsorInstance } from "@galactica-net/inference-money-core"
import { deployBridge, type L1Signer, type L2Fees, l1Signer, proposeAdmin } from "@galactica-net/inference-money-core/deploy"
import { REPO_ROOT } from "@galactica-net/inference-money-local-network"
import { type Address, erc20Abi, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { type MainnetFunding, units18 } from "./budget"
import { type BridgeEvmArtifacts, buildBridgeContracts, forgeRunDir } from "./evm"
import { loadFeeClaim, removeFeeClaim, saveFeeClaim } from "./fee-claims"
import { bridgeFeeJuice, claimFeeJuiceFor, type FeeJuiceSource, waitFeeJuiceReady } from "./fee-juice"
import type { DeployOptions } from "./local"
import { writeManifest } from "./manifest"
import { type NetworkPins, networkByName } from "./networks"
import { probeNetwork, readMainnetFunding } from "./preflight"
import { aztecSecretFrom, type KeyedNetwork, keyedEnv, keyedFor, l1PrivateKeyFrom, scrubbedEnv } from "./secrets"
import { accountFor } from "./session"
import { sourceCommit } from "./source-commit"
import { assertAllPass, verifyDeployment } from "./verify"
import { withBridgeWallet } from "./wallet"

export const liveManifestPath = (network: KeyedNetwork): string => join(REPO_ROOT, "deployments", `${network}.json`)
export const TESTNET_MANIFEST = liveManifestPath("testnet")

/**
 * Always `--force` into a forge dir of this invocation's own, removed once the artifacts are in memory: no stale cache
 * or concurrent command can reach a live deploy.
 */
export function buildFresh(): BridgeEvmArtifacts {
	const run = `fresh-${process.pid}`
	try {
		return buildBridgeContracts(run, true, scrubbedEnv())
	} finally {
		rmSync(forgeRunDir(run), { recursive: true, force: true })
	}
}

export interface LiveL1 {
	l1: L1Signer
	l1RpcUrl: string
	l1PrivateKey: Hex
}

/** The L1 side of a keyed run on `pins`'s network: its key and RPC, from that network's variables alone. */
export function liveL1(pins: NetworkPins, env: NodeJS.ProcessEnv = keyedEnv()): LiveL1 {
	const names = keyedFor(pins.name)
	const l1PrivateKey = l1PrivateKeyFrom(env, names)
	const l1RpcUrl = env[names.rpcUrl] || pins.defaultL1RpcUrl
	return { l1: l1Signer(l1RpcUrl, pins.l1ChainId, privateKeyToAccount(l1PrivateKey)), l1RpcUrl, l1PrivateKey }
}

/** The plain admin address the deploy proposes to, from the `bridge admin address <network>` run's output. */
export function adminAddressFrom(network: KeyedNetwork, env: NodeJS.ProcessEnv = process.env): AztecAddress {
	const name = keyedFor(network).adminAddress
	const value = env[name] ?? ""
	if (!/^0x[0-9a-f]{64}$/.test(value)) {
		throw new Error(`${name} is not an Aztec address: set it to the \`bridge admin address ${network}\` run's output first`)
	}
	return AztecAddress.fromStringUnsafe(value)
}

/** The deployer account's first tx claims the Fee Juice bridged to it; every later tx pays from that balance. */
function selfFundedFees(pins: NetworkPins, keys: LiveL1, node: AztecNode, source: FeeJuiceSource, log: (m: string) => void): L2Fees {
	return {
		accountDeploy: async (account: AztecAddress) => {
			const bridge = { pins, l1RpcUrl: keys.l1RpcUrl, l1PrivateKey: keys.l1PrivateKey }
			const claim = await bridgeFeeJuice({ ...bridge, node, to: account, source, log })
			return new FeeJuicePaymentMethodWithClaim(account, claim)
		},
		tx: undefined,
	}
}

/** Refuses before anything is spent unless the L1 key holds the fee asset both bridges take and the gas bound. */
async function assertFunded(keys: LiveL1, feeAsset: Address, funding: MainnetFunding): Promise<void> {
	const owner = keys.l1.account.address
	const [asset, eth] = await Promise.all([
		keys.l1.publicClient.readContract({ address: feeAsset, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
		keys.l1.publicClient.getBalance({ address: owner }),
	])
	const needed = funding.deployer + funding.admin
	if (asset < needed || eth < funding.eth) {
		throw new Error(
			`${owner} holds ${units18(asset)} AZTEC and ${units18(eth)} ETH; the deploy needs ${units18(needed)} AZTEC and ${units18(funding.eth)} ETH`,
		)
	}
}

/**
 * Without a sponsor the admin pays its own way: its Fee Juice is bridged before anything else is spent and kept on disk
 * until claimed, so a deploy that fails later never strands it.
 */
async function bridgeAdminFeeJuice(p: {
	pins: NetworkPins
	keys: LiveL1
	node: AztecNode
	admin: AztecAddress
	amount: bigint
	log: (m: string) => void
}): Promise<L2AmountClaim> {
	const prior = loadFeeClaim(p.pins.name, p.admin)
	if (prior) throw new Error(`an unclaimed Fee Juice claim for ${p.admin} is on disk: claim it, or remove it once you know it landed`)
	const bridge = { pins: p.pins, l1RpcUrl: p.keys.l1RpcUrl, l1PrivateKey: p.keys.l1PrivateKey }
	const claim = await bridgeFeeJuice({ ...bridge, node: p.node, to: p.admin, source: { amount: p.amount }, waitReady: false, log: p.log })
	p.log(`admin's Fee Juice claim kept at ${saveFeeClaim(p.pins.name, p.admin, claim)} until it lands`)
	return claim
}

/** The deployer claims the admin's Fee Juice publicly into its balance; the kept claim goes once the balance shows it. */
export async function claimAdminFeeJuice(p: {
	network: KeyedNetwork
	wallet: EmbeddedWallet
	node: AztecNode
	deployer: AztecAddress
	admin: AztecAddress
	claim: L2AmountClaim
	log: (m: string) => void
}): Promise<void> {
	await waitFeeJuiceReady(p.node, p.claim, p.log)
	await claimFeeJuiceFor({ wallet: p.wallet, from: p.deployer, to: p.admin, claim: p.claim })
	const balance = await getFeeJuiceBalance(p.admin, p.node)
	if (balance < p.claim.claimAmount) throw new Error(`the admin's Fee Juice claim was sent, but ${p.admin} holds ${balance}`)
	removeFeeClaim(p.network, p.admin)
	p.log(`admin ${p.admin} holds ${units18(balance)} Fee Juice`)
}

/** Pins the sponsor a network names (testnet), refused unless it is the canonical class at salt 0. */
async function registerPinnedSponsor(wallet: EmbeddedWallet, pins: NetworkPins): Promise<void> {
	if (!pins.sponsoredFpc) return
	const sponsor = await sponsorInstance()
	if (sponsor.address.toString() !== pins.sponsoredFpc) throw new Error(`the pinned sponsor derives to ${sponsor.address}`)
	await wallet.registerContract(sponsor, sponsoredFpcArtifact)
}

/**
 * Probes the pins (nothing is spent unless every one holds), deploys with real client proofs, proposes both admin roles
 * to the network's admin address, verifies every read-back with that handover pending, and only then writes
 * `deployments/<network>.json`. Testnet pays from the fee faucet; mainnet bridges a budgeted amount of the AZTEC the L1
 * key holds, to the deployer and to the admin, which has no sponsor to accept through. The deploy keys hold no role
 * once the admin accepts (`bridge admin accept`).
 */
export async function deployLive(network: KeyedNetwork, opts: DeployOptions): Promise<BridgeManifest> {
	const { log } = opts
	const pins = networkByName(network)
	const keys = liveL1(pins)
	const deployerSecret = aztecSecretFrom(keyedFor(network).deployerSecret)
	const admin = adminAddressFrom(network)
	assertAllPass(await probeNetwork(pins, keys.l1RpcUrl, { funder: keys.l1.account.address }), log)
	const evm = buildFresh()
	const manifest = await withBridgeWallet(pins.nodeUrl, { prove: true }, async (wallet, node) => {
		await registerPinnedSponsor(wallet, pins)
		const funding = pins.feeAsset ? await readMainnetFunding(node, keys.l1.publicClient) : undefined
		if (funding && pins.feeAsset) await assertFunded(keys, pins.feeAsset, funding)
		const adminClaim = funding ? await bridgeAdminFeeJuice({ pins, keys, node, admin, amount: funding.admin, log }) : undefined
		const source: FeeJuiceSource = funding ? { amount: funding.deployer } : { faucet: true }
		const m = await deployBridge({
			network,
			l1: keys.l1,
			evm,
			node,
			nodeUrl: pins.nodeUrl,
			wallet,
			usdc: pins.usdc,
			permit2: pins.permit2,
			registry: pins.registry,
			deployerSecret,
			sourceCommit: sourceCommit(),
			fees: selfFundedFees(pins, keys, node, source, log),
			merchantDelay: opts.merchantDelay,
			sponsoredFpc: pins.sponsoredFpc as Hex | undefined,
			log,
		})
		const deployer = await accountFor(wallet, deployerSecret)
		await proposeAdmin(wallet, m, deployer, admin)
		log(`handover proposed to ${admin}: accept it with \`bridge admin accept\``)
		const verify = () => verifyDeployment(m, evm, keys.l1.publicClient, node, { pendingTo: admin.toString() })
		assertAllPass(await readBack(verify, (checks) => checks.every((c) => c.ok)), log)
		writeManifest(liveManifestPath(network), m)
		if (adminClaim) await claimAdminFeeJuice({ network, wallet, node, deployer, admin, claim: adminClaim, log })
		return m
	})
	return manifest
}
