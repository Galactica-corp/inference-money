import { beforeAll, describe, expect, it } from "bun:test"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import {
	consolidate,
	newPaymentRef,
	type PaymentProof,
	PaymentRefusedError,
	payPrivate,
	receivePayment,
	refPaidOnChain,
	TOKEN_REFUSALS,
} from "@galactica-net/inference-money-core"
import { funded, l1Actor, l2Actor, l2Balances, merchantActor, sentDuring, USDC } from "./actors"
import { harness, INTEGRATION } from "./harness"
import { as, merchantList, sponsored, token, tokenAddress } from "./token"

const AMOUNT = USDC / 10n

async function pay(from: AztecAddress, to: AztecAddress, paymentRef: Fr, amount = AMOUNT): Promise<PaymentProof> {
	const { gate, wallet } = harness()
	return payPrivate(gate, wallet, tokenAddress(), { from, to, amount, paymentRef }, { list: await merchantList(), fee: sponsored() })
}

const receive = (merchant: AztecAddress, proof: PaymentProof, paymentRef: Fr, price = AMOUNT) =>
	receivePayment(harness().wallet, harness().node, tokenAddress(), merchant, proof, { paymentRef, price })

describe.skipIf(!INTEGRATION)("[A32] payments under a reference, delivered offchain", () => {
	let alice: AztecAddress
	let bob: AztecAddress
	let m1: AztecAddress
	let m2: AztecAddress

	beforeAll(async () => {
		const l1 = await l1Actor()
		;[alice, bob, m1, m2] = await Promise.all([l2Actor(), l2Actor(), merchantActor(), merchantActor()])
		await funded(l1, "private", alice, USDC)
	}, 900_000)

	it("the merchant's balance moves only once it takes in the payer's proof, which names the reference and the amount", async () => {
		const ref = newPaymentRef()
		const before = (await l2Balances(m1)).private
		const proof = await pay(alice, m1, ref)
		expect((await l2Balances(m1)).private).toBe(before)

		const got = await receive(m1, proof, ref)
		expect(got.amount).toBe(AMOUNT)
		expect<string>(got.txHash.toString()).toBe(proof.txHash)
		expect((await l2Balances(m1)).private).toBe(before + AMOUNT)
		// Taking the same proof in again counts the payment once.
		await receive(m1, proof, ref)
		expect((await l2Balances(m1)).private).toBe(before + AMOUNT)
	}, 900_000)

	it("nothing the payment publishes carries the amount: no public log, and no private log for the merchant", async () => {
		const ref = newPaymentRef()
		const proof = await pay(alice, m1, ref)
		const effect = (await harness().node.getTxEffect(TxHash.fromString(proof.txHash)))?.data
		if (!effect) throw new Error("the payment's effect is missing")
		expect(effect.publicLogs).toEqual([])
		// The payer's change is the only private log; the merchant's note and event went offchain.
		expect(effect.privateLogs).toHaveLength(1)
		const amount = new Fr(AMOUNT)
		expect(effect.privateLogs.some((log) => log.fields.some((f) => f.equals(amount)))).toBe(false)
		expect(await refPaidOnChain(harness().node, tokenAddress(), m1, ref)).toBe(true)
		await receive(m1, proof, ref)
	}, 900_000)

	it("a merchant refuses a proof for another reference, an underpayment, another merchant's proof and an altered message", async () => {
		const ref = newPaymentRef()
		const proof = await pay(alice, m1, ref)
		await expect(receive(m1, proof, newPaymentRef())).rejects.toMatchObject({ reason: "malformed" })
		await expect(receive(m2, proof, ref)).rejects.toMatchObject({ reason: "foreign" })
		const altered: PaymentProof = {
			...proof,
			messages: proof.messages.map((m) => ({
				...m,
				ciphertext: m.ciphertext.map((f, i) => (i === 2 ? new Fr(Fr.fromHexString(f).toBigInt() + 1n).toString() : f)),
			})),
		}
		await expect(receive(m1, altered, ref)).rejects.toMatchObject({ reason: "no-payment" })
		await expect(receive(m1, proof, ref, AMOUNT + 1n)).rejects.toMatchObject({ reason: "underpaid" })
	}, 900_000)

	it("a reference takes one payment per merchant: the gate refuses it before proving, the token on chain", async () => {
		const ref = newPaymentRef()
		const proof = await pay(alice, m1, ref)
		await receive(m1, proof, ref)
		const resent = await sentDuring(async () => {
			await expect(pay(alice, m1, ref)).rejects.toBeInstanceOf(PaymentRefusedError)
		})
		expect(resent).toEqual([])
		const direct = token().methods.pay_private!(alice, m1, AMOUNT, ref, 0)
		await expect(direct.simulate({ from: alice })).rejects.toThrow("Payment refused: the reference is already paid")
		// Another merchant's reference space is its own.
		await receive(m2, await pay(alice, m2, ref), ref)
	}, 900_000)

	it("a user cannot pay a user under a reference, and nothing is sent", async () => {
		const refused = await sentDuring(async () => {
			await expect(pay(alice, bob, newPaymentRef())).rejects.toThrow(TOKEN_REFUSALS.transfer)
		})
		expect(refused).toEqual([])
	}, 900_000)

	it("consolidate merges the merchant's notes into one it sends itself, keeping the balance", async () => {
		const { wallet, node } = harness()
		const before = (await l2Balances(m2)).private
		const txHash = await consolidate(wallet, node, tokenAddress(), m2, { fee: sponsored() })
		expect(txHash).toBeDefined()
		expect((await l2Balances(m2)).private).toBe(before)
		// The merged note is spendable like any other.
		await token().methods.transfer_private_to_private!(m2, m1, 1n, 0).send(as(m2))
		expect((await l2Balances(m2)).private).toBe(before - 1n)
	}, 900_000)
})
