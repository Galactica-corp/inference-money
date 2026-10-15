import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import {
	type ClaimTicket,
	type DepositDraft,
	decodeClaimTicket,
	decodeDepositDraft,
	encodeTicket,
	fundingAddress,
	l2UsdcBalance,
	merchantStatus,
	reconcileDeposit,
	sponsorInstance,
	syncMerchantList,
	waitClaimFinalized,
} from "@galactica-net/inference-money-core"
import { addMerchants, l1Signer } from "@galactica-net/inference-money-core/deploy"
import {
	type CastKeys,
	castClaim,
	castDeposit,
	DEMO_SEED,
	type DepositPlan,
	demoL1,
	l1CtxOf,
	MERCHANTS,
	type Merchant,
	newMerchantsSalt,
	newUsersTag,
	type PriorDraft,
	resetAmount,
	sendPrivate,
	sponsoredFee,
	USERS,
	usdcOf,
} from "@galactica-net/inference-money-demo"
import { castKeysOf, type DemoFile, demoFilePath, readDemoFile, writeDemoFile } from "@galactica-net/inference-money-demo/files"
import { isAddressEqual } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { keepUntilFinal, type ReclaimSteps } from "./claim-finality"
import { deployPlayers, enlist, type Log, logWait, type Player, sponsorClaimer, withHeartbeat } from "./demo-flows"
import { anvilFaucet, fundDemoL1, signerFaucet } from "./demo-l1"
import { topUpSponsor } from "./fee-juice"
import { TESTNET } from "./networks"
import { probeNetwork } from "./preflight"
import { keepAbandonedDraft, type StateDir, withStateDir } from "./run-state"
import { l1PrivateKeyFrom } from "./secrets"
import { adminAccount, type ManifestRef, type Session, withSession } from "./session"
import { assertAllPass } from "./verify"

export { demoFilePath, readDemoFile }

export function castKeysFor(ref: ManifestRef): CastKeys {
	const f = readDemoFile(ref)
	if (!f) throw new Error(`This deployment's demo is not set up: run \`bridge demo setup ${ref.path}\` first.`)
	return castKeysOf(f)
}

/** The salt `--rotate` keeps, so the listed merchants keep their accounts; a version-1 demo has none to keep. */
export function keptSalt(published: DemoFile | undefined): string | undefined {
	if (published?.version === 1) {
		throw new Error("This deployment's demo predates the merchants' salt, so --rotate cannot keep its merchants: redeploy.")
	}
	return published?.merchantsSalt
}

/**
 * What `demo setup` deposits: first each merchant's from its own treasury, which binds it there before it is listed;
 * then alice's and bob's, which bind them to A_demo and B_demo, and galactica's public float.
 */
export const BIND_SEEDS = ["galacticaBind", "supplierBind"] as const
export const USER_SEEDS = ["alice", "bob", "galactica"] as const
export type BindSeed = (typeof BIND_SEEDS)[number]
export type Seed = BindSeed | (typeof USER_SEEDS)[number]
const BIND_MERCHANT: Record<BindSeed, Merchant> = { galacticaBind: "galactica", supplierBind: "supplier" }

/** Private until published: the drawn tag and salt and each seed's draft or ticket, so an interrupted setup resumes. */
export interface SetupPlan {
	tag: string
	merchantsSalt: string
	drafts: Partial<Record<Seed, string>>
	tickets: Partial<Record<Seed, string>>
}

/** Nothing here deletes a deposit secret: a draft or a finished plan moves where no resume reads it. */
export interface PlanStore {
	read(): SetupPlan | undefined
	write(p: SetupPlan): void
	/** Keeps a draft the L1 reader called never sent (`PriorDraft.abandon`'s contract). */
	abandon(d: DepositDraft): void
	/** Moves the finished plan out of the resume's way, its tickets with it. */
	archive(tag: string): void
}

/** What `demo setup` publishes: a version-2 demo's keys. */
export interface SetupKeys {
	usersTag: string
	merchantsSalt: string
}

