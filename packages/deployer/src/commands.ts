import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { signingKeyFor, sponsoredPayment } from "@galactica-net/inference-money-core"
import {
	acceptAdmin,
	addMerchants,
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
import { type Command, type Invocation, parseDelay } from "./cli-args"
import { demoFund, demoReset, demoSetup, demoStatus } from "./demo"
import { DISPOSABLE_FILE, disposableDestroy, disposableExec, disposableInit, INTERIM_ADMIN } from "./disposable"
import { exportBundle } from "./export"
import { deployLocal } from "./local"
import { localManifestPath, writeManifest } from "./manifest"
import { TESTNET } from "./networks"
import { probeNetwork } from "./preflight"
import { scanFailed, scanForSecrets, scanLine } from "./scan"
import { aztecSecretFrom, KEYED, keyedEnv, secretNeedles } from "./secrets"
import { accountFor, adminAccount, adminSecretFor, loadManifest, type Session, withSession } from "./session"
import { smoke } from "./smoke"
import { deployTestnet } from "./testnet"
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

export const HANDLERS: Record<Command, Handler> = {
	async deploy(inv) {
		const merchantDelay = flag(inv, "merchant-delay")
		const opts = { log, ...(merchantDelay ? { merchantDelay: parseDelay(merchantDelay) } : {}) }
		if (inv.args[0] === "local") {
			const { path } = await deployLocal(runIdFor(), opts)
			log(`deploy local: verified, handed over to the local admin; manifest ${path}`)
		} else {
			const m = await deployTestnet(opts)
			log(`deploy testnet: verified with the handover pending; manifest deployments/testnet.json (bridge ${m.l2.bridge.address})`)
		}
		return 0
	},
	/** The address the admin secret rebuilds, derived offline: it goes into the deploy template as TESTNET_ADMIN_ADDRESS. */
	async "admin address"() {
		const secret = aztecSecretFrom(KEYED.adminSecret)
		log((await aztecAddressOf({ secret, signingKey: signingKeyFor(secret) })).toString())
		return 0
	},
	async "admin accept"(inv) {
		const ref = loadManifest(inv.args[0] as string)
		return withSession(ref, {}, async (s) => {
			const admin = await acceptAdmin(s.wallet, s.node, s.m, adminSecretFor(s.m), log)
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
			await proposeAdmin(s.wallet, s.m, admin, next, { paymentMethod: sponsoredPayment(s.m) })
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
		const lines = await describeMerchants({ node: createAztecNodeClient(ref.m.l2.nodeUrl), m: ref.m })
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
		await smoke(loadManifest(inv.args[0] as string), { record: flag(inv, "record"), log })
		return 0
	},
	async export(inv) {
		const out = flag(inv, "out") as string
		for (const file of await exportBundle(loadManifest(inv.args[0] as string).m, out)) log(`wrote ${out}/${file}`)
		return 0
	},
	async "demo setup"(inv) {
		await demoSetup(loadManifest(inv.args[0] as string), { rotate: inv.flags.rotate === true, log })
		return 0
	},
	async "demo status"(inv) {
		await demoStatus(loadManifest(inv.args[0] as string), log)
		return 0
	},
	async "demo reset"(inv) {
		await demoReset(loadManifest(inv.args[0] as string), log)
		return 0
	},
	async "demo fund"(inv) {
		await demoFund(loadManifest(inv.args[0] as string), log)
		return 0
	},
	async "disposable init"() {
		const a = await disposableInit()
		log(`disposable keys written to ${DISPOSABLE_FILE} (0600); fund the L1 address at the Sepolia faucets:`)
		log(`  L1 deployer    ${a.l1}`)
		log(`  L2 deployer    ${a.deployer}`)
		log(`  interim admin  ${a.admin}`)
		return 0
	},
	"disposable exec": (inv) => disposableExec(inv.args),
	async "disposable destroy"(inv) {
		await disposableDestroy(loadManifest(inv.args[0] as string))
		log(`destroyed ${DISPOSABLE_FILE}`)
		return 0
	},
	async probe() {
		const checks = await probeNetwork(TESTNET, keyedEnv()[KEYED.rpcUrl] || TESTNET.defaultL1RpcUrl)
		for (const c of checks) log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`)
		const failed = checks.filter((c) => !c.ok).length
		log(failed === 0 ? `probe testnet: all ${checks.length} checks passed` : `probe testnet: ${failed} failed`)
		return failed === 0 ? 0 : 1
	},
	/** Prints only a yes/no and counts: which secret matched, or where, is never output. */
	async scan() {
		const r = scanForSecrets(REPO_ROOT, secretNeedles(keyedEnv()))
		log(`secrets:scan ${scanLine(r)}`)
		return scanFailed(r) ? 1 : 0
	},
}
