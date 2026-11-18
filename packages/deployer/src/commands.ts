import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { FeeJuicePaymentMethodWithClaim, type FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import { createNodeClient, signingKeyFor } from "@galactica-net/inference-money-core"
import {
	acceptAdmin,
	addMerchants,
	adminFee,
	cancelMerchantChange,
	describeMerchants,
	merchantDelayVerdict,
	proposeAdmin,
	readBackDelay,
	scheduleGuardian,
	scheduleMerchant,
	setMerchantDelay,
	setPaused,
} from "@galactica-net/inference-money-core/deploy"
import { aztecAddressOf } from "@galactica-net/inference-money-demo"
import { REPO_ROOT, runIdFor } from "@galactica-net/inference-money-local-network"
import { type Address, getAddress, isAddress } from "viem"
import { units18 } from "./budget"
import { type Command, type Invocation, parseDelay } from "./cli-args"
import { demoFund, demoReset, demoSetup, demoStatus } from "./demo"
import { disposableDestroy, disposableExec, disposableFile, disposableInit, disposableSweep, INTERIM_ADMIN } from "./disposable"
import { exportBundle } from "./export"
import { loadFeeClaim, removeFeeClaim } from "./fee-claims"
import { deployLive } from "./live"
import { deployLocal } from "./local"
import { localManifestPath, writeManifest } from "./manifest"
import { MAINNET, networkByName } from "./networks"
import { probeNetwork } from "./preflight"
import { scanFailed, scanForSecrets, scanLine } from "./scan"
import { aztecSecretFrom, type KeyedNetwork, keyedEnv, keyedFor, secretNeedles } from "./secrets"
import { accountFor, adminAccount, adminSecretFor, loadManifest, type ManifestRef, type Session, withSession } from "./session"
import { smoke } from "./smoke"
import { DEMO_NETWORKS } from "./verify"
import { verifyManifest } from "./verify-cli"

const log = (m: string) => console.log(m)
type Handler = (inv: Invocation) => Promise<number>

const flag = (inv: Invocation, name: string): string | undefined => {
	const v = inv.flags[name]
	return typeof v === "string" ? v : undefined
}
const aztecAddress = (value: string): AztecAddress => {
	if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("expected an Aztec address (32-byte 0x-hex)")
	return AztecAddress.fromStringUnsafe(value.toLowerCase())
}

/** Runs `fn` as the manifest's admin: the fixed local one, or the keyed run's on testnet. */
const asAdmin = (inv: Invocation, fn: (s: Session, admin: AztecAddress) => Promise<void>): Promise<number> =>
	withSession(loadManifest(inv.args[0] as string), {}, async (s) => {
		await fn(s, await adminAccount(s))
		return 0
	})

const l1Address = (value: string): Address => {
	if (!isAddress(value, { strict: false })) throw new Error("expected an L1 address (20-byte 0x-hex)")
	return getAddress(value)
}

/** The demo cast's keys are public: it runs on local and testnet only, where its funds are demo funds. */
function demoManifest(inv: Invocation): ManifestRef {
	const ref = loadManifest(inv.args[0] as string)
	if (!DEMO_NETWORKS.includes(ref.m.network)) throw new Error(`The demo cast runs on local and testnet only, not ${ref.m.network}.`)
	return ref
}

/**
 * Fee Juice the deploy bridged to the admin but never claimed (its public claim failed), kept on disk: on a network
 * without a sponsor the admin's account deploy claims it instead, when the admin holds none.
 */
async function keptAdminClaim(s: Session, secret: Fr): Promise<{ admin: AztecAddress; method: FeePaymentMethod } | undefined> {
	if (s.m.network === "local" || s.m.l2.sponsoredFpc) return undefined
	const admin = await accountFor(s.wallet, secret)
	const claim = loadFeeClaim(s.m.network, admin)
	if (!claim || (await getFeeJuiceBalance(admin, s.node)) > 0n) return undefined
	log(`admin ${admin}: its account deploy claims the kept Fee Juice (${claim.claimAmount})`)
	return { admin, method: new FeeJuicePaymentMethodWithClaim(admin, claim) }
}

export const HANDLERS: Record<Command, Handler> = {
	async deploy(inv) {
		const merchantDelay = flag(inv, "merchant-delay")
		const opts = { log, ...(merchantDelay ? { merchantDelay: parseDelay(merchantDelay) } : {}) }
		const network = inv.args[0] as "local" | KeyedNetwork
		if (network === "local") {
			const { path } = await deployLocal(runIdFor(), opts)
			log(`deploy local: verified, handed over to the local admin; manifest ${path}`)
		} else {
			const m = await deployLive(network, opts)
			log(
				`deploy ${network}: verified with the handover pending; manifest deployments/${network}.json (bridge ${m.l2.bridge.address})`,
			)
		}
		return 0
	},
	/** The address the network's admin secret rebuilds, derived offline: the deploy proposes to it (<NETWORK>_ADMIN_ADDRESS). */
	async "admin address"(inv) {
		const secret = aztecSecretFrom(keyedFor(inv.args[0] as KeyedNetwork).adminSecret)
		log((await aztecAddressOf({ secret, signingKey: signingKeyFor(secret) })).toString())
		return 0
	},
	async "admin accept"(inv) {
		const ref = loadManifest(inv.args[0] as string)
		return withSession(ref, {}, async (s) => {
			const secret = adminSecretFor(s.m)
			const kept = await keptAdminClaim(s, secret)
			const admin = await acceptAdmin(s.wallet, s.node, s.m, secret, log, kept?.method)
			if (kept) removeFeeClaim(s.m.network, kept.admin)
			const interim = process.env[INTERIM_ADMIN] === "1"
			const { interimAdmin: _, ...l2 } = s.m.l2
			const recorded = { ...l2, admin: admin.toString() as `0x${string}`, ...(interim ? { interimAdmin: true as const } : {}) }
			writeManifest(ref.path, { ...s.m, l2: recorded })
			log(`admin ${admin} accepted the bridge and the merchant admin role${interim ? " (interim)" : ""}; manifest ${ref.path}`)
			return 0
		})
	},
	"admin propose": (inv) =>
		asAdmin(inv, async (s, admin) => {
			const next = aztecAddress(inv.args[1] as string)
			await proposeAdmin(s.wallet, s.m, admin, next, adminFee(s.m))
			log(`proposed both roles to ${next}; it takes them with \`bridge admin accept\``)
		}),
	"merchants add": (inv) =>
		asAdmin(inv, async (s, admin) => {
			const accounts = inv.args.slice(1).map(aztecAddress)
			log(`listed ${accounts.length} merchant(s) in ${await addMerchants(s, admin, accounts)} tx(s)`)
			log(
				"each must already be bound to its own treasury: a merchant's first private claim binds it, for good, and this CLI cannot read a binding",
			)
		}),
	"merchants off": (inv) =>
		asAdmin(inv, async (s, admin) => {
			await scheduleMerchant(s, admin, aztecAddress(inv.args[1] as string), true)
			log("switch-off scheduled: it takes effect after the merchant's delay")
		}),
	"merchants on": (inv) =>
		asAdmin(inv, async (s, admin) => {
			await scheduleMerchant(s, admin, aztecAddress(inv.args[1] as string), false)
			log("switch-on scheduled: it takes effect after the merchant's delay")
		}),
	"merchants delay"(inv) {
		const ref = loadManifest(inv.args[0] as string)
		const requested = parseDelay(inv.args[1] as string)
		return withSession(ref, {}, async (s) => {
			const admin = await adminAccount(s)
			let sendError: string | undefined
			try {
				const { txs, synced } = await setMerchantDelay(s, admin, requested)
				log(`sent the setting and ${synced} merchant sync(s) in ${txs} tx(s)`)
			} catch (e) {
				sendError = e instanceof Error ? e.message : String(e)
			}
			const verdict = merchantDelayVerdict(requested, await readBackDelay(s.node, s.m, requested, sendError))
			if (verdict.record) writeManifest(ref.path, { ...s.m, l2: { ...s.m.l2, merchantDelay: Number(requested) } })
			for (const line of verdict.lines) log(line)
			return verdict.exit
		})
	},
	"merchants guardian": (inv) =>
		asAdmin(inv, async (s, admin) => {
			await scheduleGuardian(s, admin, aztecAddress(inv.args[1] as string))
			log("guardian scheduled: it takes over after the guardian slot's delay")
		}),
	// The admin or the guardian, each with its own key: the token judges which, so the manifest's admin isn't required.
	"merchants cancel": (inv) =>
		withSession(loadManifest(inv.args[0] as string), {}, async (s) => {
			await cancelMerchantChange(s, await accountFor(s.wallet, adminSecretFor(s.m)), aztecAddress(inv.args[1] as string))
			log("pending change cancelled")
			return 0
		}),
	async "merchants list"(inv) {
		const ref = loadManifest(inv.args[0] as string)
		const lines = await describeMerchants({ node: createNodeClient(ref.m.l2.nodeUrl), m: ref.m })
		for (const line of lines) log(line)
		log(`${lines.length} merchant(s) added`)
		return 0
	},
	pause: (inv) =>
		asAdmin(inv, async (s, admin) => {
			await setPaused(s, admin, inv.args[1] === "on")
			log(`bridge ${inv.args[1] === "on" ? "paused" : "unpaused"}`)
		}),
	verify: (inv) => {
		const guardian = flag(inv, "guardian")
		return verifyManifest(loadManifest(inv.args[0] as string), {
			tour: flag(inv, "tour"),
			node: flag(inv, "node"),
			l1Rpc: flag(inv, "l1-rpc"),
			guardian: guardian ? aztecAddress(guardian).toString() : undefined,
			allowPending: inv.flags["allow-pending"] === true,
			log,
		})
	},
	async "manifest-path"() {
		console.log(localManifestPath(runIdFor()))
		return 0
	},
	async smoke(inv) {
		await smoke(demoManifest(inv), { record: flag(inv, "record"), log })
		return 0
	},
	async export(inv) {
		const out = flag(inv, "out") as string
		for (const file of await exportBundle(loadManifest(inv.args[0] as string).m, out)) log(`wrote ${out}/${file}`)
		return 0
	},
	async "demo setup"(inv) {
		await demoSetup(demoManifest(inv), { rotate: inv.flags.rotate === true, log })
		return 0
	},
	async "demo status"(inv) {
		await demoStatus(demoManifest(inv), log)
		return 0
	},
	async "demo reset"(inv) {
		await demoReset(demoManifest(inv), log)
		return 0
	},
	async "demo fund"(inv) {
		await demoFund(demoManifest(inv), log)
		return 0
	},
	async "disposable init"(inv) {
		const network = inv.args[0] as KeyedNetwork
		const a = await disposableInit(network, { admin: flag(inv, "admin"), refund: flag(inv, "refund") })
		log(`disposable keys written to ${disposableFile(network)} (0600)`)
		log(`  L1 deployer    ${a.l1}`)
		log(`  L2 deployer    ${a.deployer}`)
		if (network === "testnet") {
			log(`  interim admin  ${a.admin}`)
			log("fund the L1 address at the Sepolia faucets")
			return 0
		}
		log(`  admin          ${a.admin} (proposed to by the deploy; this bundle holds no admin key)`)
		log(`  refund         ${a.refund} (\`disposable sweep mainnet\` sends leftovers here)`)
		const checks = await probeNetwork(MAINNET, MAINNET.defaultL1RpcUrl)
		for (const c of checks.filter((c) => c.name.startsWith("funding needed"))) log(`fund the L1 address with: ${c.detail}`)
		log(`then check it: bun run bridge probe mainnet --funder ${a.l1}`)
		return 0
	},
	"disposable exec": (inv) => disposableExec(inv.args),
	async "disposable sweep"(inv) {
		const r = await disposableSweep(inv.args[0] as KeyedNetwork)
		log(`swept ${units18(r.feeAsset)} AZTEC and ${units18(r.eth)} ETH to ${r.refund}`)
		return 0
	},
	async "disposable destroy"(inv) {
		const ref = loadManifest(inv.args[0] as string)
		await disposableDestroy(ref)
		log(`destroyed the ${ref.m.network} disposable keys`)
		return 0
	},
	async probe(inv) {
		const pins = networkByName(inv.args[0] as string)
		const keyed = keyedEnv()[keyedFor(pins.name).rpcUrl]
		const funder = flag(inv, "funder")
		const checks = await probeNetwork(pins, keyed || pins.defaultL1RpcUrl, funder ? { funder: l1Address(funder) } : {})
		for (const c of checks) log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`)
		const failed = checks.filter((c) => !c.ok).length
		log(failed === 0 ? `probe ${pins.name}: all ${checks.length} checks passed` : `probe ${pins.name}: ${failed} failed`)
		return failed === 0 ? 0 : 1
	},
	/** Prints only a yes/no and counts: which secret matched, or where, is never output. */
	async scan() {
		const r = scanForSecrets(REPO_ROOT, secretNeedles(keyedEnv()))
		log(`secrets:scan ${scanLine(r)}`)
		return scanFailed(r) ? 1 : 0
	},
}
