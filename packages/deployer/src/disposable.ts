import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import type { Writable } from "node:stream"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createNodeClient, parseManifest, randomSecret, signingKeyFor, tokenBridgeArtifact } from "@galactica-net/inference-money-core"
import { l1Signer, layoutSlot, publicReader, type Roles, readRoles } from "@galactica-net/inference-money-core/deploy"
import { aztecAddressOf } from "@galactica-net/inference-money-demo"
import { REPO_ROOT } from "@galactica-net/inference-money-local-network"
import { type Address, createPublicClient, erc20Abi, getAddress, type Hex, http, isAddress } from "viem"
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts"
import { type Command, type Invocation, parseInvocation } from "./cli-args"
import { type NetworkPins, networkByName } from "./networks"
import { runRedacted } from "./redact"
import { DISPOSABLE_DIR, keyedWorktree, StateDir, syncDir, withStateDir, writeDurably } from "./run-state"
import { scanFailed, scanForSecrets, scanLine } from "./scan"
import { aztecSecretFrom, type KeyedNames, type KeyedNetwork, keyedFor, l1PrivateKeyFrom, scrubbedEnv, secretNeedles } from "./secrets"
import type { ManifestRef } from "./session"

/** A network's disposable keys: owner-only, outside every checkout, until `destroy`. */
export const disposableFile = (network: KeyedNetwork): string => join(DISPOSABLE_DIR, `${network}.env`)
export const DISPOSABLE_FILE = disposableFile("testnet")
/** Set in a testnet `disposable exec` child alone: an `admin accept` under it records the admin as interim. */
export const INTERIM_ADMIN = "BRIDGE_INTERIM_ADMIN"
/** Where a mainnet bundle's sweep sends what the L1 key holds; public, named by the owner at `init`. */
const REFUND = "DISPOSABLE_REFUND_ADDRESS"
const CLI = join(import.meta.dir, "cli.ts")

const accountOf = (secret: Fr): Promise<AztecAddress> => aztecAddressOf({ secret, signingKey: signingKeyFor(secret) })

export interface DisposableAddresses {
	l1: Address
	deployer: AztecAddress
	/** Testnet: the interim admin the bundle holds. Mainnet: the owner's admin the deploy proposes to. */
	admin: AztecAddress
	/** Mainnet: where `sweep` sends the L1 key's leftovers. */
	refund?: Address
}

export interface InitOptions {
	file?: string
	/** Mainnet: the owner's admin, from its keyed `admin address mainnet`. */
	admin?: string
	/** Mainnet: the owner's L1 address for leftovers. */
	refund?: string
}

/**
 * Draws a bundle into `file` (0600, never overwritten) and returns only the addresses it controls or names. Testnet: an
 * L1 deploy key, an L2 deployer secret and an interim admin secret. Mainnet: the L1 key and the deployer secret only;
 * the deploy proposes straight to the owner's admin and no admin key is ever drawn. The values never leave this process
 * except through that file.
 */
export async function disposableInit(network: KeyedNetwork = "testnet", opts: InitOptions = {}): Promise<DisposableAddresses> {
	const file = opts.file ?? disposableFile(network)
	const draw = network === "mainnet" ? () => drawMainnet(file, opts) : () => drawTestnet(file, opts)
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	return withBundle(file, draw)
}

async function drawTestnet(file: string, opts: InitOptions): Promise<DisposableAddresses> {
	if (opts.admin || opts.refund) throw new Error("a testnet bundle draws its own interim admin and keeps no refund address")
	const names = keyedFor("testnet")
	const l1Key = generatePrivateKey()
	const [deployerSecret, adminSecret] = [randomSecret(), randomSecret()]
	const admin = await accountOf(adminSecret)
	const lines = [
		`${names.l1PrivateKey}=${l1Key}`,
		`${names.deployerSecret}=${deployerSecret}`,
		`${names.adminSecret}=${adminSecret}`,
		`${names.adminAddress}=${admin}`,
	]
	writeBundle(file, lines)
	return { l1: privateKeyToAddress(l1Key), deployer: await accountOf(deployerSecret), admin }
}

