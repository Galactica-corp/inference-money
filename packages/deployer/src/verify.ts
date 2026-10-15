import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import {
	assertNetworkIdentity,
	BRIDGE_CONTRACTS,
	type BridgeManifest,
	fundingAuthorizationTypedData,
	instanceFromRecord,
	isBridgePaused,
	MERCHANT_MIN_DELAY,
	type MerchantEntry,
	sponsorInstance,
	syncMerchantList,
	TOKEN_PORTAL_ABI,
	tokenArtifact,
	tokenBridgeArtifact,
	tokenMinterProxyArtifact,
} from "@galactica-net/inference-money-core"
import {
	type DelayReads,
	type DelayState,
	layoutSlot,
	publicReader,
	readDelays,
	readGuardian,
	readRoles,
	standardContractAddresses,
} from "@galactica-net/inference-money-core/deploy"
import { aztecAddressOf, castMember, MERCHANTS } from "@galactica-net/inference-money-demo"
import type { DemoFile } from "@galactica-net/inference-money-demo/files"
import {
	type Abi,
	type Address,
	encodeDeployData,
	erc20Abi,
	type Hex,
	hashTypedData,
	type PublicClient,
	pad,
	type Transaction,
	TransactionNotFoundError,
	type TransactionReceipt,
	TransactionReceiptNotFoundError,
} from "viem"
import { type BridgeEvmArtifacts, maskImmutables } from "./evm"
import type { Check } from "./preflight"

const check = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail })
const warn = (name: string, detail: string): Check => ({ name, ok: true, warn: true, detail })
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()
const pin = (name: string, actual: unknown, want: unknown) =>
	check(name, same(actual, want), `${actual}${same(actual, want) ? "" : ` (want ${want})`}`)

async function attempt(name: string, fn: () => Promise<Check[]>): Promise<Check[]> {
	try {
		return await fn()
	} catch (e) {
		return [check(name, false, e instanceof Error ? e.message : String(e))]
	}
}

export const ROLLUP_MOVED =
	"the registry's canonical rollup moved: deposits revert (RollupNotCanonical); exits pay once the bound rollup proves them"

async function codeMatches(
	l1: PublicClient,
	name: string,
	address: Address,
	a: { deployedBytecode: Hex; immutableRanges: { start: number; length: number }[] },
) {
	const code = (await l1.getCode({ address })) ?? "0x"
	const ok = maskImmutables(code, a.immutableRanges) === maskImmutables(a.deployedBytecode, a.immutableRanges)
	return check(`${name} runtime bytecode == fresh forge build (immutables masked)`, ok, `${(code.length - 2) / 2} bytes`)
}

/** What a creation record must show: a plain create by the deployer, of the fresh build's init code, at this address. */
export interface CreationWant {
	deployer: Address
	input: Hex
	address: Address
	/** The block it must be mined in, where the manifest records one. */
	block?: bigint
}

/** Runtime code cannot show what a constructor did elsewhere (an ERC20 approval, say); its creation tx can. */
export function creationCheck(
	label: string,
	tx: Pick<Transaction, "hash" | "to" | "from" | "input">,
	receipt: Pick<TransactionReceipt, "status" | "contractAddress" | "blockNumber">,
	want: CreationWant,
): Check {
	const wrong = [
		tx.to !== null && `a call to ${tx.to}, not a creation`,
		!same(tx.from, want.deployer) && `sent by ${tx.from}`,
		!same(tx.input, want.input) && "init code differs from the fresh build",
		receipt.status !== "success" && "reverted",
		!same(receipt.contractAddress, want.address) && `created ${receipt.contractAddress}`,
		want.block !== undefined && receipt.blockNumber !== want.block && `mined in ${receipt.blockNumber}, not ${want.block}`,
	].filter((w) => typeof w === "string")
	return check(label, wrong.length === 0, wrong.join("; ") || tx.hash)
}

export async function createdAsBuilt(
	l1: Pick<PublicClient, "getTransaction" | "getTransactionReceipt">,
	name: string,
	hash: Hex | undefined,
	want: CreationWant,
): Promise<Check> {
	const label = `${name} creation tx == fresh forge build, sent by the L1 deployer`
	if (!hash) return warn(label, "the manifest records none: the constructor that ran is unverified")
	try {
		const [tx, receipt] = await Promise.all([l1.getTransaction({ hash }), l1.getTransactionReceipt({ hash })])
		if (!same(tx.hash, hash) || !same(receipt.transactionHash, hash)) {
			return check(label, false, `the L1 endpoint answered tx ${tx.hash} and receipt ${receipt.transactionHash} for ${hash}`)
		}
		return creationCheck(label, tx, receipt, want)
	} catch (e) {
		if (!(e instanceof TransactionNotFoundError || e instanceof TransactionReceiptNotFoundError)) throw e
		return check(label, false, `this L1 endpoint has no tx ${hash}: use one that serves old txs (--l1-rpc)`)
	}
}

