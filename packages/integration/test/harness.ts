import { rmSync } from "node:fs"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type AztecNode, createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { type AztecNodeDebug, createAztecNodeDebugClient } from "@aztec-labs/stdlib/interfaces/client"
import type { Tx } from "@aztec-labs/stdlib/tx"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import {
	type BridgeManifest,
	memoryPaymentStore,
	type OutboxReader,
	outboxReader,
	PaymentGate,
	registerBridgeContracts,
	registerSponsor,
	SendJournal,
	signingKeyFor,
} from "@galactica-net/inference-money-core"
import {
	deployLocal,
	enterOwnedTmpDir,
	forgeRunDir,
	LOCAL_ADMIN_SECRET,
	l1Chain,
	newSponsoredAccount,
	openBridgeWallet,
	recordingNode,
	type SentTx,
	startBlockHeartbeat,
} from "@galactica-net/inference-money-deployer"
import { L1_CHAIN_ID, localDeploymentDir, netDown, netUp, resolveEndpoints, runIdFor } from "@galactica-net/inference-money-local-network"
import { type Chain, createPublicClient, createTestClient, http, type PublicClient, type TestClient } from "viem"

export const INTEGRATION = Boolean(process.env.INTEGRATION)

export interface Harness {
	runId: string
	manifest: BridgeManifest
	/** The written manifest, as the operator CLI takes it. */
	manifestPath: string
	node: AztecNode
	/** The node's debug API: moves the network's clock, L1's with it. */
	debug: AztecNodeDebug
	/** Holds every actor account; each tx it submits lands in `sent`. */
	wallet: EmbeddedWallet
	sent: SentTx[]
	/** The payment records; `wallet` sends through its node, so `payRequest` works with it. */
	gate: PaymentGate
	/** Under the gate's node, so `exitToL1` works with `wallet`. */
	sends: SendJournal
	/** The bridge's owner and the merchant admin, which a local deploy hands to the fixed local admin; in `wallet`. */
	owner: AztecAddress
	outbox: OutboxReader
	l1: { rpcUrl: string; chain: Chain; publicClient: PublicClient; test: TestClient }
}

let current: Harness | undefined
const cleanup: (() => unknown)[] = []

export function harness(): Harness {
	if (!current) throw new Error("The integration harness is not open: run the suite through `bun run test:integration`.")
	return current
}

export const newAccount = newSponsoredAccount

interface Held {
	count: number
	queued: { send: () => Promise<void>; done: ReturnType<typeof Promise.withResolvers<void>> }[]
}
let held: Held | undefined

async function release(batch: Held): Promise<void> {
	if (held === batch) held = undefined
	for (const q of batch.queued.splice(0)) await q.send().then(q.done.resolve, q.done.reject)
}

let loseReply = false

/** The next submission reaches the node, and then its send throws, as when the reply is lost. */
export function loseNextReply(): void {
	loseReply = true
}

/** Forwards each submission at once, unless {@link sendTogether} is collecting them. */
function holdingNode(node: AztecNode): AztecNode {
	return new Proxy(node, {
		get(target, key, receiver) {
			if (key !== "sendTx") return Reflect.get(target, key, receiver)
			return async (tx: Tx) => {
				if (loseReply) {
					loseReply = false
					await target.sendTx(tx)
					throw new Error("socket hang up")
				}
				const batch = held
				if (!batch) return target.sendTx(tx)
				const done = Promise.withResolvers<void>()
				batch.queued.push({ send: () => target.sendTx(tx), done })
				if (batch.queued.length === batch.count) await release(batch)
				return done.promise
			}
		},
	})
}

/** Holds the actor wallet's submissions from now until `release` sends them: proofs made now, delivered later. */
export function holdSends(): { queued: () => number; release: () => Promise<void> } {
	if (held) throw new Error("sends are already held")
	const batch: Held = { count: Number.POSITIVE_INFINITY, queued: [] }
	held = batch
	return { queued: () => batch.queued.length, release: () => release(batch) }
}

/**
 * Runs `actions` with the actor wallet's submissions held until every action has proven its tx, then sends them back to
 * back: all were built against the same state, so the sequencer decides any conflict between them. An action that
 * settles without submitting releases the rest.
 */
