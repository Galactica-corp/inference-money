import { type Address, getAddress, type Hex, keccak256 } from "viem"
import type { L1Signer } from "./l1"
// Permit2's Sepolia runtime, committed so a local deploy never fetches code; permit2-local.test.ts holds it to its keccak.
import vendored from "./permit2.json"

/** Permit2's canonical address, its runtime code and that code's pinned keccak. */
export const CANONICAL_PERMIT2 = {
	address: getAddress(vendored.address),
	keccak: vendored.keccak as Hex,
	code: vendored.code as Hex,
}

/**
 * Installs Permit2's vendored Sepolia runtime at its canonical address. Local networks only: it writes through
 * `anvil_setCode`, and every public chain already has Permit2 there. Vendored, never fetched live, so a poisoned RPC
 * cannot reach the chain; the keccak is checked before install and read back after.
 */
export async function installCanonicalPermit2(l1: L1Signer): Promise<Address> {
	const v = CANONICAL_PERMIT2
	if (keccak256(v.code) !== v.keccak) throw new Error("vendored Permit2 code does not match its pinned keccak")
	await l1.publicClient.request({ method: "anvil_setCode" as never, params: [v.address, v.code] as never })
	const onChain = await l1.publicClient.getCode({ address: v.address })
	if (!onChain || keccak256(onChain) !== v.keccak) throw new Error("Permit2 code read back does not match its pinned keccak")
	return v.address
}