export interface SetupOps {
	/** Funds what the network lacks, then deploys the cast's accounts. */
	prepare(keys: SetupKeys): Promise<void>
	/** Whether `seed`'s merchant is bound to its own treasury; throws if it is bound anywhere else. */
	bound(seed: BindSeed): Promise<boolean>
	/** Lists the demo merchants, or throws the instruction to list them. */
	list(): Promise<void>
	deposit(seed: Seed, tag: string, prior: PriorDraft | undefined, persist: (d: DepositDraft) => void): Promise<ClaimTicket>
	claim(t: ClaimTicket): Promise<void>
	final: ReclaimSteps
}

async function seedTicket(plan: SetupPlan, seed: Seed, store: PlanStore, ops: SetupOps): Promise<ClaimTicket> {
	const stored = plan.tickets[seed]
	if (stored) return decodeClaimTicket(stored)
	const draft = plan.drafts[seed] === undefined ? undefined : decodeDepositDraft(plan.drafts[seed])
	const persist = (d: DepositDraft) => {
		plan.drafts[seed] = encodeTicket("draft", d)
		store.write(plan)
	}
	const t = await ops.deposit(seed, plan.tag, draft && { draft, abandon: () => store.abandon(draft) }, persist)
	plan.tickets[seed] = encodeTicket("claim", t)
	delete plan.drafts[seed]
	store.write(plan)
	return t
}

async function seedAll(plan: SetupPlan, seeds: readonly Seed[], store: PlanStore, ops: SetupOps): Promise<void> {
	const tickets: ClaimTicket[] = []
	for (const seed of seeds) tickets.push(await seedTicket(plan, seed, store, ops))
	for (const t of tickets) await ops.claim(t)
	for (const t of tickets) await keepUntilFinal(t, ops.final)
}

/**
 * Lists the merchants only once their treasury bindings are final and read back (a listed merchant's first private
 * claim would bind it to whoever deposited), and publishes the tag and salt only once every claim is final, since
 * anyone holding them could take a pruned binding. The archived plan keeps its secrets: "finalized" is the node's
 * word, and a claim it wrongly vouched for needs its secret again. `kept` hands a new plan a published salt.
 */
export async function runSetup(store: PlanStore, ops: SetupOps, publish: (keys: SetupKeys) => void, kept?: string): Promise<void> {
	const plan = store.read() ?? { tag: newUsersTag(), merchantsSalt: kept ?? newMerchantsSalt(), drafts: {}, tickets: {} }
	store.write(plan)
	const keys = { usersTag: plan.tag, merchantsSalt: plan.merchantsSalt }
	await ops.prepare(keys)
	const binds: BindSeed[] = []
	for (const seed of BIND_SEEDS) {
		const bound = await ops.bound(seed)
		if (plan.tickets[seed] || plan.drafts[seed] || !bound) binds.push(seed)
	}
	await seedAll(plan, binds, store, ops)
	for (const seed of BIND_SEEDS) {
		if (!(await ops.bound(seed))) throw new Error(`${BIND_MERCHANT[seed]}'s binding claim left it unbound`)
	}
	await ops.list()
	await seedAll(plan, USER_SEEDS, store, ops)
	publish(keys)
	store.archive(plan.tag)
}

const SEED_PLANS: Record<Seed, (p: Record<string, Player>) => DepositPlan> = {
	galacticaBind: (p) => ({ from: "galactica", to: p.galactica!.address, kind: "private", amount: DEMO_SEED.merchantBind }),
	supplierBind: (p) => ({ from: "supplier", to: p.supplier!.address, kind: "private", amount: DEMO_SEED.merchantBind }),
	alice: (p) => ({ from: "alice", to: p.alice!.address, kind: "private", amount: DEMO_SEED.alice }),
	bob: (p) => ({ from: "bob", to: p.bob!.address, kind: "private", amount: DEMO_SEED.bob }),
	galactica: (p) => ({ from: "alice", to: p.galactica!.address, kind: "public", amount: DEMO_SEED.galactica }),
}