export async function sendTogether<T>(actions: (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
	if (held) throw new Error("sends are already held")
	const batch: Held = { count: actions.length, queued: [] }
	held = batch
	try {
		return await Promise.allSettled(actions.map((act) => act().finally(() => (held === batch ? release(batch) : undefined))))
	} finally {
		if (held === batch) held = undefined
	}
}

export async function latestTimestamp(): Promise<bigint> {
	const data = await harness().node.getBlockData("latest")
	if (!data) throw new Error("the node has no latest block")
	return data.header.globalVariables.timestamp
}

/** Moves the network's clock (never back) until the latest block is at `timestamp` or later, and returns its time. */
export async function warpTo(timestamp: bigint): Promise<bigint> {
	if (timestamp > (await latestTimestamp())) await harness().debug.warpL2TimeAtLeastTo(Number(timestamp))
	// The block a warp builds can carry its slot's start, short of the second asked for; the next blocks pass it.
	for (let tries = 0; tries < 300; tries++) {
		const at = await latestTimestamp()
		if (at >= timestamp) return at
		await Bun.sleep(1_000)
	}
	throw new Error(`the network's clock did not reach ${timestamp} after the warp`)
}

async function openWallet(node: AztecNode, m: BridgeManifest): Promise<EmbeddedWallet> {
	const wallet = await openBridgeWallet(node, { prove: false })
	cleanup.push(() => wallet.stop())
	await registerSponsor(wallet, m)
	await registerBridgeContracts(wallet, m)
	return wallet
}

/** The heartbeat runs in a wallet of its own, so its txs never land in `sent`. */
async function startHeartbeat(node: AztecNode, m: BridgeManifest): Promise<void> {
	cleanup.push(await startBlockHeartbeat(await openWallet(node, m), m))
}

async function open(log: (m: string) => void): Promise<Harness> {
	const runId = runIdFor({ RUN_ID: process.env.RUN_ID ?? `it-${process.pid}` })
	cleanup.push(
		() => rmSync(forgeRunDir(runId), { recursive: true, force: true }),
		() => rmSync(localDeploymentDir(runId), { recursive: true, force: true }),
	)
	if (!(process.env.NET_L1_RPC && process.env.NET_NODE_URL)) {
		cleanup.push(() => netDown(runId, log))
		await netUp(runId, log)
	}
	const { manifest, path: manifestPath } = await deployLocal(runId, { log })
	cleanup.push(enterOwnedTmpDir())
	const net = resolveEndpoints(runId)
	const node = createAztecNodeClient(net.nodeUrl)
	const sent: SentTx[] = []
	const sends = new SendJournal(recordingNode(holdingNode(node), sent))
	const gate = new PaymentGate(sends.node, memoryPaymentStore())
	const wallet = await gate.bindWallet((gated) => sends.bindWallet(() => openWallet(gated, manifest)))
	const owner = (await wallet.createSchnorrAccount(LOCAL_ADMIN_SECRET, Fr.ZERO, signingKeyFor(LOCAL_ADMIN_SECRET))).address
	await startHeartbeat(node, manifest)
	const chain = l1Chain(net.anvilUrl, L1_CHAIN_ID)
	const publicClient = createPublicClient({ chain, transport: http(net.anvilUrl) }) as PublicClient
	const test = createTestClient({ chain, mode: "anvil", transport: http(net.anvilUrl) })
	log(`harness open: run ${runId}, bridge ${manifest.l2.bridge.address}`)
	return {
		runId,
		manifest,
		manifestPath,
		node,
		debug: createAztecNodeDebugClient(net.nodeUrl),
		wallet,
		sent,
		gate,
		sends,
		owner,
		outbox: outboxReader(publicClient, manifest.l1.outbox),
		l1: { rpcUrl: net.anvilUrl, chain, publicClient, test },
	}
}

export async function openHarness(log: (m: string) => void): Promise<void> {
	try {
		current = await open(log)
	} catch (e) {
		await closeHarness().catch((c) => log(`teardown after a failed open also failed: ${c}`))
		throw e
	}
}

/** Undoes every setup step in reverse, each even if an earlier one failed. */
export async function closeHarness(): Promise<void> {
	current = undefined
	const failures: unknown[] = []
	for (const step of cleanup.splice(0).reverse()) {
		try {
			await step()
		} catch (e) {
			failures.push(e)
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "integration teardown failed")
}
