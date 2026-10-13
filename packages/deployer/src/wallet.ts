import { type AztecNode, createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { withOwnedTmpDir } from "./owned-tmp"

/**
 * An ephemeral wallet; `prove: false` only for a local correctness loop. Its key stores land in TMPDIR, so open it
 * inside an owned tmp scope.
 */
export function openBridgeWallet(node: AztecNode, opts: { prove: boolean }): Promise<EmbeddedWallet> {
	return EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: opts.prove } })
}

type Open = (node: AztecNode) => Promise<EmbeddedWallet>

export interface BridgeWalletOptions {
	prove: boolean
	/** Opens the wallet on a node built from the plain one, such as a payment gate's (default: the plain one). */
	bind?: (node: AztecNode, open: Open) => Promise<EmbeddedWallet>
}

/** {@link openBridgeWallet} inside an owned tmp scope, stopped before the scope's dir is removed. */
export function withBridgeWallet<T>(nodeUrl: string, opts: BridgeWalletOptions, fn: (w: EmbeddedWallet, node: AztecNode) => Promise<T>) {
	return withOwnedTmpDir(async () => {
		const node = createAztecNodeClient(nodeUrl)
		const open: Open = (n) => openBridgeWallet(n, opts)
		const wallet = await (opts.bind ? opts.bind(node, open) : open(node))
		try {
			return await fn(wallet, node)
		} finally {
			await wallet.stop()
		}
	})
}

export { recordingNode, type SentTx } from "@galactica-net/inference-money-demo"
