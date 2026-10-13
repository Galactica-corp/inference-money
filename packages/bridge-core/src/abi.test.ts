import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { OutboxAbi } from "@aztec-foundation/l1-artifacts/OutboxAbi"
import { RegistryAbi } from "@aztec-foundation/l1-artifacts/RegistryAbi"
import { encodeErrorResult } from "viem"
import {
	OUTBOX_ABI,
	PERMIT2_DEPOSIT_ROUTER_ABI,
	PERMIT2_NONCE_ABI,
	PERMIT2_SIGNATURE_ERRORS,
	PORTAL_BUBBLED_ERRORS,
	REGISTRY_ABI,
	TOKEN_PORTAL_ABI,
} from "./abi"

type Param = { name?: string; type: string; indexed?: boolean; components?: readonly Param[] }
type Entry = { type: string; name?: string; stateMutability?: string; inputs?: readonly Param[]; outputs?: readonly Param[] }

const param = (p: Param): unknown => ({
	name: p.name ?? "",
	type: p.type,
	...(p.indexed !== undefined ? { indexed: p.indexed } : {}),
	...(p.components ? { components: p.components.map(param) } : {}),
})
const shape = (e: Entry) => ({
	type: e.type,
	name: e.name,
	stateMutability: e.stateMutability,
	inputs: (e.inputs ?? []).map(param),
	outputs: (e.outputs ?? []).map(param),
})

/** Every hand-written entry must equal the source entry of the same kind and name (overloads: any one of them). */
function expectPinned(ours: readonly Entry[], source: readonly Entry[]) {
	for (const e of ours) {
		const candidates = source.filter((s) => s.type === e.type && s.name === e.name).map(shape)
		expect(candidates, `${e.type} ${e.name}`).toContainEqual(shape(e))
	}
}

// Read inside `it`, never at collection: a missing `out/` must fail these tests, not crash the whole run.
const EVM_OUT = join(import.meta.dir, "..", "..", "..", "contracts", "evm", "out")
const forgeAbi = (contract: string): Entry[] => {
	const path = join(EVM_OUT, `${contract}.sol`, `${contract}.json`)
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as { abi: Entry[] }).abi
	} catch (e) {
		throw new Error(`${path} unreadable: build the contracts first (bun run --cwd contracts/evm build)`, { cause: e })
	}
}

describe("hand-written ABIs equal the compiled contracts", () => {
	it("Permit2DepositRouter (the portal's errors it bubbles; Permit2's are pinned by selector below)", () => {
		const foreign = new Set<string>([...PERMIT2_SIGNATURE_ERRORS, ...PORTAL_BUBBLED_ERRORS].map((e) => e.name))
		const ours = (PERMIT2_DEPOSIT_ROUTER_ABI as readonly Entry[]).filter((e) => !foreign.has(e.name ?? ""))
		expectPinned(ours, forgeAbi("Permit2DepositRouter"))
		expectPinned(PORTAL_BUBBLED_ERRORS, forgeAbi("TokenPortal"))
	})
	it("TokenPortal (with the Outbox errors its withdraw bubbles)", () =>
		expectPinned(TOKEN_PORTAL_ABI, [...forgeAbi("TokenPortal"), ...(OutboxAbi as readonly Entry[])]))
	it("a drifted entry fails the pin", () => {
		const deposit = PERMIT2_DEPOSIT_ROUTER_ABI[0]
		const swapped = { ...deposit, inputs: [deposit.inputs[1], deposit.inputs[0], ...deposit.inputs.slice(2)] }
		expect(() => expectPinned([swapped], forgeAbi("Permit2DepositRouter"))).toThrow()
	})
	it("Permit2's nonce bitmap, as the repo's ISignatureTransfer declares it", () =>
		expectPinned(PERMIT2_NONCE_ABI, forgeAbi("ISignatureTransfer")))
	it("Permit2's signature errors, by selector", () => {
		expect(encodeErrorResult({ abi: PERMIT2_SIGNATURE_ERRORS, errorName: "InvalidContractSignature" })).toBe("0xb0669cbc")
		expect(encodeErrorResult({ abi: PERMIT2_SIGNATURE_ERRORS, errorName: "InvalidSigner" })).toBe("0x815e1d64")
	})
	it("Outbox, Registry", () => {
		expectPinned(OUTBOX_ABI, OutboxAbi as readonly Entry[])
		expectPinned(REGISTRY_ABI, RegistryAbi as readonly Entry[])
	})
})
