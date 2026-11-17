import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { L2AmountClaim } from "@aztec-labs/aztec.js/ethereum"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Hex } from "viem"
import { STATE_ROOT, syncDir, writeDurably } from "./run-state"

/**
 * Fee Juice bridged to an account that has not claimed it yet, kept until it lands. The message names its recipient,
 * so the secret claims only into that account's balance: whoever holds it can at worst pay that account's fee early.
 * Without the file a claim whose public send failed is lost for good, since Fee Juice never leaves L2.
 */
export const FEE_CLAIMS_DIR = join(STATE_ROOT, "fee-claims")

const fileFor = (network: string, to: AztecAddress, dir: string) => join(dir, `${network}-${to.toString()}.json`)

interface Stored {
	claimAmount: string
	claimSecret: string
	claimSecretHash: string
	messageHash: string
	messageLeafIndex: string
}

/** Atomic and flushed: a crash leaves the previous file or the new one, never a torn claim. */
export function saveFeeClaim(network: string, to: AztecAddress, claim: L2AmountClaim, dir = FEE_CLAIMS_DIR): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const path = fileFor(network, to, dir)
	const stored: Stored = {
		claimAmount: claim.claimAmount.toString(),
		claimSecret: claim.claimSecret.toString(),
		claimSecretHash: claim.claimSecretHash.toString(),
		messageHash: claim.messageHash,
		messageLeafIndex: claim.messageLeafIndex.toString(),
	}
	const tmp = `${path}.${process.pid}.tmp`
	rmSync(tmp, { force: true })
	writeDurably(tmp, `${JSON.stringify(stored, null, "\t")}\n`)
	renameSync(tmp, path)
	syncDir(dir)
	return path
}

export function loadFeeClaim(network: string, to: AztecAddress, dir = FEE_CLAIMS_DIR): L2AmountClaim | undefined {
	const path = fileFor(network, to, dir)
	if (!existsSync(path)) return undefined
	const s = JSON.parse(readFileSync(path, "utf8")) as Stored
	return {
		claimAmount: BigInt(s.claimAmount),
		claimSecret: Fr.fromHexString(s.claimSecret),
		claimSecretHash: Fr.fromHexString(s.claimSecretHash),
		messageHash: s.messageHash as Hex,
		messageLeafIndex: BigInt(s.messageLeafIndex),
	}
}

/** Only once the claim has landed: the balance it raised is the proof. */
export function removeFeeClaim(network: string, to: AztecAddress, dir = FEE_CLAIMS_DIR): void {
	rmSync(fileFor(network, to, dir), { force: true })
	if (existsSync(dir)) syncDir(dir)
}