async function verifyL1(l1: PublicClient, evm: BridgeEvmArtifacts, m: BridgeManifest): Promise<Check[]> {
	const { portal, router } = evm
	const read = (address: Address, abi: Abi, functionName: string) => l1.readContract({ address, abi, functionName }) as Promise<unknown>
	const p = (fn: string) => read(m.l1.portal, portal.abi, fn)
	const r = (fn: string) => read(m.l1.router, router.abi, fn)
	const [registry, underlying, l2Bridge, rollupVersion, initializer, outbox, inbox, routerOfPortal] = await Promise.all(
		["registry", "underlying", "l2Bridge", "rollupVersion", "initializer", "outbox", "inbox", "router"].map(p),
	)
	const [permit2, portalOfRouter, token] = await Promise.all(["PERMIT2", "PORTAL", "TOKEN"].map(r))
	const permit2Code = await l1.getCode({ address: m.l1.permit2 })
	return [
		await codeMatches(l1, "portal", m.l1.portal, portal),
		await codeMatches(l1, "router", m.l1.router, router),
		pin("portal.registry", registry, m.l1.registry),
		pin("portal.underlying", underlying, m.l1.usdc),
		pin("portal.l2Bridge", l2Bridge, m.l2.bridge.address),
		pin("portal.rollupVersion", rollupVersion, m.l2.rollupVersion),
		pin("portal.initializer == L1 deployer", initializer, m.l1.deployer),
		pin("portal.outbox", outbox, m.l1.outbox),
		pin("portal.inbox", inbox, m.l1.inbox),
		pin("portal.router", routerOfPortal, m.l1.router),
		pin("router.PERMIT2", permit2, m.l1.permit2),
		pin("router.PORTAL", portalOfRouter, m.l1.portal),
		pin("router.TOKEN", token, m.l1.usdc),
		check("Permit2 has code", !!permit2Code && permit2Code.length > 2, `${((permit2Code?.length ?? 2) - 2) / 2} bytes`),
		await fundingAuthorizationMatches(l1, m),
		await createdAsBuilt(l1, "portal", m.l1.portalTx, {
			deployer: m.l1.deployer,
			input: encodeDeployData({ abi: portal.abi, bytecode: portal.bytecode }),
			address: m.l1.portal,
		}),
		await createdAsBuilt(l1, "router", m.l1.routerTx, {
			deployer: m.l1.deployer,
			input: encodeDeployData({ abi: router.abi, bytecode: router.bytecode, args: [m.l1.permit2, m.l1.portal, m.l1.usdc] }),
			address: m.l1.router,
			block: BigInt(m.l1.deployBlock),
		}),
	]
}

/** A domain or type drift would make every signature the SDK builds for the portal's signed path fail. */
async function fundingAuthorizationMatches(l1: PublicClient, m: BridgeManifest): Promise<Check> {
	const probe = { depositor: m.l1.deployer, submitter: m.l1.router, amount: 1n, secretHash: pad("0x1"), deadline: 1n }
	const digest = await l1.readContract({
		address: m.l1.portal,
		abi: TOKEN_PORTAL_ABI,
		functionName: "fundingAuthorizationDigest",
		args: [probe.depositor, probe.submitter, probe.amount, probe.secretHash, probe.deadline],
	})
	const want = hashTypedData(fundingAuthorizationTypedData(probe, m.l1.portal, m.l1.chainId))
	return pin("portal.fundingAuthorizationDigest == the SDK's typed data", digest, want)
}

async function verifyInstances(node: AztecNode, m: BridgeManifest): Promise<Check[]> {
	const out: Check[] = []
	for (const [key, artifact] of BRIDGE_CONTRACTS) {
		const rec = m.l2[key]
		const derived = await instanceFromRecord(artifact, rec)
		const classId = (await getContractClassFromArtifact(artifact)).id.toString()
		const onChain = await node.getContract(derived.address)
		const published = await node.getContractClass(Fr.fromHexString(classId))
		out.push(pin(`${key} class id == artifact`, rec.classId, classId))
		out.push(check(`${key} instance published`, onChain !== undefined, rec.address))
		out.push(pin(`${key} on-chain class`, onChain?.currentContractClassId.toString(), classId))
		out.push(check(`${key} class published`, published !== undefined, classId))
	}
	return out
}

