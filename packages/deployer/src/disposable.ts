import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import type { Writable } from "node:stream"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { parseManifest, randomSecret, signingKeyFor, tokenBridgeArtifact } from "@inference-money/bridge-core"
import { aztecAddressOf } from "@inference-money/demo"
import { REPO_ROOT } from "@inference-money/local-network"
import type { Address } from "viem"
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts"
import { type Command, type Invocation, parseInvocation } from "./cli-args"
import { TESTNET } from "./networks"
import { runRedacted } from "./redact"
import { DISPOSABLE_DIR, keyedWorktree, StateDir, syncDir, withStateDir, writeDurably } from "./run-state"
import { scanFailed, scanForSecrets, scanLine } from "./scan"
import { aztecSecretFrom, KEYED, l1PrivateKeyFrom, scrubbedEnv, secretNeedles } from "./secrets"
import type { ManifestRef } from "./session"
import { layoutSlot, publicReader, type Roles, readRoles } from "./token-reads"

/** The disposable fallback's keys: owner-only, outside every checkout, until `destroy`. */
export const DISPOSABLE_FILE = join(DISPOSABLE_DIR, "testnet.env")
/** Set in a `disposable exec` child alone: an `admin accept` under it records the admin as interim. */
export const INTERIM_ADMIN = "BRIDGE_INTERIM_ADMIN"
const ADMIN_ADDRESS = "TESTNET_ADMIN_ADDRESS"
const CLI = join(import.meta.dir, "cli.ts")

const accountOf = (secret: Fr): Promise<AztecAddress> => aztecAddressOf({ secret, signingKey: signingKeyFor(secret) })

export interface DisposableAddresses {
	l1: Address
	deployer: AztecAddress
	admin: AztecAddress
}

/**
 * Draws an L1 deploy key, an L2 deployer secret and an interim admin secret into `file` (0600, never overwritten) and
 * returns only the addresses they control. The values never leave this process except through that file.
 */
export async function disposableInit(file = DISPOSABLE_FILE): Promise<DisposableAddresses> {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	return withBundle(file, () => drawBundle(file))
}

async function drawBundle(file: string): Promise<DisposableAddresses> {
	const l1Key = generatePrivateKey()
	const [deployerSecret, adminSecret] = [randomSecret(), randomSecret()]
	const admin = await accountOf(adminSecret)
	const lines = [
		`${KEYED.l1PrivateKey}=${l1Key}`,
		`${KEYED.deployerSecret}=${deployerSecret}`,
		`${KEYED.adminSecret}=${adminSecret}`,
		`${ADMIN_ADDRESS}=${admin}`,
	]
	writeDurably(file, `${lines.join("\n")}\n`)
	syncDir(dirname(file))
	return { l1: privateKeyToAddress(l1Key), deployer: await accountOf(deployerSecret), admin }
}

/**
 * Holds `file`'s bundle while `fn` runs: `init`, `exec` and `destroy` exclude each other, so a `destroy` that passed its
 * checks can't delete a bundle drawn after another `destroy` removed the one it checked. For `init` and `destroy` only,
 * which spawn nothing: a signal releases the bundle and exits at once.
 */
const withBundle = <T>(file: string, fn: () => Promise<T>): Promise<T> => withStateDir(".lock", basename(file), fn, dirname(file))

/** Refuses a file another user owns or anyone else can read or write, and a symlink, before reading a byte. */
export function assertOwnerOnly(file: string, uid = process.getuid?.()): void {
	const st = lstatSync(file)
	if (!st.isFile()) throw new Error(`${file} is not a regular file`)
	if (st.uid !== uid) throw new Error(`${file} belongs to another user`)
	if ((st.mode & 0o777) !== 0o600) throw new Error(`${file} must be mode 0600, not ${(st.mode & 0o777).toString(8)}`)
}

function readValues(file: string): Record<string, string> {
	assertOwnerOnly(file)
	const entries = readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const)
	return Object.fromEntries(entries)
}

