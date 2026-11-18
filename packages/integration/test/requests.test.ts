import { beforeAll, describe, expect, it } from "bun:test"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import {
	completionCount,
	openRequest,
	PaymentRefusedError,
	pad,
	paid,
	payRequest,
	requestStamp,
	Side,
	sideCapsule,
	TOKEN_REFUSALS,
} from "@galactica-net/inference-money-core"
import { funded, l1Actor, l2Actor, l2Balances, sentDuring, USDC } from "./actors"
import { harness, INTEGRATION, sendTogether } from "./harness"
import { as, listMerchant, merchantList, sponsored, token, tokenAddress } from "./token"

const AMOUNT = USDC / 10n

const open = async (from: AztecAddress, to: AztecAddress, completer: AztecAddress) => {
	const { wallet, node } = harness()
	return openRequest(wallet, node, tokenAddress(), { from, to, completer }, { list: await merchantList(), fee: sponsored() })
}

const pay = async (from: AztecAddress, commitment: Fr, kind: "private" | "public" = "private") => {
	const { gate, wallet } = harness()
	const intent = { from, commitment, amount: AMOUNT, kind }
	return payRequest(gate, wallet, tokenAddress(), intent, { list: await merchantList(), fee: sponsored() })
}

/** A payment straight to the token, past payments.ts, with a capsule claiming `side`. */
const payDirectly = (from: AztecAddress, commitment: Fr, side: Side) =>
	token().methods.transfer_private_to_commitment!(from, commitment, AMOUNT, 0)
		.with({ capsules: [sideCapsule(tokenAddress(), side)] })
		.send(as(from))

const payPubliclyDirectly = (from: AztecAddress, commitment: Fr) =>
	token().methods.transfer_public_to_commitment!(from, commitment, AMOUNT, 0).send(as(from))

/** Whether the token pushed `nullifier`, as the node indexes it at its latest block. */
const pushed = async (nullifier: Fr) => {
	const leaf = await siloNullifier(tokenAddress(), nullifier)
	const [index] = await harness().node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, [leaf])
	return index !== undefined
}

const nullifierCount = async (txHash: { toString(): string }) => {
	const effect = await harness().node.getTxEffect(txHash as never)
	if (!effect) throw new Error(`no effect for ${txHash}`)
	return effect.data.nullifiers.length
}

describe.skipIf(!INTEGRATION)("payment requests", () => {
	let alice: AztecAddress
	let bob: AztecAddress
	let m1: AztecAddress

	beforeAll(async () => {
		const l1 = await l1Actor()
		;[alice, bob, m1] = await Promise.all([l2Actor(), l2Actor(), l2Actor()])
		await listMerchant(m1)
		await funded(l1, "private", alice, USDC)
		await funded(l1, "public", m1, USDC)
		// A user holds a public balance only by a merchant's public transfer.
		await token().methods.transfer_public_to_public!(m1, alice, 3n * AMOUNT, 0).send(as(m1))
	}, 900_000)

	it("[A22] a merchant's request is stamped and a user pays it; one opened for a user is padded, with as many nullifiers, and refused", async () => {
		const { node } = harness()
		const stamped = await open(m1, m1, alice)
		expect(await requestStamp(node, tokenAddress(), stamped.commitment)).toMatchObject({ state: "fresh" })
		await pay(alice, stamped.commitment)
		expect((await l2Balances(m1)).private).toBe(AMOUNT)

		const padded = await open(m1, bob, alice)
		expect([await requestStamp(node, tokenAddress(), padded.commitment), await pushed(pad(padded.commitment))]).toEqual([
			undefined,
			true,
		])
		expect(await nullifierCount(padded.txHash)).toBe(await nullifierCount(stamped.txHash))

		const refused = await sentDuring(async () => {
			await expect(pay(alice, padded.commitment)).rejects.toThrow(TOKEN_REFUSALS.payment)
			// The token refuses it whichever side a capsule claims: the stamp is missing, and alice is no merchant.
			await expect(payDirectly(alice, padded.commitment, Side.First)).rejects.toThrow(TOKEN_REFUSALS.payment)
			await expect(payDirectly(alice, padded.commitment, Side.Second)).rejects.toThrow(/uninitialized PublicImmutable/)
		})
		expect(refused).toEqual([])
	})

	it("[A22] a request takes one payment: after a private or a public one, the token refuses a second through either path", async () => {
		const m1Before = (await l2Balances(m1)).private
		const privately = await open(m1, m1, alice)
		await pay(alice, privately.commitment)
		const publicly = await open(m1, m1, alice)
		await pay(alice, publicly.commitment, "public")
		expect([await pushed(paid(privately.commitment)), await pushed(paid(publicly.commitment))]).toEqual([true, true])

		const refused = await sentDuring(async () => {
			for (const { commitment } of [privately, publicly]) {
				await expect(pay(alice, commitment)).rejects.toBeInstanceOf(PaymentRefusedError)
				await expect(payDirectly(alice, commitment, Side.First)).rejects.toThrow(TOKEN_REFUSALS.alreadyPaid)
				await expect(payPubliclyDirectly(alice, commitment)).rejects.toThrow(TOKEN_REFUSALS.alreadyPaid)
			}
		})
		expect(refused).toEqual([])
		expect((await l2Balances(m1)).private).toBe(m1Before + 2n * AMOUNT)
	})

	it("[A22] a private and a public payment into one request, proven against the same state and sent together: one lands", async () => {
		const { node } = harness()
		const request = await open(m1, m1, alice)
		const before = await l2Balances(alice)
		const outcomes = await sendTogether([
			() => payDirectly(alice, request.commitment, Side.First),
			() => payPubliclyDirectly(alice, request.commitment),
		])
		const landed = outcomes.filter((o) => o.status === "fulfilled")
		expect(landed, JSON.stringify(outcomes.map((o) => (o.status === "rejected" ? String(o.reason) : o.status)))).toHaveLength(1)
		expect(outcomes.find((o) => o.status === "rejected")?.reason).toEqual(
			expect.objectContaining({ message: expect.stringMatching(/dropped|reverted/) }),
		)
		expect(await completionCount(node, tokenAddress(), request.commitment)).toBe(1)
		const after = await l2Balances(alice)
		expect(before.private - after.private + (before.public - after.public)).toBe(AMOUNT)
	})

	it("[A22] a merchant pays a user's request from its public balance through payments.ts, once", async () => {
		const { node } = harness()
		const request = await open(m1, bob, m1)
		await pay(m1, request.commitment, "public")
		expect(await completionCount(node, tokenAddress(), request.commitment)).toBe(1)
		await expect(pay(m1, request.commitment, "public")).rejects.toBeInstanceOf(PaymentRefusedError)
		expect((await l2Balances(bob)).private).toBe(AMOUNT)
	})
})
