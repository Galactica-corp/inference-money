import { execFileSync } from "node:child_process"
import { REPO_ROOT } from "@galactica-net/inference-money-local-network"

/** The commit this checkout runs: a keyed run's is the pushed commit it was approved at. */
export const sourceCommit = (): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim()
