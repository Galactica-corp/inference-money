import { basename, dirname, resolve } from "node:path"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import {
	type BridgeManifest,
	memoryPaymentStore,
	PaymentGate,
	type PaymentStore,
	registerBridgeContracts,
	registerSponsor,
	SendJournal,
	signingKeyFor,
} from "@galactica-net/inference-money-core"
import { resolveEndpoints, runIdFor } from "@galactica-net/inference-money-local-network"
import { localManifestPath, readManifest } from "./manifest"
import { TESTNET } from "./networks"
import { aztecSecretFrom, KEYED, keyedEnv } from "./secrets"
import { recordingNode, type SentTx, withBridgeWallet } from "./wallet"

/** Fixed and public, like anvil's keys: a local deploy hands both admin roles to it, so the handover runs every time. */
export const LOCAL_ADMIN_SECRET = new Fr(0xad3170ca1n)

export interface ManifestRef {
	path: string
	m: BridgeManifest
}

/** `local` is this RUN_ID's run; anything else is a path. */
export function loadManifest(arg: string): ManifestRef {
	const path = arg === "local" ? localManifestPath(runIdFor()) : resolve(arg)
	return { path, m: readManifest(path) }
}

export interface Endpoints {
	nodeUrl: string
	l1RpcUrl: string
}

export interface EndpointFlags {
	node?: string
	l1Rpc?: string
}

/**
 * Where a command reads and sends. A local manifest sits in its run's directory, whose handle names the run's anvil, so
 * any checkout reaches it. Testnet reads Sepolia through SEPOLIA_RPC_URL when a keyed run supplies one, else the pinned
 * public endpoint. `--node` and `--l1-rpc` override both: `verify` trusts what it reads through.
 */
export function endpointsFor(ref: ManifestRef, flags: EndpointFlags = {}): Endpoints {
	const nodeUrl = flags.node ?? ref.m.l2.nodeUrl
	if (flags.l1Rpc) return { nodeUrl, l1RpcUrl: flags.l1Rpc }
	if (ref.m.network === "testnet") return { nodeUrl, l1RpcUrl: keyedEnv()[KEYED.rpcUrl] || TESTNET.defaultL1RpcUrl }
	return { nodeUrl, l1RpcUrl: resolveEndpoints(basename(dirname(ref.path))).anvilUrl }
}

/** Testnet always proves; local only under BRIDGE_PROVE=1, so a keyed worktree's install is proven before any secret. */
export const provesFor = (m: BridgeManifest): boolean => m.network === "testnet" || process.env.BRIDGE_PROVE === "1"

/** The admin's secret: the fixed public one on local, the keyed run's on testnet. */
export const adminSecretFor = (m: BridgeManifest): Fr => (m.network === "local" ? LOCAL_ADMIN_SECRET : aztecSecretFrom(KEYED.adminSecret))

export interface Session {
	ref: ManifestRef
	m: BridgeManifest
	/** The node, read directly; the wallet sends through the gate's. */
	node: AztecNode
	wallet: EmbeddedWallet
	endpoints: Endpoints
	/** Every tx the wallet sent, in order. */
	sent: SentTx[]
	/** The wallet is bound to it, so `payRequest` accepts the wallet. */
	gate: PaymentGate
	/** Under the gate's node; the wallet is bound to it too, so `exitToL1` accepts the wallet. */
	sends: SendJournal
}

export interface SessionOptions extends EndpointFlags {
	/** Payment records (default: in memory, for this process only). */
	payments?: PaymentStore
	/** Runs as each tx goes to the node, after proving. */
	onSend?: (tx: SentTx) => void
}

/** A wallet on the manifest's network with the sponsor and the bridge's contracts registered. */
export function withSession<T>(ref: ManifestRef, opts: SessionOptions, fn: (s: Session) => Promise<T>): Promise<T> {
	const endpoints = endpointsFor(ref, opts)
	const sent: SentTx[] = []
	let bound: { gate: PaymentGate; sends: SendJournal } | undefined
	const bind = (node: AztecNode, open: (n: AztecNode) => Promise<EmbeddedWallet>) => {
		const sends = new SendJournal(recordingNode(node, sent, opts.onSend))
		const gate = new PaymentGate(sends.node, opts.payments ?? memoryPaymentStore())
		bound = { gate, sends }
		return gate.bindWallet((gated) => sends.bindWallet(() => open(gated)))
	}
	return withBridgeWallet(endpoints.nodeUrl, { prove: provesFor(ref.m), bind }, async (wallet, node) => {
		if (!bound) throw new Error("the session's wallet was opened without its payment gate")
		await registerSponsor(wallet, ref.m)
		await registerBridgeContracts(wallet, ref.m)
		return fn({ ref, m: ref.m, node, wallet, endpoints, sent, ...bound })
	})
}

/** Registers the account `secret` rebuilds (salt 0, `signingKeyFor`) in `wallet` and returns its address. */
export async function accountFor(wallet: EmbeddedWallet, secret: Fr): Promise<AztecAddress> {
	return (await wallet.createSchnorrAccount(secret, Fr.ZERO, signingKeyFor(secret))).address
}

/** The admin account, refused unless it is the one the manifest records. */
export async function adminAccount(s: Session): Promise<AztecAddress> {
	if (!s.m.l2.admin) throw new Error("This deployment's handover is not accepted yet: run `bridge admin accept` first.")
	const admin = await accountFor(s.wallet, adminSecretFor(s.m))
	if (admin.toString() !== s.m.l2.admin) throw new Error(`The admin key is ${admin}, but this deployment's admin is ${s.m.l2.admin}.`)
	return admin
}
