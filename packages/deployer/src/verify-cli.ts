import { readFileSync } from "node:fs"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { parseTour, tourMismatches } from "@inference-money/demo"
import { createPublicClient, http, type PublicClient } from "viem"
import type { Check } from "./preflight"
import { endpointsFor, type ManifestRef } from "./session"
import { buildFresh } from "./testnet"
import { assertAllPass, VerificationFailed, verifyDeployment } from "./verify"

export interface VerifyFlags {
	tour?: string | undefined
	node?: string | undefined
	l1Rpc?: string | undefined
	/** The guardian the deployment should have, in office and scheduled; none when absent. */
	guardian?: string | undefined
	/** Accept merchant entries' changes in flight, as `delayPolicyChecks` allows. */
	allowPending?: boolean
	log: (m: string) => void
}

function tourChecks(path: string, ref: ManifestRef): Check[] {
	try {
		const mismatches = tourMismatches(parseTour(JSON.parse(readFileSync(path, "utf8"))), ref.m)
		return [{ name: "tour schema and identity", ok: mismatches.length === 0, detail: mismatches.join("; ") || path }]
	} catch (e) {
		return [{ name: "tour schema and identity", ok: false, detail: e instanceof Error ? e.message : String(e) }]
	}
}

/**
 * Strict and keyless: every read-back of the deployment (the handover complete), plus the recorded tour's schema and
 * identity with `--tour`; `--allow-pending` accepts merchant changes still in flight. It trusts the endpoints it reads
 * through: pass your own with `--node` and `--l1-rpc`.
 */
export async function verifyManifest(ref: ManifestRef, flags: VerifyFlags): Promise<number> {
	const { nodeUrl, l1RpcUrl } = endpointsFor(ref, { node: flags.node, l1Rpc: flags.l1Rpc })
	// The origin only: a provider URL carries its API key in the path or the query.
	flags.log(`verifying ${ref.path} through node ${new URL(nodeUrl).origin}`)
	const l1 = createPublicClient({ transport: http(l1RpcUrl) }) as PublicClient
	const { guardian, allowPending } = flags
	const checks = await verifyDeployment(ref.m, buildFresh(), l1, createAztecNodeClient(nodeUrl), "complete", { guardian, allowPending })
	if (flags.tour) checks.push(...tourChecks(flags.tour, ref))
	try {
		assertAllPass(checks, flags.log)
	} catch (e) {
		if (e instanceof VerificationFailed) {
			flags.log(`verify: ${e.failures.length} check(s) failed`)
			return 1
		}
		throw e
	}
	const warnings = checks.filter((c) => c.warn).map((c) => c.name)
	flags.log(`verify: every check passed${warnings.length ? `, with ${warnings.length} warning(s): ${warnings.join("; ")}` : ""}`)
	return 0
}
