import { MERCHANT_MAX_DELAY } from "@galactica-net/inference-money-core"

/** A sent tx's committed expiry and the timestamp of the block it anchored at. */
export type Sent = { expiresAt: bigint; anchorTs: bigint }

export const lifetime = (tx: Sent) => tx.expiresAt - tx.anchorTs

/**
 * The expiry the PXE commits for an in-circuit cap: capped at MAX_TX_LIFETIME, then rounded down from the anchor to
 * whole hours, else half hours, else seconds (pxe `compute_tx_expiration_timestamp.js`), so exact caps don't leak.
 */
export function committedExpiry(tx: Sent, cap: bigint): bigint {
	if (cap >= tx.anchorTs + MERCHANT_MAX_DELAY) return tx.anchorTs + MERCHANT_MAX_DELAY
	const span = cap - tx.anchorTs
	const step = [3600n, 1800n, 1n].find((s) => span - (span % s) > 0n) ?? 1n
	return tx.anchorTs + span - (span % step)
}
