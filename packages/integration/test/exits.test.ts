import { describe, expect, it } from "bun:test"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import { BatchCall, Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { computeL2ToL1MembershipWitness, getL2ToL1MessageLeafId } from "@aztec-labs/stdlib/messaging"
import {
	AlreadyWithdrawnError,
	type ExitIntent,
	type ExitTicket,
	ExitUnconfirmedError,
	exitTicketFromTx,
	exitToL1,
	locateWithdrawal,
	sponsoredPayment,
	tokenArtifact,
	tokenBridgeArtifact,
	waitWithdrawable,
	withdrawOnL1,
} from "@galactica-net/inference-money-core"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { funded, l1Actor, l2Actor, l2Balances, merchantActor, payFor, sentDuring, USDC, usdcOf, withdraw } from "./actors"
import { harness, INTEGRATION, loseNextReply } from "./harness"

const exit = (e: ExitIntent) => exitToL1(e, harness().wallet, harness().sends, harness().manifest, { fee: payFor(e.kind) })

const provenQuickly = { pollMs: 2_000, timeoutMs: 15 * 60_000 }

/** Reads the L1 Outbox for the ticket's leaf; the epoch must be proven. */
async function consumedOnL1(t: ExitTicket): Promise<boolean> {
	const { node, outbox } = harness()
	const w = await computeL2ToL1MembershipWitness(node, outbox, Fr.fromHexString(t.messageHash), t.l2TxHash, t.messageIndexInTx)
	if (!w) throw new Error("the exit's epoch is not proven")
	return outbox.isConsumed(BigInt(w.epochNumber), getL2ToL1MessageLeafId(w))
}

const resume = (hash: TxHash, recipient: `0x${string}`, amount: bigint) =>
	exitTicketFromTx(hash, recipient, amount, harness().node, harness().outbox, harness().manifest)

describe.skipIf(!INTEGRATION)("exits and withdrawals", () => {
	it("[A4] a merchant's public exit → proven → L1 withdraw: the Outbox reads unconsumed before and consumed after", async () => {
		const { manifest: m, node, outbox } = harness()
		const [l1, shop] = await Promise.all([l1Actor(), merchantActor()])
		await funded(l1, "public", shop, 10n * USDC)
		const t = await exit({ kind: "public", from: shop, recipientL1: l1.account, amount: 6n * USDC })
		expect((await l2Balances(shop)).public).toBe(4n * USDC)
		const proof = await waitWithdrawable(t, node, outbox, undefined, provenQuickly)
		expect(await consumedOnL1(t)).toBe(false)
		const before = await usdcOf(l1.account)
		await withdrawOnL1(t, proof, l1, m)
		expect(await usdcOf(l1.account)).toBe(before + 6n * USDC)
		expect(await consumedOnL1(t)).toBe(true)
	})

	it("[A5][A15] private exit, paid by the sponsor (the submitted tx names it), then withdrawn", async () => {
		const { manifest: m } = harness()
		const [l1, bob] = await Promise.all([l1Actor(), l2Actor()])
		await funded(l1, "private", bob, 5n * USDC)
		let t: ExitTicket | undefined
		const txs = await sentDuring(async () => {
			t = await exit({ kind: "private", from: bob, recipientL1: l1.account, amount: 5n * USDC })
		})
		if (!t) throw new Error("no exit ticket")
		expect(txs).toMatchObject([{ hash: t.l2TxHash.toString(), feePayer: m.l2.sponsoredFpc as string }])
		expect((await l2Balances(bob)).private).toBe(0n)
		const before = await usdcOf(l1.account)
		await withdraw(t, l1)
		expect(await usdcOf(l1.account)).toBe(before + 5n * USDC)
	})

	it("[A14] with app memory gone, a merchant's private exit to another recipient resumes from (tx hash, recipient, amount)", async () => {
		const [l1, shop] = await Promise.all([l1Actor(), merchantActor()])
		await funded(l1, "private", shop, 3n * USDC)
		const recipient = privateKeyToAccount(generatePrivateKey()).address
		const t = await exit({ kind: "private", from: shop, recipientL1: recipient, amount: 3n * USDC, asMerchant: true })
		const remembered = JSON.stringify({ tx: t.l2TxHash.toString(), recipient, amount: String(3n * USDC) })

		const r = JSON.parse(remembered) as { tx: string; recipient: `0x${string}`; amount: string }
		const resumed = await resume(TxHash.fromString(r.tx), r.recipient, BigInt(r.amount))
		expect(resumed).toEqual(t)
		if (typeof resumed === "string") throw new Error(resumed)
		await withdraw(resumed, l1)
		expect(await usdcOf(recipient)).toBe(3n * USDC)
	})

	it("[A14] an exit the node took before its reply was lost is unconfirmed, with the real tx's hash to resume from", async () => {
		const { manifest: m, node } = harness()
		const [l1, bob, shop] = await Promise.all([l1Actor(), l2Actor(), merchantActor()])
		await funded(l1, "private", bob, USDC)
		await funded(l1, "public", shop, USDC)
		for (const e of [
			{ kind: "private", from: bob, recipientL1: l1.account, amount: USDC },
			{ kind: "public", from: shop, recipientL1: l1.account, amount: USDC },
		] as const) {
			loseNextReply()
			const err = await exit(e).catch((x: unknown) => x)
			expect(err, e.kind).toBeInstanceOf(ExitUnconfirmedError)
			const sent = (err as ExitUnconfirmedError).sent ?? []
			expect(sent, e.kind).toHaveLength(1)
			const resumed = await locateWithdrawal(l1.account, USDC, sent[0]!.txHash, node, m)
			expect(resumed, e.kind).toMatchObject({ l2TxHash: sent[0]!.txHash, recipient: l1.account, amount: USDC })
		}
	})

	it("[A13] replaying a completed L1 withdraw is refused as already withdrawn and pays nothing", async () => {
		const { manifest: m, node, outbox } = harness()
		const [l1, shop] = await Promise.all([l1Actor(), merchantActor()])
		await funded(l1, "public", shop, 2n * USDC)
		const t = await exit({ kind: "public", from: shop, recipientL1: l1.account, amount: 2n * USDC })
		const proof = await waitWithdrawable(t, node, outbox, undefined, provenQuickly)
		await withdrawOnL1(t, proof, l1, m)
		const after = await usdcOf(l1.account)
		await expect(withdrawOnL1(t, proof, l1, m)).rejects.toBeInstanceOf(AlreadyWithdrawnError)
		expect(await usdcOf(l1.account)).toBe(after)
		expect(await resume(t.l2TxHash, l1.account, 2n * USDC)).toBe("all-consumed")
	})

	it("[A13] two identical exits in one tx are withdrawn one at a time from the tx alone, then all-consumed", async () => {
		const { manifest: m, wallet } = harness()
		const [l1, bob] = await Promise.all([l1Actor(), merchantActor()])
		await funded(l1, "public", bob, 4n * USDC)
		const proxy = AztecAddress.fromStringUnsafe(m.l2.proxy.address)
		const token = Contract.at(AztecAddress.fromStringUnsafe(m.l2.token.address), tokenArtifact, wallet)
		const bridge = Contract.at(AztecAddress.fromStringUnsafe(m.l2.bridge.address), tokenBridgeArtifact, wallet)
		const calls = []
		for (let i = 0; i < 2; i++) {
			const nonce = Fr.random()
			const burn = token.methods.burn_public!(bob, 2n * USDC, nonce)
			calls.push(await SetPublicAuthwitContractInteraction.create(wallet, bob, { caller: proxy, action: burn }, true))
			calls.push(bridge.methods.exit_to_l1_public!(EthAddress.fromString(l1.account), 2n * USDC, EthAddress.ZERO, nonce))
		}
		const { receipt } = await new BatchCall(wallet, calls).send({ from: bob, fee: { paymentMethod: sponsoredPayment(m) } })
		const before = await usdcOf(l1.account)

		const first = await resume(receipt.txHash, l1.account, 2n * USDC)
		if (typeof first === "string") throw new Error(first)
		await withdraw(first, l1)
		const second = await resume(receipt.txHash, l1.account, 2n * USDC)
		if (typeof second === "string") throw new Error(second)
		expect(second.messageIndexInTx).not.toBe(first.messageIndexInTx)
		await withdraw(second, l1)
		expect(await resume(receipt.txHash, l1.account, 2n * USDC)).toBe("all-consumed")
		expect(await usdcOf(l1.account)).toBe(before + 4n * USDC)
	})
})
