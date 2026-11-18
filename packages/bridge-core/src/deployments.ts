// The deployments this package ships: the artifacts beside it derive every address they record (deployments.test.ts).
import mainnet from "../../../deployments/mainnet.json"
import testnet from "../../../deployments/testnet.json"
import { type BridgeManifest, parseManifest } from "./manifest"

export const TESTNET_MANIFEST: BridgeManifest = parseManifest(testnet)
export const MAINNET_MANIFEST: BridgeManifest = parseManifest(mainnet)

export const DEPLOYMENTS = { testnet: TESTNET_MANIFEST, mainnet: MAINNET_MANIFEST } as const satisfies Record<string, BridgeManifest>