async function drawMainnet(file: string, opts: InitOptions): Promise<DisposableAddresses> {
	if (!opts.admin || !/^0x[0-9a-fA-F]{64}$/.test(opts.admin))
		throw new Error("a mainnet bundle needs --admin <the owner's Aztec admin address>")
	if (!opts.refund || !isAddress(opts.refund, { strict: false }))
		throw new Error("a mainnet bundle needs --refund <an L1 address of the owner's>")
	const names = keyedFor("mainnet")
	if (BigInt(opts.admin) >= Fr.MODULUS) throw new Error("--admin is not an Aztec address: it is not a field element")
	const admin = AztecAddress.fromStringUnsafe(opts.admin.toLowerCase())
	const refund = getAddress(opts.refund)
	const l1Key = generatePrivateKey()
	const deployerSecret = randomSecret()
	const deployer = await accountOf(deployerSecret)
	if (deployer.equals(admin)) throw new Error("the admin address is the bundle's own deployer")
	const lines = [
		`${names.l1PrivateKey}=${l1Key}`,
		`${names.deployerSecret}=${deployerSecret}`,
		`${names.adminAddress}=${admin}`,
		`${REFUND}=${refund}`,
	]
	writeBundle(file, lines)
	return { l1: privateKeyToAddress(l1Key), deployer, admin, refund }
}

function writeBundle(file: string, lines: string[]): void {
	writeDurably(file, `${lines.join("\n")}\n`)
	syncDir(dirname(file))
}

/**
 * Holds `file`'s bundle while `fn` runs: `init`, `exec`, `sweep` and `destroy` exclude each other, so a `destroy` that
 * passed its checks can't delete a bundle drawn after another `destroy` removed the one it checked. For `init`, `sweep`
 * and `destroy` only, which spawn nothing: a signal releases the bundle and exits at once.
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

const ADMIN_COMMANDS: readonly Command[] = [
	"admin accept",
	"admin propose",
	"pause",
	"merchants add",
	"merchants off",
	"merchants on",
	"merchants delay",
	"merchants guardian",
	"merchants cancel",
]

/** The disposable values each command sees; any other command sees none. A mainnet bundle holds no admin key. */
function needs(command: Command, names: KeyedNames, network: KeyedNetwork): readonly string[] {
	if (command === "deploy") return [names.l1PrivateKey, names.deployerSecret, names.adminAddress]
	if (network === "mainnet") {
		if (ADMIN_COMMANDS.includes(command))
			throw new Error(`a mainnet bundle holds no admin key: run ${command} as the owner's keyed run`)
		return []
	}
	if (command === "demo fund") return [names.l1PrivateKey]
	return ADMIN_COMMANDS.includes(command) ? [names.adminSecret] : []
}

