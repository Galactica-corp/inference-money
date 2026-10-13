import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type BridgeManifest, parseManifest } from "@galactica-net/inference-money-core"
import { localDeploymentDir } from "@galactica-net/inference-money-local-network"

export const localManifestPath = (runId: string) => join(localDeploymentDir(runId), "manifest.json")

/** Validated, then written atomically: a reader never sees a partial or unvalidated manifest. */
export function writeManifest(path: string, m: BridgeManifest): void {
	const valid = parseManifest(m)
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(valid, null, "\t")}\n`)
	renameSync(tmp, path)
}

export const readManifest = (path: string): BridgeManifest => parseManifest(JSON.parse(readFileSync(path, "utf8")))
