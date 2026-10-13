import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { openBrowserStore, PXE_DATA_SCHEMA_VERSION } from "@aztec-labs/pxe/client/lazy"
import type { Tx } from "@aztec-labs/stdlib/tx"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import {
	type BridgeManifest,
	PaymentGate,
	type PaymentStore,
	registerBridgeContracts,
	registerSponsor,
	SendJournal,
} from "@inference-money/bridge-core"
import { ACTORS, type Actor, type CastMember, castMember, recordingNode, type SentTx } from "@inference-money/demo"
import { oneAtATime } from "@/lib/one-at-a-time"
import type { PagePresto } from "@/presto"

/** A cast member whose account the page's wallet holds, so the page can sign as it. */
export interface Player extends CastMember {
	address: AztecAddress
}

/** Where a send stands once simulated: proving in this page, handed to the node, then waiting to settle. */
export type SendStage = "prove" | "send" | "settle"

export interface StageFeed {
	emit(stage: SendStage): void
	/** Returns the unsubscribe. */
	listen(fn: (stage: SendStage) => void): () => void
}

export interface DemoWallet {
	wallet: EmbeddedWallet
	/** The node, read directly; the wallet sends through the gate's, so `payRequest` accepts it. */
	node: AztecNode
	gate: PaymentGate
	/** Under the gate's node; the wallet is bound to it too, so `exitToL1` accepts it. */
	sends: SendJournal
	cast: Record<Actor, Player>
	/** `performance.now()` as each tx reached the node: everything before it is the page simulating and proving. */
	sentAt: number[]
	/** Every tx the page sent, with what the world sees of it but its effect does not carry. */
	sent: SentTx[]
	/** Called once, with the next tx as it leaves for the node and before any response, so a record of it survives both. */
	onNextSend: { fn?: (tx: SentTx) => void }
	/** Runs `fn` alone among everything that sends through this wallet, whose next-send journal they would share. */
	exclusive: <T>(fn: () => Promise<T>) => Promise<T>
	stages: StageFeed
	/** Presto's side of the page's proofs, on a build that proves for real. */
	presto?: PagePresto
}

export interface DemoWalletOptions {
	usersTag: string
	/** Real proofs, or the fake ones a local network accepts. */
	proves: boolean
	payments: PaymentStore
	/** The prover the PXE proves through instead of its own, and the simulator they share. */
	presto?: PagePresto
}

type Around = <T>(prove: () => Promise<T>) => Promise<T>

/** Opening a store another tab holds fails outright; say what to do about it. */
const POOL_BUSY = "SqlitePoolBusyError"

function stageFeed(): StageFeed {
	const listeners = new Set<(stage: SendStage) => void>()
	return {
		emit: (stage) => {
			for (const fn of listeners) fn(stage)
		},
		listen: (fn) => {
			listeners.add(fn)
			return () => listeners.delete(fn)
		},
	}
}

/** Methods bound to the target: a class with private fields refuses a proxy as `this`. */
function intercept<T extends object>(target: T, key: PropertyKey, wrap: (method: (...args: never[]) => unknown) => unknown): T {
	return new Proxy(target, {
		get(t, k) {
			const value = Reflect.get(t, k, t)
			if (typeof value !== "function") return value
			const bound = value.bind(t)
			return k === key ? wrap(bound) : bound
		},
	})
}

function stamping(node: AztecNode, sentAt: number[], stages: StageFeed): AztecNode {
	return intercept(node, "sendTx", (send) => async (tx: Tx) => {
		sentAt.push(performance.now())
		stages.emit("send")
		const sent = await (send as (tx: Tx) => Promise<void>)(tx)
		stages.emit("settle")
		return sent
	})
}

/**
 * The embedded wallet, reporting when it starts proving: the one step of a send its API does not surface. Each proof
 * runs inside `around`, which may hold it first. Its `create` constructs `new this(…)`, so the subclass is what it
 * builds.
 */
function stagedWallet(stages: StageFeed, around: Around): typeof EmbeddedWallet {
	return class StagedWallet extends EmbeddedWallet {
		constructor(...[pxe, ...rest]: ConstructorParameters<typeof EmbeddedWallet>) {
			const proving = intercept(
				pxe,
				"proveTx",
				(prove) =>
					(...args: never[]) =>
						around(async () => {
							stages.emit("prove")
							return prove(...args)
						}),
			)
			super(proving, ...rest)
		}
	}
}

/** One PXE store per deployment: a redeploy on the same rollup brings new contracts and a new cast. */
async function openPxeStore(node: AztecNode, m: BridgeManifest) {
	const { l1ChainId, l1ContractAddresses } = await node.getNodeInfo()
	try {
		return await openBrowserStore(`pxe_data_${m.l2.bridge.address}`, PXE_DATA_SCHEMA_VERSION, {
			l1ChainId,
			rollupAddress: l1ContractAddresses.rollupAddress,
		})
	} catch (e) {
		if (e instanceof Error && e.name === POOL_BUSY) throw new Error("The showcase is open in another tab: close that one, then reload.")
		throw e
	}
}

/**
 * The page's one wallet, over stores that survive a reload: every cast account, the fee sponsor and the bridge's
 * contracts. Open it once per page, never per render: a second open in the same tab finds its own store locked. The
 * stores are keyed by the node's rollup, so check the node against the manifest first.
 */
export async function openDemoWallet(node: AztecNode, m: BridgeManifest, opts: DemoWalletOptions): Promise<DemoWallet> {
	const sentAt: number[] = []
	const sent: SentTx[] = []
	const onNextSend: DemoWallet["onNextSend"] = {}
	const journal = (tx: SentTx) => {
		const fn = onNextSend.fn
		onNextSend.fn = undefined
		fn?.(tx)
	}
	const stages = stageFeed()
	const store = await openPxeStore(node, m)
	const sends = new SendJournal(recordingNode(stamping(node, sentAt, stages), sent, journal))
	const gate = new PaymentGate(sends.node, opts.payments)
	const proofs = opts.presto?.proofs
	const Staged = stagedWallet(stages, proofs?.around ?? ((prove) => prove()))
	const pxe = { proverEnabled: opts.proves, store, proverOrOptions: proofs?.prover, simulator: proofs?.simulator }
	const wallet = await gate.bindWallet((gated) => sends.bindWallet(() => Staged.create(gated, { pxe })))
	await registerSponsor(wallet, m)
	await registerBridgeContracts(wallet, m)
	const cast = {} as Record<Actor, Player>
	for (const actor of ACTORS) {
		const member = castMember(m, actor, opts.usersTag)
		// Repeats safely on reload: an account the store already holds is not registered again.
		const account = await wallet.createSchnorrAccount(member.secret, Fr.ZERO, member.signingKey, actor)
		cast[actor] = { ...member, address: account.address }
	}
	return { wallet, node, gate, sends, cast, sentAt, sent, onNextSend, exclusive: oneAtATime(), stages, presto: opts.presto }
}
