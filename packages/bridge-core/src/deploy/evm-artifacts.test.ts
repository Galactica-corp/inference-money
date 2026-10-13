import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BRIDGE_EVM_SOURCES, evmArtifactFromForge } from "./evm"
import { BRIDGE_EVM_ARTIFACTS } from "./evm-artifacts"

// Read inside `it`, never at collection: a missing `out/` must fail these tests, not crash the whole run.
const EVM_OUT = join(import.meta.dir, "..", "..", "..", "..", "contracts", "evm", "out")

describe("the committed L1 artifacts equal the compiled contracts", () => {
	it.each(Object.entries(BRIDGE_EVM_SOURCES))("%s", (key, { source, name }) => {
		const path = join(EVM_OUT, source, `${name}.json`)
		let built: unknown
		try {
			built = JSON.parse(readFileSync(path, "utf8"))
		} catch (e) {
			throw new Error(`${path} unreadable: build the contracts first (bun run --cwd contracts/evm build)`, { cause: e })
		}
		// A mismatch means a contract changed: `bun run --cwd packages/bridge-core embed:evm`.
		expect(BRIDGE_EVM_ARTIFACTS[key as keyof typeof BRIDGE_EVM_SOURCES]).toEqual(evmArtifactFromForge(built))
	})
})
