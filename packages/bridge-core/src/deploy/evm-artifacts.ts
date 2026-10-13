import type { BridgeEvmArtifacts } from "./evm"
// The compiled L1 contracts, committed so a dependent can deploy without Foundry. `bun run embed:evm` rewrites the
// file and evm-artifacts.test.ts keeps it equal to a fresh forge build.
import artifacts from "./evm-artifacts.json"

export const BRIDGE_EVM_ARTIFACTS = artifacts as unknown as BridgeEvmArtifacts
