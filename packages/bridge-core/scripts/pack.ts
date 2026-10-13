// Builds the publishable package into ./publish: the bundled entries, their declarations, and a manifest whose exports
// name them. The workspace's own package.json stays private and exports its sources (docs/publishing.md).
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const REPO = join(ROOT, "..", "..")
const OUT = join(ROOT, "publish")

const run = (cmd: string, args: string[], cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: "inherit" })
const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim()

/** A release is one commit's code: a package built from uncommitted changes could never be rebuilt. */
function releaseCommit(): string | undefined {
	if (git("status", "--porcelain") === "") return git("rev-parse", "HEAD")
	if (process.env.PACK_ALLOW_DIRTY !== "1") throw new Error("the working tree has uncommitted changes: commit them first")
	console.warn("PACK_ALLOW_DIRTY=1: packing uncommitted changes, for a dry run only. Do not publish this build.")
	return undefined
}

function build(): void {
	rmSync(join(ROOT, "dist"), { recursive: true, force: true })
	run("bunx", ["tsup"])
	run("bunx", ["tsc", "-p", "tsconfig.build.json"])
	// tsc roots its output at the repository (the sources import the committed artifacts and manifests from there).
	const types = join(ROOT, "dist", "types")
	renameSync(join(types, "packages", "bridge-core", "src"), join(ROOT, "dist", "types-src"))
	rmSync(types, { recursive: true })
	renameSync(join(ROOT, "dist", "types-src"), types)
}

/** `./src/deploy/index.ts` is built as the entry tsup.config.ts names after its subpath (`.` is `index`). */
function publishedExports(source: Record<string, string>) {
	return Object.fromEntries(
		Object.entries(source).map(([subpath, src]) => {
			const entry = subpath === "." ? "index" : subpath.slice(2)
			const types = src.replace(/^\.\/src\//, "./dist/types/").replace(/\.ts$/, ".d.ts")
			return [subpath, { types, import: `./dist/${entry}.js` }]
		}),
	)
}

function writePackage(commit: string | undefined): void {
	const {
		private: _private,
		scripts: _scripts,
		devDependencies: _dev,
		...pkg
	} = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
	const exports = publishedExports(pkg.exports)
	const manifest = {
		...pkg,
		exports,
		types: exports["."]?.types,
		files: ["dist"],
		sideEffects: false,
		...(commit ? { gitHead: commit } : {}),
	}
	rmSync(OUT, { recursive: true, force: true })
	mkdirSync(OUT, { recursive: true })
	cpSync(join(ROOT, "dist"), join(OUT, "dist"), { recursive: true })
	cpSync(join(ROOT, "README.md"), join(OUT, "README.md"))
	cpSync(join(REPO, "LICENSE"), join(OUT, "LICENSE"))
	writeFileSync(join(OUT, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`)
}

const commit = releaseCommit()
build()
writePackage(commit)
console.log(`packed ${OUT}${commit ? ` at ${commit}` : ""}`)
