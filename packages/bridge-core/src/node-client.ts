// biome-ignore lint/style/noRestrictedImports: the one call site the ban routes everything else through
import { type AztecNode, type AztecNodeClientOptions, createAztecNodeClient } from "@aztec-labs/aztec.js/node"

/**
 * The SDK sends every node call made in one tick as one JSON-RPC batch (up to 100 calls). dRPC's keyless Aztec
 * endpoints refuse a batch of more than 3 (code 31), and a PXE sync or a deploy issues far more per tick.
 */
export const NODE_MAX_BATCH_SIZE = 3

/** An Aztec node client whose batches dRPC's keyless endpoints accept; the only way this repo opens one. */
export function createNodeClient(url: string, options: Omit<AztecNodeClientOptions, "maxBatchSize"> = {}): AztecNode {
	return createAztecNodeClient(url, { ...options, maxBatchSize: NODE_MAX_BATCH_SIZE })
}