const AS_ADMIN = [KEYED.adminSecret] as const
/** The disposable values each command sees; any other command sees none. */
const NEEDS: Partial<Record<Command, readonly string[]>> = {
	deploy: [KEYED.l1PrivateKey, KEYED.deployerSecret, ADMIN_ADDRESS],
	"demo fund": [KEYED.l1PrivateKey],
	"admin accept": AS_ADMIN,
	"admin propose": AS_ADMIN,
	pause: AS_ADMIN,
	"merchants add": AS_ADMIN,
	"merchants off": AS_ADMIN,
	"merchants on": AS_ADMIN,
	"merchants delay": AS_ADMIN,
	"merchants guardian": AS_ADMIN,
	"merchants cancel": AS_ADMIN,
}

/** Test seams; the CLI passes none. */
export interface ExecOptions {
	file?: string
	/** The checkout this runs in, which must be the keyed worktree, so later edits can't reach the run. */
	root?: string
	keyedRoot?: string
	argv?: (command: string[]) => string[]
	out?: Writable
	err?: Writable
	scan?: typeof scanForSecrets
}

/**
 * Binds a bundle to one deployment: created exclusively and flushed before its `deploy testnet` starts, then given the
 * bridge's address once that deploy succeeds. Left empty, it marks an attempt that may have created contracts, so a
 * second deploy and `destroy` both refuse until someone establishes what it made.
 */
const deploymentFile = (file: string) => `${file}.deployment`
const recordedBridge = (file: string): string | undefined =>
	existsSync(deploymentFile(file)) ? readFileSync(deploymentFile(file), "utf8").trim() : undefined

const UNRECORDED = "A deploy with these disposable keys never recorded its bridge: establish what it created first."