/** Local: the local admin lists any demo merchant not listed yet. Testnet: the admin must have listed both. */
async function ensureMerchantsListed(s: Session, players: Record<string, Player>, log: Log): Promise<void> {
	const list = await syncMerchantList(s.node, AztecAddress.fromStringUnsafe(s.m.l2.token.address))
	const missing = MERCHANTS.map((actor) => players[actor]!.address).filter((a) => !merchantStatus(list, a).merchant)
	if (missing.length === 0) return
	if (s.m.network !== "local") {
		throw new Error(`List the demo merchants first: bun run bridge merchants add ${s.ref.path} ${missing.join(" ")}`)
	}
	await addMerchants(s, await adminAccount(s), missing)
	log(`listed the demo merchants ${missing.join(", ")}`)
}

function liveSetupOps(s: Session, log: Log): SetupOps {
	let players: Record<string, Player> = {}
	// The private seeds bind cast accounts to their own L1 accounts, as intended; a pruned claim lost its binding too.
	const BIND = { allowBind: true }
	const claimAgain = async (t: ClaimTicket) => {
		await castClaim(s, t, logWait(log), BIND)
	}
	return {
		prepare: async (keys) => {
			const rpc = s.endpoints.l1RpcUrl
			if (s.m.network === "local") await fundDemoL1(rpc, s.m, anvilFaucet(rpc, s.m), log)
			players = await enlist(s, [...USERS, ...MERCHANTS], keys)
			await deployPlayers(s, Object.values(players), log)
		},
		bound: async (seed) => {
			const merchant = BIND_MERCHANT[seed]
			const { address, ethereum: treasury } = players[merchant]!
			const bound = await fundingAddress(s.wallet, s.m, address)
			if (bound === undefined) return false
			if (isAddressEqual(bound, treasury)) return true
			// The cast's keys are public once published, so anyone can claim a deposit into a demo merchant first.
			throw new Error(
				`${merchant} is bound to ${bound}, not its treasury ${treasury}, so it is not listed: redeploy, or list another merchant account.`,
			)
		},
		list: () => ensureMerchantsListed(s, players, log),
		deposit: (seed, _tag, prior, persist) => {
			const plan = SEED_PLANS[seed](players)
			return castDeposit(s, demoL1(s.endpoints.l1RpcUrl, s.m, plan.from), plan, prior, persist)
		},
		claim: async (t) => {
			log(`claim to ${t.draft.intent.recipient}: ${await castClaim(s, t, logWait(log), BIND)}`)
		},
		final: {
			finality: (t) => waitClaimFinalized(t, s.node, s.m),
			reconcile: (t) => reconcileDeposit(t.draft, l1CtxOf(demoL1(s.endpoints.l1RpcUrl, s.m, "alice")), s.m),
			claimAgain,
			pause: (ms) => new Promise((r) => setTimeout(r, ms)),
			log,
		},
	}
}

function stateStore(dir: StateDir): PlanStore {
	return {
		read: () => dir.read<SetupPlan>("setup.json"),
		write: (p) => dir.write("setup.json", p),
		abandon: (d) => keepAbandonedDraft(dir, d),
		archive: (tag) => dir.rename("setup.json", `setup-${tag}.json`),
	}
}

/**
 * `demo setup`: draws the users' tag and the merchants' salt (or resumes an unpublished pair), binds the cast and seeds
 * the float, and publishes both once every binding is final. A published demo is left alone unless `rotate` draws a new
 * tag; it keeps the salt, so the listed merchants stay the demo's.
 */
export function demoSetup(ref: ManifestRef, opts: { rotate: boolean; log: Log }): Promise<void> {
	return withStateDir("demo", ref.m.l2.bridge.address, async (dir) => {
		const store = stateStore(dir)
		const published = readDemoFile(ref)
		if (!store.read() && published && !opts.rotate) {
			opts.log("this deployment's demo is set up; --rotate draws a new users' tag")
			return
		}
		const kept = keptSalt(published)
		const publish = (keys: SetupKeys) => {
			opts.log(`published the users' tag and the merchants' salt to ${writeDemoFile(ref, keys)}`)
		}
		await withSession(ref, {}, (s) => withHeartbeat(s, () => runSetup(store, liveSetupOps(s, opts.log), publish, kept)))
	})
}