/** A command that names a live network itself must name the bundle's: no bundle acts on another network. */
function assertSameNetwork(inv: Invocation, network: KeyedNetwork): void {
	const named = inv.command === "deploy" || inv.command === "probe" || inv.command === "admin address" ? inv.args[0] : undefined
	if (named !== undefined && named !== network) throw new Error(`a ${network} bundle does not run \`${inv.command} ${named}\``)
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
 * Binds a bundle to one deployment: created exclusively and flushed before its `deploy` starts, then given the bridge's
 * address once that deploy succeeds. Left empty, it marks an attempt that may have created contracts, so a second
 * deploy and `destroy` both refuse until someone establishes what it made.
 */
const deploymentFile = (file: string) => `${file}.deployment`
const recordedBridge = (file: string): string | undefined =>
	existsSync(deploymentFile(file)) ? readFileSync(deploymentFile(file), "utf8").trim() : undefined

const UNRECORDED = "A deploy with these disposable keys never recorded its bridge: establish what it created first."

function bindsDeployment(inv: Invocation, file: string, network: KeyedNetwork): boolean {
	if (inv.command !== "deploy" || inv.args[0] !== network) return false
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

function childEnv(inv: Invocation, file: string, network: KeyedNetwork): NodeJS.ProcessEnv {
	const names = keyedFor(network)
	const wanted = needs(inv.command, names, network)
	const all = readValues(file)
	const values = Object.fromEntries(wanted.flatMap((name) => (all[name] ? [[name, all[name]]] : [])))
	const interim = network === "testnet" ? { [INTERIM_ADMIN]: "1" } : {}
	return { ...scrubbedEnv(), ...values, [names.rpcUrl]: networkByName(network).defaultL1RpcUrl, ...interim }
}

/**
 * Runs one `bridge` command with the network's disposable values in its environment alone: redacted output, then the
 * secrets scan, which fails the run if any value reached the checkout or the caches. Only from the keyed worktree.
 * `args` is the network, then the command.
 */
export async function disposableExec(args: string[], opts: ExecOptions = {}): Promise<number> {
	const root = resolve(opts.root ?? REPO_ROOT)
	if (root !== resolve(opts.keyedRoot ?? keyedWorktree())) {
		throw new Error("disposable exec runs from the keyed worktree only: bash scripts/keyed-worktree.sh sync, then run it there")
	}
	const [network, ...command] = args as [KeyedNetwork, ...string[]]
	if (network !== "testnet" && network !== "mainnet") throw new Error("disposable exec takes testnet or mainnet first")
	const inv = parseInvocation(command)
	if (inv.command.startsWith("disposable")) throw new Error("disposable exec runs a bridge command, not another disposable one")
	assertSameNetwork(inv, network)
	const file = opts.file ?? disposableFile(network)
	// No signal handler here: `runRedacted` owns cancellation, reaping the secret-bearing child before the scan runs and
	// the bundle is released. One that exited first would leave that child running, unlocked.
	const bundle = StateDir.acquire(".lock", basename(file), dirname(file))
	try {
		return await execUnder({ inv, command, file, root, network }, opts)
	} finally {
		bundle.release()
	}
}

interface ExecRun {
	inv: Invocation
	command: string[]
	file: string
	root: string
	network: KeyedNetwork
}

async function execUnder(run: ExecRun, opts: ExecOptions): Promise<number> {
	const { inv, command, file, root, network } = run
	const env = childEnv(inv, file, network)
	const needles = secretNeedles(env)
	const argv = opts.argv ? opts.argv(command) : [CLI, ...command]
	const binds = bindsDeployment(inv, file, network)
	const code = await runRedacted(argv, needles, opts.out ?? process.stdout, opts.err ?? process.stderr, env)
	if (binds && code === 0) {
		const m = parseManifest(JSON.parse(readFileSync(join(root, "deployments", `${network}.json`), "utf8")))
		recordBridge(file, m.l2.bridge.address)
	}
	const scan = (opts.scan ?? scanForSecrets)(root, needles)
	if (scanFailed(scan)) {
		;(opts.err ?? process.stderr).write(`secrets:scan after the run: ${scanLine(scan)}\n`)
		return code === 0 ? 1 : code
	}
	return code
}

/** Read at the network's pinned node, never one a manifest names, with the token the bridge itself is configured with. */
async function finalRoles(ref: ManifestRef): Promise<Roles & { token: Fr }> {
	const node = createNodeClient(networkByName(ref.m.network).nodeUrl)
	const token = await publicReader(node, ref.m.l2.bridge.address, "finalized")(layoutSlot(tokenBridgeArtifact, "config", 1))
	return { ...(await readRoles(node, ref.m, "finalized")), token }
}

export interface L1Holdings {
	eth: bigint
	feeAsset: bigint
}

/** ETH a swept key may keep: the 21 000-gas transfer's unused fee margin, never worth a key's life. */
export const SWEPT_ETH_DUST = 10n ** 15n

async function l1Holdings(pins: NetworkPins, holder: Address): Promise<L1Holdings> {
	if (!pins.feeAsset) throw new Error(`${pins.name} pins no fee asset to sweep`)
	const l1 = createPublicClient({ transport: http(pins.defaultL1RpcUrl) })
	const [eth, feeAsset] = await Promise.all([
		l1.getBalance({ address: holder }),
		l1.readContract({ address: pins.feeAsset, abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
	])
	return { eth, feeAsset }
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

export interface DestroyOptions {
	file?: string
	roles?: typeof finalRoles
	/** Mainnet: what the L1 key still holds, which must be swept first. */
	holdings?: (holder: Address) => Promise<L1Holdings>
}

/**
 * Deletes the disposable keys once the deployment they made shows, in reads at the `finalized` tag through the pinned
 * node (separate reads, not necessarily of one block), both roles held by the manifest's admin alone, an account none of
 * the keys control. Absence is no evidence (a finalized block from before the deploy holds no roles at all), and a prune
 * can undo a switch short of finalized; with the keys gone, a role left with them could never move again. On mainnet the
 * L1 key must also have been swept: it holds real funds. Anything less, a failed read or an unrecorded deploy included,
 * keeps the file.
 */
export function disposableDestroy(ref: ManifestRef, opts: DestroyOptions = {}): Promise<void> {
	if (ref.m.network === "local") return Promise.reject(new Error("a local deployment has no disposable keys"))
	const network = ref.m.network
	const file = opts.file ?? disposableFile(network)
	if (!existsSync(file)) return Promise.resolve()
	const holdings = opts.holdings ?? ((holder: Address) => l1Holdings(networkByName(network), holder))
	return withBundle(file, () => destroyUnder(ref, file, network, opts.roles ?? finalRoles, holdings))
}

async function destroyUnder(
	ref: ManifestRef,
	file: string,
	network: KeyedNetwork,
	roles: typeof finalRoles,
	holdings: (holder: Address) => Promise<L1Holdings>,
): Promise<void> {
	if (!existsSync(file)) return
	const values = readValues(file)
	const names = keyedFor(network)
	assertRecorded(file, ref)
	const holder = privateKeyToAddress(l1PrivateKeyFrom(values, names))
	if (ref.m.l1.deployer.toLowerCase() !== holder.toLowerCase())
		throw new Error(`${ref.path} is not the deployment the disposable keys made.`)
	const secrets = [names.deployerSecret, names.adminSecret].filter((name) => values[name])
	const disposable = await Promise.all(secrets.map(async (name) => (await accountOf(aztecSecretFrom(name, values))).toField()))
	await assertHandedOver(ref, disposable, roles)
	if (network === "mainnet") await assertSwept(holder, holdings)
	rmSync(file)
	rmSync(deploymentFile(file), { force: true })
	syncDir(dirname(file))
}

async function assertHandedOver(ref: ManifestRef, disposable: Fr[], roles: typeof finalRoles): Promise<void> {
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
}

async function assertSwept(holder: Address, holdings: (holder: Address) => Promise<L1Holdings>): Promise<void> {
	const h = await holdings(holder)
	if (h.feeAsset > 0n || h.eth > SWEPT_ETH_DUST) {
		throw new Error(`The disposable L1 key ${holder} still holds funds: run \`bridge disposable sweep mainnet\` first.`)
	}
}

export interface SweepResult {
	refund: Address
	feeAsset: bigint
	eth: bigint
}

/**
 * Sends everything a mainnet bundle's L1 key holds to the owner's refund address, the fee asset first, then the ETH
 * less the transfer's own fee, in process: the key never reaches a child, argv or output. Its L2 Fee Juice stays on L2.
 */
export function disposableSweep(network: KeyedNetwork, opts: { file?: string } = {}): Promise<SweepResult> {
	if (network !== "mainnet") return Promise.reject(new Error("only a mainnet bundle holds funds worth sweeping"))
	const file = opts.file ?? disposableFile(network)
	return withBundle(file, () => sweepUnder(file, networkByName(network)))
}

async function sweepUnder(file: string, pins: NetworkPins): Promise<SweepResult> {
	const values = readValues(file)
	const refund = values[REFUND]
	if (!refund || !isAddress(refund)) throw new Error(`${file} names no refund address`)
	const key = l1PrivateKeyFrom(values, keyedFor(pins.name)) as Hex
	const l1 = l1Signer(pins.defaultL1RpcUrl, pins.l1ChainId, privateKeyToAccount(key))
	const feeAsset = pins.feeAsset as Address
	const asset = await l1.publicClient.readContract({
		address: feeAsset,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [l1.account.address],
	})
	if (asset > 0n)
		await mined(
			l1,
			await l1.walletClient.writeContract({
				address: feeAsset,
				abi: erc20Abi,
				functionName: "transfer",
				args: [refund, asset],
				account: l1.account,
				chain: l1.chain,
			}),
		)
	const balance = await l1.publicClient.getBalance({ address: l1.account.address })
	const fees = await l1.publicClient.estimateFeesPerGas()
	// Twice the current base fee covers a rise until inclusion; whatever is unspent stays behind as dust.
	const maxFeePerGas = fees.maxFeePerGas * 2n
	const value = balance - 21_000n * maxFeePerGas
	if (value > 0n) {
		const hash = await l1.walletClient.sendTransaction({
			to: refund,
			value,
			gas: 21_000n,
			maxFeePerGas,
			maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
			account: l1.account,
			chain: l1.chain,
		})
		await mined(l1, hash)
	}
	return { refund, feeAsset: asset, eth: value > 0n ? value : 0n }
}

async function mined(l1: ReturnType<typeof l1Signer>, hash: Hex): Promise<void> {
	const receipt = await l1.publicClient.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`sweep tx ${hash} reverted`)
}
