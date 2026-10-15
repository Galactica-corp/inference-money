// Checks ./publish as npm would ship it: only the built files, and every subpath export loads under Node.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const OUT = join(import.meta.dir, "..", "publish")
const pkg = JSON.parse(readFileSync(join(OUT, "package.json"), "utf8")) as {
	name: string
	private?: boolean
	exports: Record<string, unknown>
	dependencies: Record<string, string>
}

if (pkg.private) throw new Error("the packed manifest is still private")
const unresolved = Object.entries(pkg.dependencies).filter(([, range]) => range.startsWith("workspace:"))
if (unresolved.length > 0) throw new Error(`workspace dependencies would not install from npm: ${unresolved.map(([n]) => n).join(", ")}`)

const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: OUT, encoding: "utf8" })) as [
	{ files: { path: string }[] },
]
const stray = packed.files.map((f) => f.path).filter((p) => !p.startsWith("dist/") && !["package.json", "README.md", "LICENSE"].includes(p))
if (stray.length > 0) throw new Error(`the tarball would ship ${stray.join(", ")}`)

// Run from inside the package, Node resolves the package's own name through its exports, as a dependent's import would.
const subpaths = Object.keys(pkg.exports).map((s) => (s === "." ? pkg.name : `${pkg.name}/${s.slice(2)}`))
const probe = `
const [core, deploy, deployments] = await Promise.all(${JSON.stringify(subpaths.slice(0, 3))}.map((s) => import(s)))
for (const s of ${JSON.stringify(subpaths.slice(3))}) await import(s)
const need = (ok, what) => { if (!ok) throw new Error(what) }
need(typeof core.tokenArtifact?.name === "string", "the token artifact is missing")
need(typeof deploy.deployTestBridge === "function", "deployTestBridge is missing")
need(typeof deploy.installCanonicalPermit2 === "function", "installCanonicalPermit2 is missing")
need(typeof deploy.startBlockHeartbeat === "function", "startBlockHeartbeat is missing")
need(deploy.BRIDGE_EVM_ARTIFACTS.portal.bytecode.length > 2, "the portal bytecode is missing")
need(deployments.TESTNET_MANIFEST.network === "testnet", "the testnet manifest is missing")
console.log(deployments.TESTNET_MANIFEST.l2.bridge.address)
`
const bridge = execFileSync("node", ["--input-type=module", "-e", probe], { cwd: OUT, encoding: "utf8" }).trim()
console.log(`${pkg.name}: ${packed.files.length} files, ${subpaths.length} subpaths load; testnet bridge ${bridge}`)