async function verifyL2Wiring(node: AztecNode, m: BridgeManifest): Promise<Check[]> {
	const { proxy, token, bridge } = m.l2
	const [b, p, t] = [publicReader(node, bridge.address), publicReader(node, proxy.address), publicReader(node, token.address)]
	// A PublicImmutable's packed value starts at its slot: the bridge config is (token_minter_proxy, token, portal).
	const [bProxy, bToken, bPortal, bPaused, pOwner, pToken, pBridge, tDecimals, tMinter, tAuth] = await Promise.all([
		b(layoutSlot(tokenBridgeArtifact, "config")),
		b(layoutSlot(tokenBridgeArtifact, "config", 1)),
		b(layoutSlot(tokenBridgeArtifact, "config", 2)),
		isBridgePaused(node, m),
		p(layoutSlot(tokenMinterProxyArtifact, "owner")),
		p(layoutSlot(tokenMinterProxyArtifact, "token")),
		p(layoutSlot(tokenMinterProxyArtifact, "bridge")),
		t(layoutSlot(tokenArtifact, "decimals")),
		t(layoutSlot(tokenArtifact, "minter")),
		t(layoutSlot(tokenArtifact, "auth_contract")),
	])
	return [
		pin("bridge config.token_minter_proxy", bProxy, proxy.address),
		pin("bridge config.token", bToken, token.address),
		check("bridge config.portal", bPortal.toBigInt() === BigInt(m.l1.portal), bPortal.toString()),
		check("bridge not paused", !bPaused, String(bPaused)),
		// The proxy's owner can only set token and bridge, once each: inert once both are wired.
		pin("proxy owner == deployer", pOwner, bridge.deployer),
		pin("proxy token", pToken, token.address),
		pin("proxy bridge", pBridge, bridge.address),
		check("token decimals == 6", tDecimals.toBigInt() === 6n, tDecimals.toString()),
		pin("token minter == proxy", tMinter, proxy.address),
		check("token auth_contract == 0", tAuth.isZero(), tAuth.toString()),
	]
}

/** "complete": the manifest's admin holds both roles. `{ pendingTo }`: a fresh deploy, proposed to that admin. */
export type Handover = "complete" | { pendingTo: string }

const ZERO = Fr.ZERO.toString()

/**
 * Both admin roles, the bridge's ownership and the merchant admin, against the expected handover state, and the guardian
 * against `guardianWant`. A deploy key can schedule a guardian before the handover, and the handover leaves it in place.
 */
async function verifyRoles(node: AztecNode, m: BridgeManifest, handover: Handover, guardianWant: string): Promise<Check[]> {
	const { owner, pendingOwner, admin, pendingAdmin } = await readRoles(node, m)
	const deployer = m.l2.bridge.deployer
	const guardian = await readGuardian(node, AztecAddress.fromStringUnsafe(m.l2.token.address))
	const guardianAsExpected = check(
		"guardian == the expected one (none unless named), now and scheduled",
		same(guardian.current, guardianWant) && same(guardian.scheduled, guardianWant),
		`${guardian.current}, then ${guardian.scheduled}`,
	)
	if (handover !== "complete") {
		return [
			pin("bridge owner == deployer (handover proposed)", owner, deployer),
			pin("bridge pending owner == admin", pendingOwner, handover.pendingTo),
			pin("merchant admin == deployer (handover proposed)", admin, deployer),
			pin("pending merchant admin == admin", pendingAdmin, handover.pendingTo),
			guardianAsExpected,
		]
	}
	const want = m.l2.admin ?? "an accepted admin (none in the manifest)"
	return [
		pin("bridge owner == admin", owner, want),
		pin("bridge: no ownership transfer pending", pendingOwner, ZERO),
		pin("merchant admin == admin", admin, want),
		pin("no merchant admin handover pending", pendingAdmin, ZERO),
		check("no deploy key keeps a role", !same(m.l2.admin, deployer), `admin ${m.l2.admin}`),
		guardianAsExpected,
		...(m.l2.interimAdmin ? [warn("admin is an interim (disposable) key", "switch to the owner's admin, then destroy it")] : []),
	]
}

