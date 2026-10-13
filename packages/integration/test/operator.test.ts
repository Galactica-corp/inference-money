import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { getPublicEvents } from "@aztec-labs/aztec.js/events"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { TxReceipt } from "@aztec-labs/aztec.js/tx"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import {
	type BridgeManifest,
	contractEvent,
	instanceFromRecord,
	MERCHANT_MAX_DELAY,
	MERCHANT_MIN_DELAY,
	signingKeyFor,
	tokenArtifact,
	tokenBridgeArtifact,
} from "@inference-money/bridge-core"
import { parseTour, TOUR_STEPS, tourHeader } from "@inference-money/demo"
import {
	acceptAdmin,
	accountFor,
	bridgeOf,
	buildBridgeContracts,
	deployEvm,
	deployRouter,
	guardianDelay,
	initializePortal,
	LOCAL_ADMIN_SECRET,
	l1Signer,
	localL1Account,
	openBridgeWallet,
	proposeAdmin,
	readBundle,
	readDemoFile,
	tokenOf,
	verifyDeployment,
} from "@inference-money/deployer"
import { REPO_ROOT } from "@inference-money/local-network"
import { encodeAbiParameters, type Hex, keccak256, pad } from "viem"
import { l2Actor } from "./actors"
import { harness, INTEGRATION } from "./harness"
import { asAdmin, blockTimestamp, listMerchant, sponsored } from "./token"

const CLI = join(REPO_ROOT, "packages", "deployer", "src", "cli.ts")

/** `bun run bridge …` in a process of its own, as an operator runs it: its exit code and everything it printed. */
async function bridge(...args: string[]): Promise<{ code: number; out: string }> {
	const p = Bun.spawn(["bun", "--no-env-file", CLI, ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
	return { code, out: `${out}${err}` }
}

async function ok(...args: string[]): Promise<string> {
	const r = await bridge(...args)
	expect(r.code, r.out).toBe(0)
	return r.out
}

let evm: ReturnType<typeof buildBridgeContracts> | undefined
const built = () => {
	evm ??= buildBridgeContracts(harness().runId, false, process.env)
	return evm
}

/** The names of the checks `verify` fails for `m` against the chain as it is now; other specs leave merchant changes in flight. */
async function failing(m: BridgeManifest = harness().manifest): Promise<string[]> {
	const { l1, node } = harness()
	const checks = await verifyDeployment(m, built(), l1.publicClient, node, "complete", { allowPending: true })
	return checks.filter((c) => !c.ok).map((c) => c.name)
}

const CREATED = (name: string) => `${name} creation tx == fresh forge build, sent by the L1 deployer`

/** MockUsdc is OpenZeppelin's ERC20: balances are the mapping at slot 0. */
const usdcSlot = (holder: Hex) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, 0n]))

const bridgeAt = () => bridgeOf(harness().wallet, harness().manifest)
const tokenAt = () => tokenOf(harness().wallet, harness().manifest)

type FromBlock = Parameters<typeof getPublicEvents>[2]["fromBlock"]
type Since = { txHash: TxReceipt["txHash"] } | { fromBlock: FromBlock }

/** The first block after the latest: where a call made through a helper that returns no receipt lands, or later. */
const nextBlock = async (): Promise<Since> => ({ fromBlock: ((await harness().node.getBlockNumber()) + 1) as FromBlock })

/** Every `name` event the bridge or the token emitted in `since`, each field as a string. */
async function emitted(contract: "bridge" | "token", name: string, since: Since): Promise<Record<string, string>[]> {
	const artifact: ContractArtifact = contract === "bridge" ? tokenBridgeArtifact : tokenArtifact
	const { events } = await getPublicEvents<Record<string, unknown>>(harness().node, await contractEvent(artifact, name), {
		contractAddress: AztecAddress.fromStringUnsafe(harness().manifest.l2[contract].address),
		...since,
	})
	return events.map((e) => Object.fromEntries(Object.entries(e.event).map(([k, v]) => [k, String(v)])))
}

