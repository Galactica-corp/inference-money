/**
 * Whether CI's Presto job can prove: `run=true` when Presto's SDK pins the toolchain's stdlib, `run=false` with a warning
 * for exactly the pair named in PRESTO_SKIP_TOOLCHAIN and PRESTO_SKIP_STDLIB, and a failure for any other pair or
 * unreadable metadata. Reads the repo at the working directory.
 *
 *   bun apps/showcase/e2e/run/presto-compat.ts   → run=<bool> on stdout and in $GITHUB_OUTPUT
 */
import { appendFileSync } from "node:fs"
import { prestoPins } from "../../build/target"

function decide(env: Readonly<Record<string, string | undefined>>): boolean {
	const { aztecNode, aztecJs, prestoStdlib } = prestoPins(process.cwd())
	if (prestoStdlib === aztecJs) return true
	if (aztecNode === aztecJs && aztecJs === env.PRESTO_SKIP_TOOLCHAIN && prestoStdlib === env.PRESTO_SKIP_STDLIB) {
		console.log(
			`::warning::Presto's SDK pins @aztec-labs/stdlib ${prestoStdlib}, not the toolchain's ${aztecJs}: its real proofs fail on this node, so the Presto suite is skipped.`,
		)
		return false
	}
	throw new Error(`Presto's SDK pins @aztec-labs/stdlib ${prestoStdlib}, the toolchain ${aztecNode}/${aztecJs}: not a skippable pair.`)
}

const line = `run=${decide(process.env)}`
console.log(line)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`)
