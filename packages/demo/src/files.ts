import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { BridgeManifest } from "@galactica-net/inference-money-core"
import { z } from "zod"
// The extensions let Node load this file: the showcase's build config imports it outside any bundler.
import { MERCHANTS_SALT } from "./merchants-salt.ts"
import { USERS_TAG } from "./users-tag.ts"

const bridge = z.string().regex(/^0x[0-9a-f]{64}$/)
const usersTag = z.string().regex(USERS_TAG)

/**
 * `deployments/testnet-demo.json` (a local run keeps its own): which deployment, its published users' tag and its
 * merchants' salt.
 */
export const demoFileSchema = z.strictObject({ version: z.literal(2), bridge, usersTag, merchantsSalt: z.string().regex(MERCHANTS_SALT) })
export type DemoFile = z.infer<typeof demoFileSchema>

/** The keys a published demo derives its cast from. */
export const castKeysOf = (f: DemoFile): { usersTag: string; merchantsSalt: string } => ({
	usersTag: f.usersTag,
	merchantsSalt: f.merchantsSalt,
})

/** A manifest and the path it was read from. */
export interface DeploymentRef {
	path: string
	m: BridgeManifest
}

/** Where the published demo lives: beside a testnet manifest, or in a local run's directory. */
export const demoFilePath = (ref: DeploymentRef): string =>
	ref.m.network === "local" ? join(dirname(ref.path), "demo.json") : ref.path.replace(/\.json$/, "-demo.json")

/**
 * This deployment's published demo, or undefined: none yet, or one left by an earlier deployment, which `demo setup`
 * overwrites. Refuses one from before the merchants' salt (version 1), whose merchants derived from the deployment alone.
 */
export function readDemoFile(ref: DeploymentRef): DemoFile | undefined {
	const path = demoFilePath(ref)
	if (!existsSync(path)) return undefined
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
	const { bridge: of, version } = (raw ?? {}) as { bridge?: unknown; version?: unknown }
	if (of !== ref.m.l2.bridge.address) return undefined
	if (version !== 2)
		throw new Error(`${path} is a version-${version} demo, without the merchants' salt: redeploy, then run \`bridge demo setup\`.`)
	return demoFileSchema.parse(raw)
}

/** Publishes this deployment's demo, always as version 2; returns where. */
export function writeDemoFile(ref: DeploymentRef, keys: { usersTag: string; merchantsSalt: string }): string {
	const file = demoFileSchema.parse({ version: 2, bridge: ref.m.l2.bridge.address, ...keys })
	const path = demoFilePath(ref)
	writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`)
	return path
}
