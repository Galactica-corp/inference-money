import { beforeAll, describe, expect, it } from "bun:test"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { NO_WAIT } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { AztecNode } from "@aztec-labs/stdlib/interfaces/client"
import { L2ToL1Message, ScopedL2ToL1Message } from "@aztec-labs/stdlib/messaging"
import type { Tx } from "@aztec-labs/stdlib/tx"
import { getAddress, zeroAddress } from "viem"
import { ExitDestinationError } from "./binding"
import { L2_PROPOSED, SponsorUnavailableError } from "./claim"
import { withdrawContentHash } from "./content-hash"
import {
	type ExitIntent,
	type ExitNode,
	ExitRevertedError,
	ExitUnconfirmedError,
	exitTicketFromTx,
	exitToL1,
	expectedExitMessage,
	isExitWithdrawn,
} from "./exit"
import type { BridgeManifest } from "./manifest"
import { SendJournal } from "./sent"
import { fakeEpoch } from "./test/fake-epoch"
import { fakeWallet, type SentTx as Payload } from "./test/fake-wallet"
import { a, MANIFEST as M, receiptAt } from "./test/fixtures"

const RECIPIENT = getAddress(a(0xe1))
const AMOUNT = 7_000_000n
let from: AztecAddress
let message: Fr
let content: Fr

beforeAll(async () => {
	from = await AztecAddress.random()
	message = await expectedExitMessage(RECIPIENT, AMOUNT, M)
	content = Fr.fromHexString(await withdrawContentHash(RECIPIENT, AMOUNT, zeroAddress))
})

type JournaledNode = ExitNode & Pick<AztecNode, "sendTx">

/** A journal over `node`, whose `sendTx` accepts every tx unless `node` brings its own. */
const journalOver = (node: ExitNode | JournaledNode) => new SendJournal<JournaledNode>({ sendTx: async () => {}, ...node })

/** Exits with `wallet` bound to a journal over `node`. */
async function exitVia(e: ExitIntent, wallet: Wallet, node: ExitNode, m: BridgeManifest, opts?: Parameters<typeof exitToL1>[4]) {
	const sends = journalOver(node)
	return exitToL1(e, await sends.bindWallet(async () => wallet), sends, m, opts)
}

/** A wallet whose account is bound to RECIPIENT, the funding address every user exit here goes to. */
const boundWallet = (hooks: Parameters<typeof fakeWallet>[0] = {}) => fakeWallet({ utility: () => [new Fr(BigInt(RECIPIENT))], ...hooks })
const intent = (o: Partial<ExitIntent> = {}): ExitIntent => ({ kind: "private", from, recipientL1: RECIPIENT, amount: AMOUNT, ...o })
const CHECKPOINTED = receiptAt(TxStatus.CHECKPOINTED)
const REVERTED = { ...CHECKPOINTED, executionResult: "reverted", hasExecutionSucceeded: () => false, hasExecutionReverted: () => true }
const effectNode = (l2ToL1Msgs: Fr[], receipt: () => Promise<unknown> = async () => CHECKPOINTED) =>
	({ getTxEffect: async () => ({ data: { l2ToL1Msgs } }), getTxReceipt: receipt }) as unknown as ExitNode

