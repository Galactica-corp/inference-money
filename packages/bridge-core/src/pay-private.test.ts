import { describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { type PaymentProof, PaymentProofRefusedError, proofOf, receivePayment, refPaymentKey } from "./pay-private"

const TOKEN = AztecAddress.fromBigIntUnsafe(0x70c3n)
const MERCHANT = AztecAddress.fromBigIntUnsafe(0x1234n)
const OTHER = AztecAddress.fromBigIntUnsafe(0x9999n)
const REF = new Fr(0x5eedn)
const TX = TxHash.fromString(`0x0${"ab".repeat(31)}a`)

const message = (recipient: AztecAddress, contractAddress = TOKEN) => ({
	recipient,
	contractAddress,
	payload: [new Fr(1n), new Fr(2n)],
	anchorBlockTimestamp: 1_800_000_000n,
})

// Neither the node nor the wallet may be reached by a proof refused on its face.
const untouchable = new Proxy({}, { get: () => () => Promise.reject(new Error("reached")) }) as never

describe("payment proofs", () => {
	it("carry only the recipient's messages from this token", () => {
		const proof = proofOf(TX, REF, TOKEN, MERCHANT, [message(MERCHANT), message(OTHER), message(MERCHANT), message(MERCHANT, OTHER)])
		expect(proof.messages).toHaveLength(2)
		expect(proof.messages.every((m) => m.recipient === MERCHANT.toString() && m.contractAddress === TOKEN.toString())).toBe(true)
		expect(proof).toMatchObject({ txHash: TX.toString(), paymentRef: REF.toString() })
		expect(proof.messages[0]!.ciphertext).toEqual([new Fr(1n).toString(), new Fr(2n).toString()])
	})

	it("are not built from a payment that returned fewer than the note and the event", () => {
		expect(() => proofOf(TX, REF, TOKEN, MERCHANT, [message(MERCHANT), message(OTHER)])).toThrow("expected its note and event")
	})

	it("key one reference per merchant", () => {
		expect(refPaymentKey(TOKEN, MERCHANT, REF)).not.toBe(refPaymentKey(TOKEN, OTHER, REF))
	})
})

describe("receivePayment refuses on the proof's face, before any node or wallet call", () => {
	const proof = (): PaymentProof => proofOf(TX, REF, TOKEN, MERCHANT, [message(MERCHANT), message(MERCHANT)])
	const expected = { paymentRef: REF, price: 100n }
	const refusal = (p: PaymentProof, e = expected) => receivePayment(untouchable, untouchable, TOKEN, MERCHANT, p, e)

	it("another reference", async () => {
		await expect(refusal(proof(), { ...expected, paymentRef: new Fr(1n) })).rejects.toMatchObject({ reason: "malformed" })
	})

	it("no messages, or too many", async () => {
		await expect(refusal({ ...proof(), messages: [] })).rejects.toMatchObject({ reason: "malformed" })
		const many = Array.from({ length: 17 }, () => proof().messages[0]!)
		await expect(refusal({ ...proof(), messages: many })).rejects.toMatchObject({ reason: "malformed" })
	})

	it("a message for another account or another contract", async () => {
		const p = proof()
		await expect(
			refusal({ ...p, messages: [p.messages[0]!, { ...p.messages[1]!, recipient: OTHER.toString() }] }),
		).rejects.toBeInstanceOf(PaymentProofRefusedError)
		await expect(refusal({ ...p, messages: [{ ...p.messages[0]!, contractAddress: OTHER.toString() }] })).rejects.toMatchObject({
			reason: "foreign",
		})
	})
})