function bindsDeployment(inv: Invocation, file: string): boolean {
	if (inv.command !== "deploy" || inv.args[0] !== "testnet") return false
	let fd: number
	try {
		fd = openSync(deploymentFile(file), "wx", 0o600)
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
		const prior = recordedBridge(file)
		throw new Error(prior ? `These disposable keys already deployed bridge ${prior}: one deployment per bundle.` : UNRECORDED)
	}
	try {
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	syncDir(dirname(file))
	return true
}

/** Atomic and flushed, so a crash leaves the empty marker or the bridge, never a torn address. */
function recordBridge(file: string, bridge: string): void {
	const tmp = `${deploymentFile(file)}.${process.pid}.tmp`
	rmSync(tmp, { force: true })
	writeDurably(tmp, `${bridge}\n`)
	renameSync(tmp, deploymentFile(file))
	syncDir(dirname(file))
}

function childEnv(inv: Invocation, file: string): NodeJS.ProcessEnv {
	const all = readValues(file)
	const values = Object.fromEntries((NEEDS[inv.command] ?? []).flatMap((name) => (all[name] ? [[name, all[name]]] : [])))
	return { ...scrubbedEnv(), ...values, [KEYED.rpcUrl]: TESTNET.defaultL1RpcUrl, [INTERIM_ADMIN]: "1" }
}

/**
 * Runs one `bridge` command with the disposable values in its environment alone: redacted output, then the secrets
 * scan, which fails the run if any value reached the checkout or the caches. Only from the keyed worktree.
 */
export async function disposableExec(command: string[], opts: ExecOptions = {}): Promise<number> {
	const root = resolve(opts.root ?? REPO_ROOT)
	if (root !== resolve(opts.keyedRoot ?? keyedWorktree())) {
		throw new Error("disposable exec runs from the keyed worktree only: bash scripts/keyed-worktree.sh sync, then run it there")
	}
	const inv = parseInvocation(command)
	if (inv.command.startsWith("disposable")) throw new Error("disposable exec runs a bridge command, not another disposable one")
	const file = opts.file ?? DISPOSABLE_FILE
	// No signal handler here: `runRedacted` owns cancellation, reaping the secret-bearing child before the scan runs and
	// the bundle is released. One that exited first would leave that child running, unlocked.
	const bundle = StateDir.acquire(".lock", basename(file), dirname(file))
	try {
		return await execUnder(inv, command, file, root, opts)
	} finally {
		bundle.release()
	}
}

async function execUnder(inv: Invocation, command: string[], file: string, root: string, opts: ExecOptions): Promise<number> {
	const env = childEnv(inv, file)
	const needles = secretNeedles(env)
	const argv = opts.argv ? opts.argv(command) : [CLI, ...command]
	const binds = bindsDeployment(inv, file)
	const code = await runRedacted(argv, needles, opts.out ?? process.stdout, opts.err ?? process.stderr, env)
	if (binds && code === 0) {
		const m = parseManifest(JSON.parse(readFileSync(join(root, "deployments", "testnet.json"), "utf8")))
		recordBridge(file, m.l2.bridge.address)
	}
	const scan = (opts.scan ?? scanForSecrets)(root, needles)
	if (scanFailed(scan)) {
		;(opts.err ?? process.stderr).write(`secrets:scan after the run: ${scanLine(scan)}\n`)
		return code === 0 ? 1 : code
	}
	return code
}

/** Read at the pinned testnet node, never one a manifest names, with the token the bridge itself is configured with. */
async function finalRoles(ref: ManifestRef): Promise<Roles & { token: Fr }> {
	const node = createAztecNodeClient(TESTNET.nodeUrl)
	const token = await publicReader(node, ref.m.l2.bridge.address, "finalized")(layoutSlot(tokenBridgeArtifact, "config", 1))
	return { ...(await readRoles(node, ref.m, "finalized")), token }
}

function assertRecorded(file: string, ref: ManifestRef): void {
	const recorded = recordedBridge(file)
	if (recorded === ref.m.l2.bridge.address) return
	if (recorded === "") throw new Error(UNRECORDED)
	throw new Error(
		recorded === undefined
			? `These disposable keys recorded no deployment; if they never deployed, delete ${file} by hand.`
			: `These disposable keys deployed bridge ${recorded}; ${ref.path} names another.`,
	)
}

/**
 * Deletes the disposable keys once the deployment they made shows, in reads at the `finalized` tag through the pinned
 * node (separate reads, not necessarily of one block), both roles held by the manifest's admin alone, an account none of
 * the keys control. Absence is no evidence (a finalized block from before
 * the deploy holds no roles at all), and a prune can undo a switch short of finalized; with the keys gone, a role left
 * with them could never move again. Anything less, a failed read or an unrecorded deploy included, keeps the file.
 */
export function disposableDestroy(ref: ManifestRef, opts: { file?: string; roles?: typeof finalRoles } = {}): Promise<void> {
	const file = opts.file ?? DISPOSABLE_FILE
	if (!existsSync(file)) return Promise.resolve()
	return withBundle(file, () => destroyUnder(ref, file, opts.roles ?? finalRoles))
}

async function destroyUnder(ref: ManifestRef, file: string, roles: typeof finalRoles): Promise<void> {
	if (!existsSync(file)) return
	const values = readValues(file)
	assertRecorded(file, ref)
	if (ref.m.l1.deployer.toLowerCase() !== privateKeyToAddress(l1PrivateKeyFrom(values)).toLowerCase()) {
		throw new Error(`${ref.path} is not the deployment the disposable keys made.`)
	}
	const disposable = await Promise.all(
		[KEYED.deployerSecret, KEYED.adminSecret].map(async (name) => (await accountOf(aztecSecretFrom(name, values))).toField()),
	)
	const admin = Fr.fromHexString(ref.m.l2.admin ?? "0x0")
	const r = await roles(ref)
	if (!r.token.equals(Fr.fromHexString(ref.m.l2.token.address))) {
		throw new Error(`Bridge ${ref.m.l2.bridge.address} is configured with token ${r.token}, not ${ref.path}'s.`)
	}
	const alone = r.owner.equals(admin) && r.admin.equals(admin) && r.pendingOwner.isZero() && r.pendingAdmin.isZero()
	if (admin.isZero() || disposable.some((a) => a.equals(admin)) || !alone) {
		throw new Error(
			`As of the last finalized block, the manifest's admin does not hold both roles alone, or is disposable: switch, then let it finalize.`,
		)
	}
	rmSync(file)
	rmSync(deploymentFile(file), { force: true })
	syncDir(dirname(file))
}
