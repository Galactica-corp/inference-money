import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import type { TxHash } from "@aztec-labs/aztec.js/tx"
import {
	type BridgeManifest,
	L2_DONE,
	openRequest,
	payRequest,
	sponsoredPayment,
	syncMerchantList,
	transferPrivate,
} from "@galactica-net/inference-money-core"
import type { DemoWallet } from "@/demo/wallet"

export type ProvedAction = "transfer" | "open" | "pay"

/** One tx's simulate-and-prove time: from the call until the node received the tx. */
export interface ProvingSample {
	action: ProvedAction
	ms: number
	txHash: string
}

/** A cent of demo USDC: every timed action moves it from alice to galactica, which the rules allow. */
const AMOUNT = 10_000n

/** Runs `run`, which sends one tx, and times it up to the node's receipt; any wait for the tx's checkpoint is not counted. */
async function timed<T>(d: DemoWallet, action: ProvedAction, run: () => Promise<T>, hashOf: (r: T) => TxHash) {
	const before = d.sentAt.length
	const start = performance.now()
	const result = await run()
	const sentAt = d.sentAt[before]
	if (sentAt === undefined) throw new Error(`The ${action} returned without sending a tx.`)
	const sample: ProvingSample = { action, ms: Math.round(sentAt - start), txHash: hashOf(result).toString() }
	return [sample, result] as const
}

async function listOptions(d: DemoWallet, m: BridgeManifest, token: AztecAddress) {
	return { list: await syncMerchantList(d.node, token), fee: { paymentMethod: sponsoredPayment(m) } }
}

/** alice pays galactica privately; returns once the transfer is checkpointed, so her change is spendable. */
export async function timeTransfer(d: DemoWallet, m: BridgeManifest, token: AztecAddress): Promise<ProvingSample> {
	const { alice, galactica } = d.cast
	const opts = await listOptions(d, m, token)
	const t = { from: alice.address, to: galactica.address, amount: AMOUNT }
	const [sample, txHash] = await timed(
		d,
		"transfer",
		() => transferPrivate(d.wallet, token, t, opts),
		(h) => h,
	)
	await waitForTx(d.node, txHash, L2_DONE)
	return sample
}

/** galactica opens a request only alice can complete, and alice pays it privately; both are checkpointed on return. */
export async function timeOpenAndPay(d: DemoWallet, m: BridgeManifest, token: AztecAddress): Promise<ProvingSample[]> {
	const { alice, galactica } = d.cast
	const opts = await listOptions(d, m, token)
	const intent = { from: galactica.address, to: galactica.address, completer: alice.address }
	const [open, { commitment }] = await timed(
		d,
		"open",
		() => openRequest(d.wallet, d.node, token, intent, opts),
		(r) => r.txHash,
	)
	const p = { from: alice.address, commitment, amount: AMOUNT, kind: "private" } as const
	const payOpts = await listOptions(d, m, token)
	const [pay] = await timed(
		d,
		"pay",
		() => payRequest(d.gate, d.wallet, token, p, payOpts),
		(h) => h,
	)
	return [open, pay]
}
