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
	sponsorInstance,
	syncMerchantList,
	TOKEN_PORTAL_ABI,
	tokenArtifact,
	tokenBridgeArtifact,
	tokenMinterProxyArtifact,
} from "@galactica-net/inference-money-core"
import {
	type DelayState,
	entryDelay,
	guardianDelay,
	layoutSlot,
	publicReader,
	readGuardian,
	readRoles,
	standardContractAddresses,
} from "@galactica-net/inference-money-core/deploy"
import { aztecAddressOf, castMember, MERCHANTS } from "@galactica-net/inference-money-demo"
import { type Abi, type Address, erc20Abi, type Hex, hashTypedData, type PublicClient, pad } from "viem"
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

const delayCheck = (name: string, d: DelayState, setting: bigint, now: bigint): Check[] => {
	const result = pin(`${name} delay == setting`, d.scheduled, setting)
	if (d.changeAt <= now || d.current === d.scheduled) return [result]
	return [result, warn(`${name} delay change pending`, `${d.current}s until ${d.changeAt}, then ${d.scheduled}s`)]
}

/** The guardian slot's and every added merchant's delay against the setting; a decrease still in flight only warns. */
async function verifyDelays(node: AztecNode, m: BridgeManifest): Promise<Check[]> {
	const token = AztecAddress.fromStringUnsafe(m.l2.token.address)
	const list = await syncMerchantList(node, token)
	const setting = (await publicReader(node, m.l2.token.address)(layoutSlot(tokenArtifact, "merchant_delay"))).toBigInt()
	const guardian = await guardianDelay(node, token, list.block, list.at)
	const entries = await Promise.all(
		[...list.entries.keys()].map(async (a) => {
			const d = await entryDelay(node, token, AztecAddress.fromStringUnsafe(a), list.block, list.at)
			return delayCheck(`merchant ${a}`, d, setting, list.at)
		}),
	)
	return [...delayCheck("guardian slot", guardian, setting, list.at), ...entries.flat()]
}

/** Necessary, not sufficient: unclaimed deposits and unpaid withdrawals are liabilities too (integration's books). */
async function verifyBacking(node: AztecNode, l1: PublicClient, m: BridgeManifest): Promise<Check[]> {
	const [supply, reserve] = await Promise.all([
		publicReader(node, m.l2.token.address)(layoutSlot(tokenArtifact, "total_supply")),
		l1.readContract({ address: m.l1.usdc, abi: erc20Abi, functionName: "balanceOf", args: [m.l1.portal] }),
	])
	return [check("L2 supply ≤ portal USDC", supply.toBigInt() <= reserve, `${supply.toBigInt()} ≤ ${reserve}`)]
}

/** The demo merchants' keys are public: listed anywhere but local and testnet, they would let anyone act as a merchant. */
export const DEMO_NETWORKS: readonly BridgeManifest["network"][] = ["local", "testnet"]

async function verifyDemoCast(node: AztecNode, m: BridgeManifest): Promise<Check[]> {
	if (DEMO_NETWORKS.includes(m.network)) return [check("demo cast", true, `may be listed on ${m.network}`)]
	const list = await syncMerchantList(node, AztecAddress.fromStringUnsafe(m.l2.token.address))
	const cast = await Promise.all(MERCHANTS.map(async (a) => (await aztecAddressOf(castMember(m, a))).toString()))
	const listed = cast.filter((a) => list.entries.has(a))
	return [check("no demo merchant listed", listed.length === 0, listed.join(", ") || "none")]
}

async function verifyEnvironment(node: AztecNode, m: BridgeManifest): Promise<Check[]> {
	const standard = await Promise.all(
		(await standardContractAddresses()).map(async (s) =>
			check(`standard ${s.name} published`, (await node.getContract(s.address)) !== undefined, s.address.toString()),
		),
	)
	if (!m.l2.sponsoredFpc) return [...standard, check("SponsoredFPC", true, "none on this network")]
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

/**
 * Every read-back the manifest depends on, keyless: L1 bytecode against a fresh forge build, L1 and L2 wiring, the admin
 * roles in their expected handover state, the delays, backing, the demo-cast rule, class ids, network identity and the
 * sponsor. A read that throws is a failed check, never a skipped one. It trusts the endpoints `node` and `l1` read from.
 * `guardian` is the merchant guardian the caller expects, in office and scheduled: none by default.
 */
export async function verifyDeployment(
	m: BridgeManifest,
	evm: BridgeEvmArtifacts,
	l1: PublicClient,
	node: AztecNode,
	handover: Handover = "complete",
	guardian: string = ZERO,
): Promise<Check[]> {
	const identity = await attempt("network identity", async () => {
		await assertNetworkIdentity(node, l1, m)
		return [check("network identity (node + registry → rollup)", true, `rollup version ${m.l2.rollupVersion}`)]
	})
	const deployers = new Set([m.l2.proxy.deployer, m.l2.token.deployer, m.l2.bridge.deployer])
	return [
		...identity,
		check("one L2 deployer for all instances", deployers.size === 1, [...deployers].join(", ")),
		...(await attempt("L1", () => verifyL1(l1, evm, m))),
		...(await attempt("L2 instances", () => verifyInstances(node, m))),
		...(await attempt("L2 wiring", () => verifyL2Wiring(node, m))),
		...(await attempt("admin roles", () => verifyRoles(node, m, handover, guardian))),
		...(await attempt("merchant delays", () => verifyDelays(node, m))),
		...(await attempt("backing", () => verifyBacking(node, l1, m))),
		...(await attempt("demo cast", () => verifyDemoCast(node, m))),
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