describe("exitToL1", () => {
	it.each([
		["zero", zeroAddress],
		["portal", M.l1.portal],
		["router", M.l1.router],
	])("refuses a %s recipient before any wallet call", async (_, recipientL1) => {
		const w = boundWallet()
		await expect(exitVia(intent({ recipientL1 }), w.wallet, effectNode([message]), M)).rejects.toThrow(/could never be paid out/)
		expect(w.sent.length + w.authWits.length).toBe(0)
	})

	it("burns privately through the proxy with a sponsored witness exit, and locates its message among several", async () => {
		const w = boundWallet()
		const t = await exitVia(intent(), w.wallet, effectNode([new Fr(1), message]), M)
		expect(w.authWits).toEqual([{ from: from.toString(), caller: M.l2.proxy.address }])
		expect(w.sent[0]).toMatchObject({
			calls: ["sponsor_unconditionally", "exit_to_l1_private"],
			feePayer: M.l2.sponsoredFpc,
			authWitnesses: 1,
			wait: NO_WAIT,
		})
		expect(w.sent[0]?.args[1]?.at(-1)).toBe(0n)
		expect(t).toMatchObject({
			l2TxHash: w.txHash,
			recipient: RECIPIENT,
			amount: AMOUNT,
			messageHash: message.toString(),
			messageIndexInTx: 1,
		})
	})

	it("flags a merchant's private exit, which the bridge then checks against the merchant list", async () => {
		const w = boundWallet()
		await exitVia(intent({ asMerchant: true }), w.wallet, effectNode([message]), M)
		expect(w.sent[0]?.args[1]?.at(-1)).toBe(1n)
	})

	it("refuses a user's private exit anywhere but its funding address before any witness or burn", async () => {
		for (const w of [fakeWallet(), fakeWallet({ utility: () => [new Fr(0xbeefn)] })]) {
			await expect(exitVia(intent(), w.wallet, effectNode([message]), M)).rejects.toBeInstanceOf(ExitDestinationError)
			expect(w.sent.length + w.authWits.length).toBe(0)
		}
		const merchant = fakeWallet()
		await exitVia(intent({ asMerchant: true }), merchant.wallet, effectNode([message]), M)
		expect(merchant.sent).toHaveLength(1)
	})

	it("authorizes a public burn in the same batch as the exit, paid by the wallet unless sponsorship is chosen", async () => {
		const w = boundWallet()
		await exitVia(intent({ kind: "public" }), w.wallet, effectNode([message]), M)
		expect(w.authWits).toHaveLength(0)
		expect(w.sent[0]).toMatchObject({ calls: ["set_authorized", "exit_to_l1_public"], feePayer: undefined })
		const sponsored = boundWallet()
		await exitVia(intent({ kind: "public" }), sponsored.wallet, effectNode([message]), M, { fee: "sponsored" })
		expect(sponsored.sent[0]).toMatchObject({ feePayer: M.l2.sponsoredFpc })
	})

	it("surfaces a sponsor that cannot pay before the tx is handed to the node as SponsorUnavailableError, with nothing burned", async () => {
		const w = boundWallet({
			send: () => {
				throw new Error("Not enough balance for fee payer to pay for transaction")
			},
		})
		await expect(exitVia(intent(), w.wallet, effectNode([message]), M)).rejects.toBeInstanceOf(SponsorUnavailableError)
		const unsponsored = boundWallet({
			send: () => {
				throw new Error("Not enough balance for fee payer to pay for transaction")
			},
		})
		await expect(exitVia(intent({ kind: "public" }), unsponsored.wallet, effectNode([message]), M)).rejects.not.toBeInstanceOf(
			SponsorUnavailableError,
		)
	})

	describe("once the tx is handed to the node", () => {
		const EARLY = 1_700_000_000n
		const LATE = 1_800_000_000n
		const bridge = AztecAddress.fromStringUnsafe(M.l2.bridge.address)
		/** The tx a wallet hands its node for `p`: a private exit's withdraw message, or a public exit's call. */
		const handed = (p: Payload, expiresAt: bigint) => {
			const hash = TxHash.random()
			const i = p.calls.indexOf("exit_to_l1_public")
			const calls = i < 0 ? [] : [{ request: { contractAddress: bridge }, calldata: [Fr.ZERO, ...p.args[i]!.map((v) => new Fr(v))] }]
			const msgs = i < 0 ? [new ScopedL2ToL1Message(new L2ToL1Message(EthAddress.fromString(M.l1.portal), content), bridge)] : []
			const data = { expirationTimestamp: expiresAt, getNonEmptyL2ToL1Msgs: () => msgs }
			return { getTxHash: () => hash, data, getPublicCallRequestsWithCalldata: () => calls } as unknown as Tx
		}
		/** A bound wallet whose send hands its node what `send` builds, as a real wallet does after proving. */
		async function sending(
			nodeSendTx: (tx: Tx) => Promise<void>,
			send: (sends: SendJournal<JournaledNode>, p: Payload) => Promise<void>,
		) {
			const sends = journalOver({ ...effectNode([message]), sendTx: nodeSendTx })
			const w = boundWallet({ send: (p) => send(sends, p) })
			return { sends, w: { ...w, wallet: await sends.bindWallet(async () => w.wallet) } }
		}
		const unconfirmed = async (e: ExitIntent, s: { sends: SendJournal<JournaledNode>; w: { wallet: Wallet } }) => {
			const err = await exitToL1(e, s.w.wallet, s.sends, M, { fee: "sponsored" }).catch((x: unknown) => x)
			expect(err).toBeInstanceOf(ExitUnconfirmedError)
			return err as ExitUnconfirmedError
		}

		it.each([
			["private", "Invalid tx: Insufficient fee payer balance", /fee rejection this client cannot verify/],
			["public", "Invalid tx: Insufficient fee payer balance", /fee rejection this client cannot verify/],
			["private", "fetch failed", /gave no confirmation/],
		] as const)("a %s exit answered %s is unconfirmed, with its hash and expiry", async (kind, reply, said) => {
			const s = await sending(
				async () => {
					throw new Error(reply)
				},
				(sends, p) => sends.node.sendTx(handed(p, LATE)),
			)
			const err = await unconfirmed(intent({ kind }), s)
			expect(err.sent).toHaveLength(1)
			expect(err).toMatchObject({ l2TxHash: err.sent![0]!.txHash, recipient: RECIPIENT, amount: AMOUNT })
			expect(err.message).toMatch(said)
			expect(err.message).toContain(new Date(Number(LATE) * 1000).toISOString())
		})

		it("keeps every identical exit handed to the node, each with its own expiry", async () => {
			const s = await sending(
				async (tx) => {
					if (tx.data.expirationTimestamp === LATE) throw new Error("socket hang up")
				},
				async (sends, p) => {
					await sends.node.sendTx(handed(p, EARLY))
					await sends.node.sendTx(handed(p, LATE))
				},
			)
			const err = await unconfirmed(intent(), s)
			expect(err.sent?.map((h) => h.expiresAt)).toEqual([EARLY, LATE])
			expect(err.message).toContain(new Date(Number(LATE) * 1000).toISOString())
		})

		it("takes no unrelated tx sent meanwhile for an exit that failed before reaching the node", async () => {
			const unrelated = {
				getTxHash: () => TxHash.random(),
				data: { getNonEmptyL2ToL1Msgs: () => [] },
				getPublicCallRequestsWithCalldata: () => [],
			}
			const s = await sending(
				async () => {},
				async (sends) => {
					await sends.node.sendTx(unrelated as unknown as Tx)
					throw new Error("Not enough balance for fee payer to pay for transaction")
				},
			)
			await expect(exitToL1(intent(), s.w.wallet, s.sends, M)).rejects.toBeInstanceOf(SponsorUnavailableError)
		})
	})

	it("refuses a wallet not built on its journal before any witness or send", async () => {
		const w = boundWallet()
		await expect(exitToL1(intent(), w.wallet, journalOver(effectNode([message])), M)).rejects.toThrow(/SendJournal.bindWallet/)
		expect(w.sent.length + w.authWits.length).toBe(0)
	})

	it.each([
		["no matching messages", () => effectNode([new Fr(1)]), /without exactly one matching/],
		["two matching messages", () => effectNode([message, message]), /without exactly one matching/],
		[
			"a node read that fails",
			() => ({ getTxReceipt: async () => CHECKPOINTED, getTxEffect: () => Promise.reject(new Error("503")) }) as unknown as ExitNode,
			/503/,
		],
		["a checkpoint wait that fails", () => effectNode([message], () => Promise.reject(new Error("receipt 503"))), /receipt 503/],
	])("after the burn, %s still yields its hash for recovery", async (_, node, cause) => {
		const w = boundWallet()
		const err = await exitVia(intent(), w.wallet, node(), M).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(ExitUnconfirmedError)
		expect(err).toMatchObject({ l2TxHash: w.txHash, recipient: RECIPIENT, amount: AMOUNT })
		expect(((err as Error).cause as Error).message).toMatch(cause)
	})

	it("reads a revert whose effect carries no withdraw message as nothing burned, final only in a finalized block", async () => {
		const revertedAt = (receipt: unknown) =>
			exitVia(
				intent(),
				boundWallet().wallet,
				effectNode([], async () => receipt),
				M,
			)
		const err = await revertedAt(REVERTED).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(ExitRevertedError)
		// A prune can re-include a tx its checkpoint reverted, which may then burn: no retry advice until it is final.
		expect(err).toMatchObject({ final: false, message: expect.stringMatching(/keep this hash/) })
		const settled = await revertedAt({ ...REVERTED, status: TxStatus.FINALIZED }).catch((e: unknown) => e)
		expect(settled).toMatchObject({ name: "ExitRevertedError", final: true, message: expect.stringMatching(/nothing was burned/) })

		const noEffect = { getTxEffect: async () => undefined, getTxReceipt: async () => REVERTED } as unknown as ExitNode
		const unread = await exitVia(intent(), boundWallet().wallet, noEffect, M).catch((e: unknown) => e)
		expect(unread, "a revert without a readable effect proves nothing").toBeInstanceOf(ExitUnconfirmedError)
	})

	it("with L2_PROPOSED, locates a burn at the proposed block, and reports a revert only once a checkpoint shows it", async () => {
		const PROPOSED_REVERT = { ...REVERTED, status: TxStatus.PROPOSED }
		const receipts =
			(...queue: unknown[]) =>
			async () =>
				queue.shift()
		const exit = (node: ExitNode) => exitVia(intent(), boundWallet().wallet, node, M, { wait: L2_PROPOSED })
		expect((await exit(effectNode([message], receipts(receiptAt(TxStatus.PROPOSED))))).messageIndexInTx).toBe(0)
		// A prune can re-include a burn its proposed block reverted, so forgetting it waits for a checkpointed revert.
		expect((await exit(effectNode([message], receipts(PROPOSED_REVERT, CHECKPOINTED)))).messageIndexInTx).toBe(0)
		const reverted = await exit(effectNode([], receipts(PROPOSED_REVERT, REVERTED))).catch((err: unknown) => err)
		expect(reverted).toBeInstanceOf(ExitRevertedError)
	})
})

