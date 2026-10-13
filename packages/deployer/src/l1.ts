import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { L1Signer } from "@galactica-net/inference-money-core/deploy"
import { type Address, getAddress, type Hex, keccak256 } from "viem"

interface Vendored {
	address: Address
	keccak: Hex
	code: Hex
}

/**
 * Installs Permit2's vendored Sepolia runtime at its canonical address (anvil only). Vendored, never fetched live, so
 * a poisoned RPC cannot reach the chain; the keccak is checked before install and read back after.
 */
export async function installCanonicalPermit2(l1: L1Signer): Promise<Address> {
	const v = JSON.parse(readFileSync(join(import.meta.dir, "..", "bytecode", "permit2.json"), "utf8")) as Vendored
	if (keccak256(v.code) !== v.keccak) throw new Error("vendored Permit2 code does not match its pinned keccak")
	await l1.publicClient.request({ method: "anvil_setCode" as never, params: [v.address, v.code] as never })
	const onChain = await l1.publicClient.getCode({ address: v.address })
	if (!onChain || keccak256(onChain) !== v.keccak) throw new Error("Permit2 code read back does not match its pinned keccak")
	return getAddress(v.address)
}
