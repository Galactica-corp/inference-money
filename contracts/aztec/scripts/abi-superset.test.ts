import { describe, expect, it } from "bun:test"
import { type ContractArtifact, FunctionType, loadContractArtifact } from "@aztec-labs/stdlib/abi"
import type { NoirCompiledContract } from "@aztec-labs/stdlib/noir"
import { normalizedFunctions, storageSlots } from "./artifact-identity"

const UPSTREAM = new URL("../node_modules/@aztec-foundation/aztec-standards/artifacts/target/token_contract-Token.json", import.meta.url)
	.pathname
const FORK = new URL("../token/target/merchant_token-Token.json", import.meta.url).pathname

// Everything the fork adds to aztec-standards' Token. The rest must be upstream's, unchanged, so integrations written
// against upstream (Galactica's x402 calls among them) keep working.
const ADDED_FUNCTIONS = [
	"accept_merchant_admin",
	"add_merchant",
	"cancel_merchant_change",
	"get_merchant_roles",
	"get_merchant_status",
	"is_merchant",
	"pay_private",
	"propose_merchant_admin",
	"schedule_merchant_guardian",
	"schedule_merchant_off",
	"set_merchant_delay",
	"sync_merchant_delay",
	"try_prove_merchant",
]
const ADDED_STORAGE = ["merchant_admin", "merchant_delay", "merchant_guardian", "merchant_off", "merchants", "pending_merchant_admin"]
const ADDED_EVENTS = [
	"Token::MerchantAdded",
	"Token::MerchantAdminAccepted",
	"Token::MerchantAdminProposed",
	"Token::MerchantDelayScheduled",
	"Token::MerchantDelaySet",
	"Token::MerchantGuardianScheduled",
	"Token::MerchantOffScheduled",
	"Token::PaymentReceived",
]
// The class registry packs public bytecode 31 bytes per field plus a length field, and refuses more than 3000
// (MAX_PACKED_PUBLIC_BYTECODE_SIZE_IN_FIELDS). Upstream packs to 707; the ceiling leaves the fork headroom for fixes.
const MAX_PUBLIC_BYTECODE_FIELDS = 2700

const load = async (path: string) => (await Bun.file(path).json()) as NoirCompiledContract
const upstreamJson = await load(UPSTREAM)
const forkJson = await load(FORK)
const upstream = loadContractArtifact(upstreamJson)
const fork = loadContractArtifact(forkJson)

const events = (a: ContractArtifact) => a.outputs.structs.events as { path: string }[]
const added = (all: string[], base: string[]) => all.filter((n) => !base.includes(n)).sort()

describe("the merchant token is an ABI superset of aztec-standards' Token", () => {
	it("keeps every upstream function's selector, type, attributes, parameters and returns", async () => {
		const forkFns = await normalizedFunctions(fork)
		for (const fn of await normalizedFunctions(upstream)) {
			expect(forkFns.find((f) => f.name === fn.name && f.functionType === fn.functionType)).toEqual(fn)
		}
	})

	it("adds exactly the listed functions", async () => {
		const names = async (a: ContractArtifact) => (await normalizedFunctions(a)).map((f) => f.name)
		expect(added(await names(fork), await names(upstream))).toEqual([...ADDED_FUNCTIONS].sort())
	})

	it("keeps upstream's storage slots and adds exactly the listed fields", () => {
		const forkSlots = storageSlots(fork)
		for (const field of storageSlots(upstream)) expect(forkSlots).toContainEqual(field)
		const names = (a: ContractArtifact) => storageSlots(a).map((s) => s.name)
		expect(added(names(fork), names(upstream))).toEqual([...ADDED_STORAGE].sort())
	})

	it("keeps upstream's events and adds exactly the listed ones", () => {
		for (const event of events(upstream)) expect(events(fork)).toContainEqual(event)
		const paths = (a: ContractArtifact) => events(a).map((e) => e.path)
		expect(added(paths(fork), paths(upstream))).toEqual([...ADDED_EVENTS].sort())
	})

	it("keeps its public bytecode within the ceiling", () => {
		const packedFields = (a: ContractArtifact) => {
			const dispatch = a.functions.filter((f) => f.functionType === FunctionType.PUBLIC)
			expect(dispatch.map((f) => f.name)).toEqual(["public_dispatch"])
			return Math.ceil(dispatch[0]!.bytecode.length / 31) + 1
		}
		expect(packedFields(upstream)).toBe(707)
		expect(packedFields(fork)).toBeLessThanOrEqual(MAX_PUBLIC_BYTECODE_FIELDS)
	})
})
