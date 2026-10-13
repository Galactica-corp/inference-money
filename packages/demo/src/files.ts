import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { BridgeManifest } from "@galactica-net/inference-money-core"
import { z } from "zod"
// The extension lets Node load this file: the showcase's build config imports it outside any bundler.
import { USERS_TAG } from "./users-tag.ts"

/** `deployments/testnet-demo.json` (a local run keeps its own): which deployment, and the published users' tag. */
export const demoFileSchema = z.strictObject({
	version: z.literal(1),
	bridge: z.string().regex(/^0x[0-9a-f]{64}$/),
	usersTag: z.string().regex(USERS_TAG),
})
export type DemoFile = z.infer<typeof demoFileSchema>

/** A manifest and the path it was read from. */
export interface DeploymentRef {
	path: string
	m: BridgeManifest
}

/** Where the published users' tag lives: beside a testnet manifest, or in a local run's directory. */
export const demoFilePath = (ref: DeploymentRef): string =>
	ref.m.network === "local" ? join(dirname(ref.path), "demo.json") : ref.path.replace(/\.json$/, "-demo.json")

/** This deployment's published demo, or undefined: none yet, or one left by an earlier deployment. */
export function readDemoFile(ref: DeploymentRef): DemoFile | undefined {
	const path = demoFilePath(ref)
	if (!existsSync(path)) return undefined
	const f = demoFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
	return f.bridge === ref.m.l2.bridge.address ? f : undefined
}