const when = (t: bigint) => new Date(Number(t) * 1000).toISOString()
const delayChange = (d: DelayState) => `${d.current}s until ${when(d.changeAt)}, then ${d.scheduled}s`

/** A change still in flight: a warning when waived, else a failure that says whether `--allow-pending` would accept it. */
function pendingCheck(name: string, detail: string, waivable: boolean, allowPending: boolean): Check {
	if (waivable && allowPending) return warn(name, detail)
	return check(name, false, waivable ? `${detail} (--allow-pending accepts it while it settles)` : detail)
}

function entryChecks(account: string, e: MerchantEntry, r: DelayReads, pinned: bigint | undefined, allowPending: boolean): Check[] {
	const at = r.list.at
	const scheduled = e.scheduledDelay ?? MERCHANT_MIN_DELAY
	const d = { current: (at < e.delayChangeAt ? e.delay : e.scheduledDelay) ?? MERCHANT_MIN_DELAY, scheduled, changeAt: e.delayChangeAt }
	const name = `merchant ${account}`
	const out = [pin(`${name} delay == setting`, d.scheduled, r.setting)]
	if (d.changeAt > at && d.current !== d.scheduled) {
		out.push(pendingCheck(`${name} delay change pending`, delayChange(d), d.scheduled === pinned, allowPending))
	}
	// A change scheduled to the current value (a cancel, a switch back on) caps no read, so only a switch is pending.
	if (e.changeAt > at && e.off !== e.scheduledOff) {
		const switches = `switches ${e.scheduledOff ? "off" : "on"} at ${when(e.changeAt)}`
		out.push(pendingCheck(`${name} switch pending`, switches, true, allowPending))
	}
	return out
}

/**
 * The setting against the manifest's `merchantDelay`, and the guardian slot and every listed entry scheduled to the
 * setting. An entry's change in flight fails; `allowPending` accepts a switch, and a delay change only to the manifest's
 * delay. The guardian slot's delay change never fails: only public functions read that slot, so it caps no tx.
 */
export function delayPolicyChecks(r: DelayReads, merchantDelay: number | undefined, allowPending = false): Check[] {
	const pinned = merchantDelay === undefined ? undefined : BigInt(merchantDelay)
	const g = r.guardian
	return [
		pinned === undefined
			? warn("merchant delay setting", `${r.setting}s, unpinned: the manifest records no merchantDelay`)
			: pin("merchant delay setting == manifest", r.setting, pinned),
		pin("guardian slot delay == setting", g.scheduled, r.setting),
		...(g.changeAt > r.list.at && g.current !== g.scheduled ? [check("guardian slot delay change pending", true, delayChange(g))] : []),
		...[...r.list.entries].flatMap(([account, e]) => entryChecks(account, e, r, pinned, allowPending)),
	]
}

async function verifyDelays(node: AztecNode, m: BridgeManifest, allowPending: boolean): Promise<Check[]> {
	const reads = await readDelays(node, AztecAddress.fromStringUnsafe(m.l2.token.address))
	return delayPolicyChecks(reads, m.l2.merchantDelay, allowPending)
}

/** Necessary, not sufficient: unclaimed deposits and unpaid withdrawals are liabilities too (integration's books). */
async function verifyBacking(node: AztecNode, l1: PublicClient, m: BridgeManifest): Promise<Check[]> {
	const [supply, reserve] = await Promise.all([
		publicReader(node, m.l2.token.address)(layoutSlot(tokenArtifact, "total_supply")),
		l1.readContract({ address: m.l1.usdc, abi: erc20Abi, functionName: "balanceOf", args: [m.l1.portal] }),
	])
	return [check("L2 supply ≤ portal USDC", supply.toBigInt() <= reserve, `${supply.toBigInt()} ≤ ${reserve}`)]
}

/**
 * The demo merchants' keys are public: the unsalted ones always, a published salt's once published. Listed anywhere but
 * local and testnet, they would let anyone act as a merchant.
 */
export const DEMO_NETWORKS: readonly BridgeManifest["network"][] = ["local", "testnet"]

async function verifyDemoCast(node: AztecNode, m: BridgeManifest, demo: DemoFile | undefined): Promise<Check[]> {
	if (DEMO_NETWORKS.includes(m.network)) return [check("demo cast", true, `may be listed on ${m.network}`)]
	const list = await syncMerchantList(node, AztecAddress.fromStringUnsafe(m.l2.token.address))
	const salts = demo?.version === 2 ? [null, demo.merchantsSalt] : [null]
	const members = salts.flatMap((merchantsSalt) => MERCHANTS.map((a) => castMember(m, a, { merchantsSalt })))
	const cast = await Promise.all(members.map(async (c) => (await aztecAddressOf(c)).toString()))
	const listed = cast.filter((a) => list.entries.has(a))
	return [check("no demo merchant listed", listed.length === 0, listed.join(", ") || "none")]
}

