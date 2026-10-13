// Rewrites src/deploy/evm-artifacts.json from contracts/evm/out; `bun run embed:evm` builds that first.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BRIDGE_EVM_SOURCES, evmArtifactFromForge } from "../src/deploy/evm"

const out = join(import.meta.dir, "..", "..", "..", "contracts", "evm", "out")
const entries = Object.entries(BRIDGE_EVM_SOURCES).map(([key, { source, name }]) => [
	key,
	evmArtifactFromForge(JSON.parse(readFileSync(join(out, source, `${name}.json`), "utf8"))),
])
writeFileSync(join(import.meta.dir, "..", "src", "deploy", "evm-artifacts.json"), `${JSON.stringify(Object.fromEntries(entries))}\n`)