describe("exitTicketFromTx", () => {
	it("takes the first unconsumed of identical occurrences, and reports when all are consumed", async () => {
		const e = fakeEpoch([message, message])
		e.state.consumed.add(0)
		expect(await exitTicketFromTx(e.txHash, RECIPIENT, AMOUNT, e.node, e.outbox, M)).toMatchObject({ messageIndexInTx: 1 })
		e.state.consumed.add(1)
		expect(await exitTicketFromTx(e.txHash, RECIPIENT, AMOUNT, e.node, e.outbox, M)).toBe("all-consumed")
	})

	it("never mistakes a different recipient, amount or occurrence for this exit", async () => {
		const e = fakeEpoch([message])
		expect(await exitTicketFromTx(e.txHash, RECIPIENT, AMOUNT + 1n, e.node, e.outbox, M)).toBe("not-found")
		expect(await exitTicketFromTx(e.txHash, getAddress(a(0xe2)), AMOUNT, e.node, e.outbox, M)).toBe("not-found")
		expect(await exitTicketFromTx(e.txHash, RECIPIENT, AMOUNT, e.node, e.outbox, M, 1)).toBe("not-found")
		expect(await exitTicketFromTx(e.txHash, RECIPIENT, AMOUNT, e.node, e.outbox, M, 0)).toMatchObject({ messageIndexInTx: 0 })
	})

	it("treats an unproven epoch as not consumed", async () => {
		const e = fakeEpoch([message])
		e.state.outboxRoot = ["unproven"]
		expect(await exitTicketFromTx(e.txHash, RECIPIENT, AMOUNT, e.node, e.outbox, M)).toMatchObject({ messageIndexInTx: 0 })
	})
})

describe("isExitWithdrawn", () => {
	it("reads one occurrence's consumed bit, and false while its epoch is unproven", async () => {
		const e = fakeEpoch([message, message])
		const t = await exitTicketFromTx(e.txHash, RECIPIENT, AMOUNT, e.node, e.outbox, M, 1)
		if (typeof t === "string") throw new Error(t)
		e.state.consumed.add(0)
		expect(await isExitWithdrawn(t, e.node, e.outbox)).toBe(false)
		e.state.consumed.add(1)
		expect(await isExitWithdrawn(t, e.node, e.outbox)).toBe(true)
		e.state.outboxRoot = ["unproven"]
		expect(await isExitWithdrawn(t, e.node, e.outbox)).toBe(false)
	})
})
