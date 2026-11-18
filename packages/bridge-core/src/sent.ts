import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { TxHash } from "@aztec-labs/aztec.js/tx"
import type { Tx } from "@aztec-labs/stdlib/tx"

/** A tx as handed to its node: the hash, and the time after which it can no longer be included. */
export interface HandedTx {
	txHash: TxHash
	expiresAt: bigint
}

/** The txs a watch matched, in the order the wallet handed them to the node. */
export interface SendWatch {
	readonly seen: readonly HandedTx[]
	stop(): void
}

interface Watch {
	matches: (tx: Tx) => boolean
	seen: HandedTx[]
}

/**
 * The node a wallet sends through, noting each tx a live watch matches before the node sees it: a send that then
 * throws, or whose reply is lost, still leaves the hash of a tx the node may hold. Binding is cooperative, as with
 * `PaymentGate`: it records the wallet its factory returns, not proof that the wallet sends through this node.
 */
export class SendJournal<N extends Pick<AztecNode, "sendTx"> = AztecNode> {
	readonly node: N
	private readonly watches = new Set<Watch>()
	private readonly bound = new WeakSet<object>()

	constructor(node: N) {
		this.node = new Proxy(node, {
			get: (target, key, receiver) =>
				key === "sendTx" ? (tx: Tx) => this.noteThenSend(target, tx) : Reflect.get(target, key, receiver),
		})
	}

	/** Builds a wallet on this journal's node; `exitToL1` refuses a wallet built any other way. */
	async bindWallet<W extends object>(create: (node: N) => Promise<W>): Promise<W> {
		const wallet = await create(this.node)
		this.bound.add(wallet)
		return wallet
	}

	isBound(wallet: object): boolean {
		return this.bound.has(wallet)
	}

	/** Notes every tx sent through {@link SendJournal.node} that `matches`, until `stop`. */
	watch(matches: (tx: Tx) => boolean): SendWatch {
		const w: Watch = { matches, seen: [] }
		this.watches.add(w)
		return { seen: w.seen, stop: () => void this.watches.delete(w) }
	}

	private noteThenSend(target: N, tx: Tx): Promise<void> {
		for (const w of this.watches) {
			if (w.matches(tx)) w.seen.push({ txHash: tx.getTxHash(), expiresAt: tx.data.expirationTimestamp })
		}
		return target.sendTx(tx)
	}
}