/** `demo status`: the cast's addresses, A_demo's and B_demo's L1 holdings, and every L2 balance the demo lets it read. */
export function demoStatus(ref: ManifestRef, log: Log): Promise<void> {
	const published = readDemoFile(ref)
	return withSession(ref, {}, async (s) => {
		const list = await syncMerchantList(s.node, AztecAddress.fromStringUnsafe(s.m.l2.token.address))
		const players: Player[] = published ? Object.values(await enlist(s, [...USERS, ...MERCHANTS], castKeysOf(published))) : []
		for (const p of players) {
			const [priv, pub] = await Promise.all([
				l2UsdcBalance(s.wallet, s.m, p.address, "private"),
				l2UsdcBalance(s.wallet, s.m, p.address, "public"),
			])
			const role = merchantStatus(list, p.address).merchant ? "merchant" : "user"
			log(`${p.actor.padEnd(9)} ${p.address} ${role}: ${priv} private, ${pub} public`)
		}
		if (!published) log(`${[...USERS, ...MERCHANTS].join(", ")}: not set up yet (bridge demo setup)`)
		for (const user of USERS) {
			const signer = demoL1(s.endpoints.l1RpcUrl, s.m, user)
			const address = signer.account.address
			const [eth, usdc] = await Promise.all([signer.publicClient.getBalance({ address }), usdcOf(signer, s.m, address)])
			log(`${user === "alice" ? "A_demo" : "B_demo"}    ${address}: ${eth} wei, ${usdc} USDC units`)
		}
	})
}

/** `demo reset`: galactica refunds alice back up to her seed, as far as its private balance goes. */
export function demoReset(ref: ManifestRef, log: Log): Promise<void> {
	const keys = castKeysFor(ref)
	return withSession(ref, {}, async (s) => {
		const p = await enlist(s, ["alice", "galactica"] as const, keys)
		const [alice, galactica] = await Promise.all([
			l2UsdcBalance(s.wallet, s.m, p.alice.address, "private"),
			l2UsdcBalance(s.wallet, s.m, p.galactica.address, "private"),
		])
		const amount = resetAmount(alice, galactica)
		if (amount === 0n) {
			log(`nothing to rebalance: alice holds ${alice}, galactica ${galactica} privately`)
			return
		}
		log(`galactica refunds alice ${amount}: ${await sendPrivate(s, p.galactica.address, p.alice.address, amount)}`)
	})
}

/**
 * `demo fund`: tops the cast's Ethereum accounts up; testnet funds come from the keyed L1 account, which also bridges
 * a Fee Juice mint to the sponsor, claimed by the sponsor claimer (deployed through the sponsor first if needed).
 */
export function demoFund(ref: ManifestRef, log: Log): Promise<void> {
	return withSession(ref, {}, async (s) => {
		const rpc = s.endpoints.l1RpcUrl
		if (s.m.network === "local") {
			await fundDemoL1(rpc, s.m, anvilFaucet(rpc, s.m), log)
			return
		}
		// The cast's keys are public: ETH sent to them on any chain with value is anyone's.
		if (s.m.l1.chainId !== TESTNET.l1ChainId) throw new Error(`demo fund runs on Sepolia only, not chain ${s.m.l1.chainId}`)
		assertAllPass(await probeNetwork(TESTNET, rpc), log)
		const key = l1PrivateKeyFrom()
		await fundDemoL1(rpc, s.m, signerFaucet(l1Signer(rpc, s.m.l1.chainId, privateKeyToAccount(key)), s.m), log)
		await topUpSponsor({
			node: s.node,
			wallet: s.wallet,
			from: await sponsorClaimer(s, log),
			sponsor: (await sponsorInstance()).address,
			fee: sponsoredFee(s.m),
			bridge: { pins: TESTNET, l1RpcUrl: rpc, l1PrivateKey: key },
			log,
		})
	})
}
