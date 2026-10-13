import { beforeAll, describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { MerkleTreeId } from "@aztec-labs/stdlib/trees"
import { BindConsentRequiredError, NotFundingAddressError } from "./binding"
import {
	type ClaimNode,
	claim,
	feeFor,
	L2_PROPOSED,
	type NullifierNode,
	registerSponsor,
	SponsorUnavailableError,
	waitClaimable,
	waitClaimFinalized,
} from "./claim"
import { type ClaimTicket, prepareDeposit } from "./deposit"
import { fakeWallet } from "./test/fake-wallet"
import { f, MANIFEST as M, receiptAt } from "./test/fixtures"

let recipient: AztecAddress
beforeAll(async () => {
	recipient = await AztecAddress.random()
})
const ticket = async (kind: "public" | "private"): Promise<ClaimTicket> => ({
	draft: await prepareDeposit({ amount: 5n, recipient, kind }, M, () => 1_000n),
	messageHash: f(0x77),
	leafIndex: 3n,
	depositor: "0x000000000000000000000000000000000000D0D0",
})
const fail = (message: string) => () => {
	throw new Error(message)
}
const CHECKPOINTED = async () => receiptAt(TxStatus.CHECKPOINTED) as never
const NO_NULLIFIER: ClaimNode = { findLeavesIndexes: async (_b, _t, leaves) => leaves.map(() => undefined), getTxReceipt: CHECKPOINTED }

describe("registerSponsor", () => {
	const SPONSOR = "0x2adfb70e860909f0db8268b3fec80bce52a94559963444f5c0341816b8412130" as const

	it("registers the pinned sponsor, and refuses a manifest naming any other", async () => {
		const registered: string[] = []
		const wallet = { registerContract: async (i: { address: { toString(): string } }) => void registered.push(i.address.toString()) }
		expect((await registerSponsor(wallet as never, { ...M, l2: { ...M.l2, sponsoredFpc: SPONSOR } })).toString()).toBe(SPONSOR)
		expect(registered).toEqual([SPONSOR])

		await expect(registerSponsor(wallet as never, M)).rejects.toBeInstanceOf(SponsorUnavailableError)
		expect(registered).toHaveLength(1)
	})
})

describe("claim", () => {
	it("pays a private claim through the sponsor and leaves a public one to the wallet", async () => {
		const priv = fakeWallet()
		expect(await claim(await ticket("private"), NO_NULLIFIER, priv.wallet, M, { from: recipient, allowBind: true })).toBe("claimed")
		expect(priv.sent[0]).toMatchObject({ calls: ["sponsor_unconditionally", "claim_private"], feePayer: M.l2.sponsoredFpc })

		const pub = fakeWallet()
		await claim(await ticket("public"), NO_NULLIFIER, pub.wallet, M, { from: recipient })
		expect(pub.sent[0]).toMatchObject({ calls: ["claim_public"], feePayer: undefined })

		const chosen = fakeWallet()
		await claim(await ticket("private"), NO_NULLIFIER, chosen.wallet, M, { from: recipient, fee: "account-public", allowBind: true })
		expect(chosen.sent[0]).toMatchObject({ calls: ["claim_private"], feePayer: undefined })
		// @ts-expect-error the account's public payment is named for what it publishes, never "wallet-default"
		expect(() => feeFor("private", M, "wallet-default")).toThrow(/Unknown fee choice/)

		const sponsoredPublic = fakeWallet()
		await claim(await ticket("public"), NO_NULLIFIER, sponsoredPublic.wallet, M, { from: recipient, fee: "sponsored" })
		expect(sponsoredPublic.sent[0]).toMatchObject({ calls: ["sponsor_unconditionally", "claim_public"], feePayer: M.l2.sponsoredFpc })
	})

	it("binds the recipient's account on its first private claim, only with consent, and on no later one", async () => {
		const bindArg = (w: ReturnType<typeof fakeWallet>) => w.sent[0]?.args.at(-1)?.at(-1)
		const t = await ticket("private")
		const unconsented = fakeWallet()
		const never = { getL1ToL2MessageMembershipWitness: async () => undefined }
		await expect(claim(t, NO_NULLIFIER, unconsented.wallet, M, { from: recipient })).rejects.toBeInstanceOf(BindConsentRequiredError)
		await expect(waitClaimable(t, never, unconsented.wallet, M, recipient), "before waiting for the message").rejects.toBeInstanceOf(
			BindConsentRequiredError,
		)
		expect(unconsented.simulated.length + unconsented.sent.length).toBe(0)

		const first = fakeWallet()
		await claim(t, NO_NULLIFIER, first.wallet, M, { from: recipient, allowBind: true })
		expect(bindArg(first)).toBe(1n)

		const bound = fakeWallet({ utility: () => [new Fr(0xd0d0)] })
		await claim(t, NO_NULLIFIER, bound.wallet, M, { from: recipient })
		expect(bindArg(bound), "a bound account needs no consent").toBe(0n)
	})

	it("refuses a private deposit from another address than the bound one before any simulation", async () => {
		const bound = fakeWallet({ utility: () => [new Fr(0xbeefn)] })
		await expect(claim(await ticket("private"), NO_NULLIFIER, bound.wallet, M, { from: recipient })).rejects.toBeInstanceOf(
			NotFundingAddressError,
		)
		expect(bound.simulated.length + bound.sent.length).toBe(0)
	})

	it("returns only once the node reports the claim checkpointed, whatever the wallet would wait for", async () => {
		const statuses = [TxStatus.PROPOSED, TxStatus.CHECKPOINTED]
		const node: ClaimNode = { ...NO_NULLIFIER, getTxReceipt: async () => receiptAt(statuses.shift() ?? TxStatus.CHECKPOINTED) as never }
		const w = fakeWallet()
		expect(await claim(await ticket("public"), node, w.wallet, M, { from: recipient })).toBe("claimed")
		expect(statuses).toEqual([])
	})

	it("with L2_PROPOSED, returns at the proposed block and reads a nullifier error at that same tip", async () => {
		const statuses = [TxStatus.PROPOSED, TxStatus.CHECKPOINTED]
		const node: ClaimNode = { ...NO_NULLIFIER, getTxReceipt: async () => receiptAt(statuses.shift() ?? TxStatus.CHECKPOINTED) as never }
		const opts = { from: recipient, wait: L2_PROPOSED }
		expect(await claim(await ticket("public"), node, fakeWallet().wallet, M, opts)).toBe("claimed")
		expect(statuses).toEqual([TxStatus.CHECKPOINTED])
		const tips: unknown[] = []
		const claimedEarlier: ClaimNode = {
			getTxReceipt: CHECKPOINTED,
			findLeavesIndexes: async (block, _tree, leaves) => {
				tips.push(block)
				return leaves.map(() => ({ data: 7n }) as never)
			},
		}
		const { wallet } = fakeWallet({ send: fail("Invalid tx: Existing nullifier") })
		expect(await claim(await ticket("public"), claimedEarlier, wallet, M, opts)).toBe("consumed-unknown")
		expect(tips).toEqual(["proposed"])
	})

	it("reports consumed-unknown only when this ticket's nullifier is on L2; any other nullifier error stays retryable", async () => {
		for (const kind of ["public", "private"] as const) {
			const t = await ticket(kind)
			const { wallet } = fakeWallet({ send: fail("Assertion failed: L1-to-L2 message is already nullified") })
			const queried: Fr[] = []
			const nullified: ClaimNode = {
				getTxReceipt: CHECKPOINTED,
				findLeavesIndexes: async (block, tree, leaves) => {
					expect(block, "a proposed nullifier can still be re-orged out").toBe("checkpointed")
					expect(tree).toBe(MerkleTreeId.NULLIFIER_TREE)
					queried.push(...leaves)
					return leaves.map(() => ({ data: 7n }) as never)
				},
			}
			const opts = { from: recipient, allowBind: true }
			expect(await claim(t, nullified, wallet, M, opts)).toBe("consumed-unknown")
			await expect(claim(t, NO_NULLIFIER, wallet, M, opts)).rejects.toThrow("already nullified")
			const unreachable: ClaimNode = { findLeavesIndexes: fail("503") as never, getTxReceipt: CHECKPOINTED }
			await expect(claim(t, unreachable, wallet, M, opts)).rejects.toThrow("already nullified")
			expect(queried).toHaveLength(1)
		}
	})

	it("surfaces a sponsor that cannot pay, or is missing, as SponsorUnavailableError", async () => {
		const exhausted = fakeWallet({ send: fail("Not enough balance for fee payer to pay for transaction") })
		await expect(
			claim(await ticket("private"), NO_NULLIFIER, exhausted.wallet, M, { from: recipient, allowBind: true }),
		).rejects.toBeInstanceOf(SponsorUnavailableError)

		const none = fakeWallet()
		const noSponsor = { ...M, l2: { ...M.l2, sponsoredFpc: undefined } }
		await expect(
			claim(await ticket("private"), NO_NULLIFIER, none.wallet, noSponsor, { from: recipient, allowBind: true }),
		).rejects.toBeInstanceOf(SponsorUnavailableError)
		expect(none.sent).toHaveLength(0)

		const other = fakeWallet({ send: fail("boom") })
		await expect(claim(await ticket("public"), NO_NULLIFIER, other.wallet, M, { from: recipient })).rejects.toThrow("boom")
	})
})

describe("waitClaimFinalized", () => {
	/** Answers each read from the next state, the latest tip holding the nullifier; each tip holds those after it. */
	const scripted = (states: ("proposed" | "checkpointed" | "finalized" | "none" | "error")[]) => {
		const tags: string[] = []
		let round = -1
		const node: NullifierNode = {
			findLeavesIndexes: async (block, _tree, leaves) => {
				tags.push(String(block))
				if (block === "finalized") round++
				const state = states[Math.min(round, states.length - 1)]
				if (state === "error") throw new Error("503")
				const tips = ["proposed", "checkpointed", "finalized"]
				const hit = tips.indexOf(state ?? "none") >= tips.indexOf(String(block)) && state !== "none"
				return leaves.map(() => (hit ? ({ data: 1n } as never) : undefined))
			},
		}
		return { node, tags }
	}

	it("keeps the secret until the claim is finalized, through proposed and failed reads, and reports a pruned claim as dropped", async () => {
		const t = await ticket("private")
		let sleeps = 0
		const opts = { sleep: async () => void sleeps++ }
		const settling = scripted(["proposed", "checkpointed", "error", "checkpointed", "finalized"])
		expect(await waitClaimFinalized(t, settling.node, M, opts)).toBe("finalized")
		expect(settling.tags.filter((b) => b === "finalized").length, "one finalized read per round").toBe(5)
		expect(sleeps).toBe(4)

		expect(await waitClaimFinalized(t, scripted(["checkpointed", "none"]).node, M, opts)).toBe("dropped")
	})
})

describe("waitClaimable", () => {
	const noSleep = async () => {}

	it("waits for the message's inclusion, then for the wallet's anchor, then resolves", async () => {
		const witnesses = [undefined, [7n, []], [7n, []]]
		const node = { getL1ToL2MessageMembershipWitness: async () => witnesses.shift() }
		let sims = 0
		const { wallet } = fakeWallet({
			simulate: () => {
				if (sims++ === 0) throw new Error("Tried to consume nonexistent L1-to-L2 message")
			},
		})
		const stages: string[] = []
		await waitClaimable(await ticket("public"), node, wallet, M, recipient, (s) => stages.push(s), { sleep: noSleep })
		expect(stages).toEqual(["waiting-for-inclusion", "waiting-for-wallet-sync"])
	})

	it("rethrows an unexpected simulation error and gives up after its attempts", async () => {
		const node = { getL1ToL2MessageMembershipWitness: async () => [7n, []] }
		const broken = fakeWallet({ simulate: fail("Assertion failed: bridge is paused") })
		await expect(
			waitClaimable(await ticket("public"), node, broken.wallet, M, recipient, undefined, { sleep: noSleep }),
		).rejects.toThrow("paused")

		const never = { getL1ToL2MessageMembershipWitness: async () => undefined }
		const { wallet } = fakeWallet()
		await expect(
			waitClaimable(await ticket("public"), never, wallet, M, recipient, undefined, { sleep: noSleep, attempts: 3 }),
		).rejects.toThrow(/not reached your wallet yet/)
	})
})