describe.skipIf(!INTEGRATION)("operator CLI", () => {
	let dir: string
	beforeAll(() => {
		dir = mkdtempSync(join(harness().manifestPath, "..", "operator-"))
	})
	afterAll(() => rmSync(dir, { recursive: true, force: true }))

	it("[A28] demo setup publishes the users' tag; the acceptance run settles twice and records a tour verify accepts", async () => {
		const { manifest: m, manifestPath } = harness()
		await ok("demo", "setup", manifestPath)
		expect(readDemoFile({ path: manifestPath, m })?.usersTag).toMatch(/^[0-9a-f]{32}$/)

		const tour = join(dir, "tour.json")
		await ok("smoke", manifestPath, "--record", tour)
		await ok("smoke", manifestPath)
		// Other specs leave merchant changes in flight on this shared deployment.
		await ok("verify", manifestPath, "--tour", tour, "--allow-pending")
		const steps = parseTour(JSON.parse(readFileSync(tour, "utf8"))).steps
		expect(steps.filter((s) => s.verdict === "refused").map((s) => s.rule)).toEqual(["transfer", "exitDestination"])
		expect(steps.find((s) => s.id === "withdraw")?.l1?.txHash).toMatch(/^0x[0-9a-f]{64}$/)
	}, 3_600_000)

	describe("[A28] verify fails exactly the checks a drift breaks, and passes once it is undone", () => {
		it("a manifest naming another L1 deployer", async () => {
			const m = harness().manifest
			expect(await failing()).toEqual([])
			expect(await failing({ ...m, l1: { ...m.l1, deployer: `0x${"ab".repeat(20)}` } })).toEqual([
				"portal.initializer == L1 deployer",
				CREATED("portal"),
				CREATED("router"),
			])
		})

		it("a manifest naming another tx as the portal's creation", async () => {
			const m = harness().manifest
			expect(await failing({ ...m, l1: { ...m.l1, portalTx: m.l1.routerTx } })).toEqual([CREATED("portal")])
		})

		// Same key, same runtime and getters, wired and backed like the real one: only how it was created differs.
		it("a portal created with init code other than the fresh build's", async () => {
			const { manifest: m, l1 } = harness()
			const signer = l1Signer(l1.rpcUrl, l1.chain.id, localL1Account())
			const copy = await deployEvm(signer, "TokenPortal", { ...built().portal, bytecode: `${built().portal.bytecode}00` })
			const router = await deployRouter(signer, built(), m.l1.permit2, copy.address, m.l1.usdc)
			const binding = { registry: m.l1.registry, usdc: m.l1.usdc, l2Bridge: m.l2.bridge.address, router: router.address }
			await initializePortal(signer, built(), copy.address, binding)
			const reserve = (await l1.publicClient.getStorageAt({ address: m.l1.usdc, slot: usdcSlot(m.l1.portal) })) ?? pad("0x0")
			await l1.test.setStorageAt({ address: m.l1.usdc, index: usdcSlot(copy.address), value: reserve })
			const l1Fields = { portal: copy.address, portalTx: copy.tx, router: router.address, routerTx: router.tx }
			expect(await failing({ ...m, l1: { ...m.l1, ...l1Fields, deployBlock: Number(router.block) } })).toEqual([
				CREATED("portal"),
				"bridge config.portal",
			])
		})

		it("a manifest whose proxy is not the token's minter", async () => {
			const m = harness().manifest
			const proxy = { ...m.l2.proxy, address: `0x${"0e".repeat(32)}` as Hex }
			expect(await failing({ ...m, l2: { ...m.l2, proxy } })).toContain("token minter == proxy")
		})

		it("a portal holding less USDC than the L2 supply", async () => {
			const { manifest: m, l1 } = harness()
			const slot = usdcSlot(m.l1.portal)
			const held = (await l1.publicClient.getStorageAt({ address: m.l1.usdc, slot })) ?? pad("0x0")
			await l1.test.setStorageAt({ address: m.l1.usdc, index: slot, value: pad("0x0") })
			try {
				expect(await failing()).toEqual(["L2 supply ≤ portal USDC"])
			} finally {
				await l1.test.setStorageAt({ address: m.l1.usdc, index: slot, value: held })
			}
			expect(await failing()).toEqual([])
		})

		it("a handover proposed and not withdrawn", async () => {
			const { wallet, owner, manifest: m } = harness()
			const next = await l2Actor()
			const proposed = await nextBlock()
			await proposeAdmin(wallet, m, owner, next, sponsored())
			const handover = { owner: owner.toString(), pending_owner: next.toString() }
			let cancelled: TxReceipt | undefined
			let withdrawn: TxReceipt | undefined
			try {
				expect(await failing()).toEqual(["bridge: no ownership transfer pending", "no merchant admin handover pending"])
				// `proposed` is open-ended: read it before the withdrawal below emits a second proposal (of zero).
				expect(await emitted("bridge", "OwnershipTransferStarted", proposed)).toEqual([handover])
				expect(await emitted("token", "MerchantAdminProposed", proposed)).toEqual([{ pending_admin: next.toString() }])
			} finally {
				cancelled = (await bridgeAt().methods.cancel_ownership_transfer!().send(asAdmin())).receipt
				withdrawn = (await tokenAt().methods.propose_merchant_admin!(AztecAddress.ZERO).send(asAdmin())).receipt
			}
			expect(await failing()).toEqual([])
			expect(await emitted("bridge", "OwnershipTransferCancelled", { txHash: cancelled!.txHash })).toEqual([handover])
			expect(await emitted("token", "MerchantAdminProposed", { txHash: withdrawn!.txHash })).toEqual([
				{ pending_admin: AztecAddress.ZERO.toString() },
			])
		})

		it("a guardian nobody named, scheduled by a deploy key", async () => {
			const deployer = AztecAddress.fromStringUnsafe(harness().manifest.l2.bridge.deployer)
			const { receipt } = await tokenAt().methods.schedule_merchant_guardian!(deployer).send(asAdmin())
			try {
				expect(await failing()).toEqual(["guardian == the expected one (none unless named), now and scheduled"])
				const { result: roles } = await tokenAt().methods.get_merchant_roles!().simulate({ from: harness().owner })
				expect(await emitted("token", "MerchantGuardianScheduled", { txHash: receipt.txHash })).toEqual([
					{ guardian: deployer.toString(), effective_at: String(roles.scheduled_guardian_at) },
				])
			} finally {
				await tokenAt().methods.schedule_merchant_guardian!(AztecAddress.ZERO).send(asAdmin())
			}
			expect(await failing()).toEqual([])
		})

		it("a paused bridge", async () => {
			const { receipt: paused } = await bridgeAt().methods.set_paused!(true).send(asAdmin())
			let resumed: TxReceipt | undefined
			try {
				expect(await failing()).toEqual(["bridge not paused"])
			} finally {
				resumed = (await bridgeAt().methods.set_paused!(false).send(asAdmin())).receipt
			}
			expect(await failing()).toEqual([])
			expect(await emitted("bridge", "PauseSet", { txHash: paused.txHash })).toEqual([{ paused: "true" }])
			expect(await emitted("bridge", "PauseSet", { txHash: resumed!.txHash })).toEqual([{ paused: "false" }])
		})

		// The setter reschedules the guardian slot itself; each listed entry keeps its delay until synced.
		it("a delay setting not yet synced to the merchants", async () => {
			const { receipt } = await tokenAt().methods.set_merchant_delay!(MERCHANT_MIN_DELAY).send(asAdmin())
			try {
				const drifted = await failing()
				expect(drifted.length).toBeGreaterThan(1)
				const unsynced = /^merchant 0x[0-9a-f]{64} delay == setting$/
				expect(drifted.filter((name) => !unsynced.test(name))).toEqual(["merchant delay setting == manifest"])
				const token = AztecAddress.fromStringUnsafe(harness().manifest.l2.token.address)
				const slot = await guardianDelay(harness().node, token, receipt.blockNumber!, await blockTimestamp(receipt))
				expect(await emitted("token", "MerchantDelaySet", { txHash: receipt.txHash })).toEqual([
					{ delay: String(MERCHANT_MIN_DELAY), guardian_delay_effective_at: String(slot.changeAt) },
				])
			} finally {
				await tokenAt().methods.set_merchant_delay!(MERCHANT_MAX_DELAY).send(asAdmin())
			}
			expect(await failing()).toEqual([])
		})

		it("a merchant's switch-off in flight: strict verify fails it, --allow-pending warns", async () => {
			const merchant = await l2Actor()
			await listMerchant(merchant)
			await tokenAt().methods.schedule_merchant_off!(merchant, true).send(asAdmin())
			const line = (verdict: string) => `${verdict} merchant ${merchant} switch pending: switches off at `
			const strict = await bridge("verify", harness().manifestPath)
			expect([strict.code, strict.out.includes(line("FAIL"))], strict.out).toEqual([1, true])
			const allowing = await bridge("verify", harness().manifestPath, "--allow-pending")
			expect([allowing.code, allowing.out.includes(line("warn"))], allowing.out).toEqual([0, true])
		})

		// A whole, well-formed run, so the deployment's identity is the only thing wrong with it.
		it("a tour recorded on another deployment", async () => {
			const foreign = join(dir, "foreign-tour.json")
			const header = tourHeader(harness().manifest)
			const refused: Record<string, string> = { "transfer-refused": "transfer", "exit-refused": "exitDestination" }
			const steps = TOUR_STEPS.map((id) => ({
				id,
				actor: "alice",
				action: "transfer",
				to: "bob",
				amount: "1",
				verdict: refused[id] ? "refused" : "settled",
				...(refused[id] && { rule: refused[id] }),
				world: [],
			}))
			const contracts = { ...header.contracts, bridge: `0x${"cd".repeat(32)}` }
			writeFileSync(foreign, JSON.stringify({ ...header, contracts, steps }))
			const r = await bridge("verify", harness().manifestPath, "--tour", foreign)
			expect(r.code, r.out).toBe(1)
			expect(r.out).toContain("contracts.bridge")
		})
	})

	it("[A28] export writes a bundle from which a fresh wallet rebuilds and reads the contracts, nothing else needed", async () => {
		const { manifest: m, manifestPath, node } = harness()
		const out = join(dir, "export")
		await ok("export", manifestPath, "--out", out)
		const bundle = await readBundle(out)
		expect(bundle.manifest).toEqual(m)
		expect((await Bun.$`sha256sum -c SHA256SUMS`.cwd(out).quiet()).exitCode).toBe(0)

		// A manifest these artifacts don't derive, as an older deployment's: nothing is written.
		const raw = JSON.parse(readFileSync(manifestPath, "utf8"))
		const older = join(dir, "older.json")
		writeFileSync(older, JSON.stringify({ ...raw, l2: { ...raw.l2, proxy: { ...raw.l2.proxy, salt: `0x${"01".repeat(32)}` } } }))
		const refused = await bridge("export", older, "--out", join(dir, "refused"))
		expect([refused.code === 0, refused.out.includes(`made from commit ${m.sourceCommit}`)], refused.out).toEqual([false, true])
		expect(existsSync(join(dir, "refused"))).toBe(false)

		const fresh = await openBridgeWallet(node, { prove: false })
		try {
			const token = await instanceFromRecord(bundle.artifacts.token, bundle.manifest.l2.token)
			await fresh.registerContract(token, bundle.artifacts.token)
			const reader = (await fresh.createSchnorrAccount(LOCAL_ADMIN_SECRET, Fr.ZERO, signingKeyFor(LOCAL_ADMIN_SECRET))).address
			const { result } = await Contract.at(token.address, bundle.artifacts.token, fresh).methods.decimals!().simulate({
				from: reader,
			})
			expect(BigInt(result)).toBe(6n)
		} finally {
			await fresh.stop()
		}
	})

	it("[A28] admin propose hands both roles to a new admin, who hands them back; verify follows the manifest's admin", async () => {
		const { wallet, owner, manifest: m, manifestPath } = harness()
		const secret = Fr.random()
		await ok("admin", "propose", manifestPath, (await accountFor(wallet, secret)).toString())
		const accepted = await nextBlock()
		const next = await acceptAdmin(wallet, harness().node, m, secret, () => {})
		try {
			expect(await failing({ ...m, l2: { ...m.l2, admin: next.toString() as Hex } })).toEqual([])
			expect(await failing()).toEqual(["bridge owner == admin", "merchant admin == admin"])
			expect(await emitted("bridge", "OwnershipTransferred", accepted)).toEqual([
				{ previous_owner: owner.toString(), new_owner: next.toString() },
			])
			expect(await emitted("token", "MerchantAdminAccepted", accepted)).toEqual([
				{ previous_admin: owner.toString(), admin: next.toString() },
			])
		} finally {
			await proposeAdmin(wallet, m, next, owner, sponsored())
			await acceptAdmin(wallet, harness().node, m, LOCAL_ADMIN_SECRET, () => {})
		}
		expect(await failing()).toEqual([])
	}, 900_000)
})
