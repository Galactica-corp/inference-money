import { readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { type BridgeManifest, parseManifest } from "@inference-money/bridge-core/manifest"
import { castKeysOf, readDemoFile } from "@inference-money/demo/files"
import { TESTNET } from "@inference-money/deployer/networks"
import { resolveEndpoints } from "@inference-money/local-network/handle"

export type Proofs = "real" | "fake"

/** Where the page looks for Presto: the desktop app's ports, or a local run's own presto-server. */
export interface PrestoPorts {
	readonly port: number
	readonly httpsPort: number
}
export const PRESTO_DEFAULT: PrestoPorts = { port: 59833, httpsPort: 59834 }

/** What one build embeds. There is no runtime override: the bundle knows exactly one network. */
export interface BuildTarget {
	readonly manifest: BridgeManifest
	/** The published tag the demo's user accounts derive from. */
	readonly usersTag: string
	/** The published salt the demo's merchant accounts derive from. */
	readonly merchantsSalt: string
	/** A public endpoint the page reads and sends L1 through, never a keyed run's SEPOLIA_RPC_URL. */
	readonly l1RpcUrl: string
	readonly proofs: Proofs
	readonly presto: PrestoPorts
	/** The recording the page replays, as read: `build/manifest-identity.test.ts` and the page validate it. */
	readonly tour: unknown
}

export const TESTNET_MANIFEST = "deployments/testnet.json"
/** Written beside the bundle: the exact string `__BRIDGE_MANIFEST__` was defined as. */
export const EMBEDDED_MANIFEST = "bridge-manifest.json"
/** Written beside the bundle: the tour `__SHOWCASE_TOUR__` was defined as. */
export const EMBEDDED_TOUR = "showcase-tour.json"
/** A local deployment lives for one run, so a local build plays a fixture recording that names no live contract. */
const FIXTURE_TOUR = "apps/showcase/e2e/fixtures/tour.json"
/** A keyed run's variables: a build that sees one refuses to run, so no secret can reach a bundle. */
const KEYED = ["TESTNET_L1_PRIVATE_KEY", "TESTNET_DEPLOYER_SECRET", "TESTNET_ADMIN_SECRET", "SEPOLIA_RPC_URL"]
/** bb.js fetches its proving key material from these, a host it hardcodes and its fallback. */
export const CRS_ORIGINS = ["https://crs.aztec-cdn.foundation", "https://crs.aztec-labs.com"]

type Env = Readonly<Record<string, string | undefined>>

function readManifestFile(path: string): BridgeManifest {
	let raw: string
	try {
		raw = readFileSync(path, "utf8")
	} catch {
		throw new Error(`No bridge manifest at ${path}. Deploy first, or point BRIDGE_MANIFEST at a deployed manifest.`)
	}
	return parseManifest(JSON.parse(raw))
}

/** Presto's SDK: its `exports` hide its package.json from a resolver, so it is read by path. */
const PRESTO_PACKAGE = "apps/showcase/node_modules/@alejoamiras/presto/package.json"

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/

/**
 * The toolchain's node and SDK versions, and the `@aztec-labs/stdlib` Presto's SDK pins; throws unless each is an exact
 * version, so a comparison of them fails closed.
 */
function prestoPins(repoRoot: string): { aztecNode: string; aztecJs: string; prestoStdlib: string } {
	const { aztecNode, aztecJs } = JSON.parse(readFileSync(resolve(repoRoot, "toolchain.json"), "utf8"))
	const prestoStdlib = JSON.parse(readFileSync(resolve(repoRoot, PRESTO_PACKAGE), "utf8")).dependencies?.["@aztec-labs/stdlib"]
	if (![aztecNode, aztecJs, prestoStdlib].every((v) => typeof v === "string" && EXACT_VERSION.test(v))) {
		throw new Error(`toolchain.json needs exact aztecNode and aztecJs versions, and ${PRESTO_PACKAGE} an exact @aztec-labs/stdlib.`)
	}
	return { aztecNode, aztecJs, prestoStdlib }
}

/**
 * Kernel inputs from another stdlib fail on the node, and only once a visitor proves. Only a manifest on the toolchain's
 * node is checked: an older one builds for its recorded tour, and its live mode stops at the identity check on a newer node.
 */
function assertPrestoProves(m: BridgeManifest, repoRoot: string): void {
	const { aztecNode, aztecJs, prestoStdlib } = prestoPins(repoRoot)
	if (m.l2.nodeVersion !== aztecNode || prestoStdlib === aztecJs) return
	throw new Error(
		`Presto's SDK pins @aztec-labs/stdlib ${prestoStdlib}, not the toolchain's ${aztecJs}: no real-proof build until it moves.`,
	)
}

/** Testnet always proves for real; a local build fakes proofs unless SHOWCASE_PROOFS=real (the proving harness). */
function proofsFor(env: Env, m: BridgeManifest): Proofs {
	const p = env.SHOWCASE_PROOFS ?? (m.network === "testnet" ? "real" : "fake")
	if (p !== "real" && p !== "fake") throw new Error(`SHOWCASE_PROOFS is "real" or "fake", not "${p}"`)
	if (m.network === "testnet" && p !== "real") throw new Error("A testnet build proves for real.")
	return p
}

function portFrom(env: Env, name: string, fallback: number): number {
	const raw = env[name]
	if (raw === undefined) return fallback
	const n = Number(raw)
	if (!/^\d+$/.test(raw) || n < 1 || n > 65535) throw new Error(`${name} is a port (1-65535), not "${raw}"`)
	return n
}

/** Only a local build moves Presto: a served bundle must find the visitor's own app where it listens. */
function prestoFor(env: Env, m: BridgeManifest): PrestoPorts {
	const set = ["PRESTO_PORT", "PRESTO_HTTPS_PORT"].filter((name) => env[name] !== undefined)
	if (set.length === 0) return PRESTO_DEFAULT
	if (m.network === "testnet") throw new Error(`A testnet build finds Presto on its own ports: unset ${set.join(", ")}.`)
	const port = portFrom(env, "PRESTO_PORT", PRESTO_DEFAULT.port)
	const httpsPort = portFrom(env, "PRESTO_HTTPS_PORT", PRESTO_DEFAULT.httpsPort)
	if (port === httpsPort) throw new Error("PRESTO_PORT and PRESTO_HTTPS_PORT must differ.")
	return { port, httpsPort }
}

/** A testnet deployment's recorded acceptance run sits beside its manifest (`smoke --record`). */
function readTour(path: string, m: BridgeManifest, repoRoot: string): unknown {
	const file = m.network === "local" ? resolve(repoRoot, FIXTURE_TOUR) : path.replace(/\.json$/, "-tour.json")
	try {
		return JSON.parse(readFileSync(file, "utf8"))
	} catch {
		throw new Error(`${path} has no recorded tour at ${file}: run \`bun run bridge smoke ${path} --record ${file}\` first.`)
	}
}

/** A local run's anvil, from its network handle; testnet's pinned public endpoint. */
const l1RpcFor = (path: string, m: BridgeManifest, env: Env): string =>
	m.network === "local" ? resolveEndpoints(basename(dirname(path)), env as NodeJS.ProcessEnv).anvilUrl : TESTNET.defaultL1RpcUrl

/**
 * Resolves what a build embeds. `BRIDGE_TARGET=testnet` pins the committed testnet manifest and refuses every override;
 * otherwise `BRIDGE_MANIFEST` names the file (repo-relative or absolute), defaulting to the testnet one. The deployment's
 * published demo must sit beside it.
 */
export function resolveTarget(env: Env, repoRoot: string): BuildTarget {
	const keyed = KEYED.filter((name) => env[name])
	if (keyed.length > 0) throw new Error(`The showcase builds keyless: unset ${keyed.join(", ")}.`)
	const pinned = env.BRIDGE_TARGET === "testnet"
	if (env.BRIDGE_TARGET !== undefined && !pinned) throw new Error(`Unknown BRIDGE_TARGET "${env.BRIDGE_TARGET}"`)
	if (pinned && env.BRIDGE_MANIFEST) throw new Error(`The testnet build embeds ${TESTNET_MANIFEST} only: unset BRIDGE_MANIFEST.`)
	const path = resolve(repoRoot, pinned ? TESTNET_MANIFEST : (env.BRIDGE_MANIFEST ?? TESTNET_MANIFEST))
	const manifest = readManifestFile(path)
	if (pinned && manifest.network !== "testnet") throw new Error(`${TESTNET_MANIFEST} is a ${manifest.network} manifest`)
	const demo = readDemoFile({ path, m: manifest })
	if (!demo) throw new Error(`${path} has no published demo: run \`bun run bridge demo setup ${path}\` first.`)
	const proofs = proofsFor(env, manifest)
	if (proofs === "real") assertPrestoProves(manifest, repoRoot)
	return {
		manifest,
		...castKeysOf(demo),
		l1RpcUrl: l1RpcFor(path, manifest, env),
		proofs,
		presto: prestoFor(env, manifest),
		tour: readTour(path, manifest, repoRoot),
	}
}

/**
 * Frames nothing, and talks to nothing but itself, the Aztec node, the L1 RPC and, when it proves, bb.js's CRS hosts and
 * Presto. Presto proves over HTTPS only; its HTTP port answers just the SDK's witness-free `/health` diagnostic, which
 * tells a running Presto with HTTPS off from no Presto at all.
 */
export function cspFor(t: BuildTarget): string {
	const origins = [t.manifest.l2.nodeUrl, t.l1RpcUrl].map((u) => new URL(u).origin)
	const presto = [`https://127.0.0.1:${t.presto.httpsPort}`, `http://127.0.0.1:${t.presto.port}`]
	const connect = [...origins, ...(t.proofs === "real" ? [...CRS_ORIGINS, ...presto] : [])]
	return [
		"default-src 'self'",
		"img-src 'self' data:",
		"font-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"worker-src 'self' blob:",
		// bb.js fetches its own wasm from a data: URL.
		`connect-src 'self' data: blob: ${connect.join(" ")}`,
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ")
}

/** bb.js runs threaded wasm, which needs cross-origin isolation. */
export const ISOLATION_HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
} as const

export function servedHeaders(t: BuildTarget): Record<string, string> {
	return {
		...ISOLATION_HEADERS,
		"Content-Security-Policy": cspFor(t),
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Referrer-Policy": "no-referrer",
		"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
	}
}

/** The Workers static-assets `_headers` file: every path gets the served headers. */
export function headersFile(t: BuildTarget): string {
	const lines = Object.entries(servedHeaders(t)).map(([k, v]) => `  ${k}: ${v}`)
	return `/*\n${lines.join("\n")}\n`
}