/** The sponsor is the only fee payer that keeps an account out of its private claims, exits and payments. */
const NO_SPONSOR = "none: private flows would have to name the account as fee payer"

export async function verifyEnvironment(node: AztecNode, m: BridgeManifest): Promise<Check[]> {
	const standard = await Promise.all(
		(await standardContractAddresses()).map(async (s) =>
			check(`standard ${s.name} published`, (await node.getContract(s.address)) !== undefined, s.address.toString()),
		),
	)
	if (!m.l2.sponsoredFpc) {
		return [...standard, check("SponsoredFPC", m.network === "local", m.network === "local" ? "none on this network" : NO_SPONSOR)]
	}
	const pinned = (await sponsorInstance()).address
	const fpc = AztecAddress.fromStringUnsafe(m.l2.sponsoredFpc)
	const [balance, published] = await Promise.all([getFeeJuiceBalance(fpc, node), node.getContract(fpc)])
	const state = published ? "instance published" : "genesis-funded, instance unpublished"
	return [
		...standard,
		pin("SponsoredFPC == pinned class at salt 0", fpc, pinned),
		check("SponsoredFPC Fee Juice (recorded)", true, `${balance} (${state})`),
	]
}

export interface VerifyOptions {
	/** The merchant guardian the caller expects, in office and scheduled: none by default. */
	guardian?: string
	/** Accept merchant entries' changes in flight that `delayPolicyChecks` lets it. */
	allowPending?: boolean
	/** This deployment's published demo, whose salted merchants the demo-cast rule checks too. */
	demo?: DemoFile
}

/**
 * Every read-back the manifest depends on, keyless: L1 bytecode and creation txs against a fresh forge build, L1 and L2
 * wiring, the admin roles in their expected handover state, the delay policy, backing, the demo-cast rule, class ids,
 * network identity and the sponsor. A read that throws is a failed check, never a skipped one. It trusts the endpoints
 * `node` and `l1` read from.
 */
export async function verifyDeployment(
	m: BridgeManifest,
	evm: BridgeEvmArtifacts,
	l1: PublicClient,
	node: AztecNode,
	handover: Handover = "complete",
	{ guardian = ZERO, allowPending = false, demo }: VerifyOptions = {},
): Promise<Check[]> {
	const identity = await attempt("network identity", async () => {
		const { depositsOpen } = await assertNetworkIdentity(node, l1, m)
		const ok = check("network identity (node + the portal's rollup)", true, `rollup version ${m.l2.rollupVersion}`)
		return depositsOpen ? [ok] : [ok, warn("deposits", ROLLUP_MOVED)]
	})
	const deployers = new Set([m.l2.proxy.deployer, m.l2.token.deployer, m.l2.bridge.deployer])
	return [
		...identity,
		check("one L2 deployer for all instances", deployers.size === 1, [...deployers].join(", ")),
		...(await attempt("L1", () => verifyL1(l1, evm, m))),
		...(await attempt("L2 instances", () => verifyInstances(node, m))),
		...(await attempt("L2 wiring", () => verifyL2Wiring(node, m))),
		...(await attempt("admin roles", () => verifyRoles(node, m, handover, guardian))),
		...(await attempt("merchant delays", () => verifyDelays(node, m, allowPending))),
		...(await attempt("backing", () => verifyBacking(node, l1, m))),
		...(await attempt("demo cast", () => verifyDemoCast(node, m, demo))),
		...(await attempt("environment", () => verifyEnvironment(node, m))),
	]
}

export class VerificationFailed extends Error {
	constructor(readonly failures: Check[]) {
		super(`verification failed: ${failures.map((c) => `${c.name}: ${c.detail}`).join("; ")}`)
		this.name = "VerificationFailed"
	}
}

export function assertAllPass(checks: Check[], log: (m: string) => void): void {
	for (const c of checks) log(`${c.ok ? (c.warn ? "warn" : "ok  ") : "FAIL"} ${c.name}: ${c.detail}`)
	const failures = checks.filter((c) => !c.ok)
	if (failures.length > 0) throw new VerificationFailed(failures)
}
