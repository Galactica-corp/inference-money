import { type Hex, parseTransaction, toHex } from "viem"
import { TESTIDS } from "../../src/lib/testids"
import { demoWallet, mintUsdc, transferUsdc, usdcOf } from "../fixtures/chain"
import { L1_SENDS, L2_SEND } from "../fixtures/rpc"
import { expect, test } from "../fixtures/test"
import { compose, expectBalance, feed, openLive, pickScene, resetBalances, shownBalance, tryIt, USDC } from "../pages/live"

// A payout waits for its epoch's proof on Ethereum.
test.describe.configure({ timeout: 30 * 60_000 })
const PAID_OUT_MS = 20 * 60_000
/** `demo setup`'s private seed for alice, which the reset restores. */
const ALICE_SEED = 10n * USDC
const CENT = USDC / 100n
const NOWHERE = "0x000000000000000000000000000000000000dEaD"

test("a send another visitor beat to the same funds is left unconfirmed on the nullifier conflict, never sent twice", async ({
	page,
	me,
	another,
}) => {
	const other = await another()
	await Promise.all([openLive(page), openLive(other.page)])
	const alice = await shownBalance(page, "alice")
	const step = { actor: "alice", action: "send", to: "galactica", amount: "0.01" }
	await compose(page, step)
	await compose(other.page, step)

	// This page's tx is built from the same note the other visitor is about to spend, and held at the node's door.
	const mark = me.rpc.calls.length
	const door = me.rpc.holdNext(L2_SEND)
	const mine = tryIt(page)
	await Promise.race([door.held, mine.then((r) => Promise.reject(new Error(`the run ended before sending: ${r.kind}, ${r.detail}`)))])
	const theirs = await tryIt(other.page)
	expect(theirs.kind, theirs.detail).toBe("settled")
	door.release()
	// The node's refusal is its word alone: the copy counts as gone only once a finalized block passes its expiry.
	const run = await mine
	expect([run.kind, run.detail]).toEqual(["failed", expect.stringMatching(/may still take the first try/)])
	expect(me.rpc.countSince(mark, L2_SEND), "the refused send, and no second").toBe(1)
	await expectBalance(page, "alice", alice - CENT)
})

test("[A13] a reload while a payout is on its way resumes it, and it pays out once", async ({ page, me, run, manifest }) => {
	const aDemo = demoWallet(manifest, "alice").address
	await openLive(page)
	const held = await usdcOf(run.anvilUrl, manifest, aDemo)

	// The page finds the proof and sends the payout; that request never leaves, and the page reloads under it.
	const door = me.rpc.holdNext("eth_sendRawTransaction")
	await pickScene(page, "withdraw")
	const exit = await tryIt(page)
	expect(exit.kind, exit.detail).toBe("settled")
	await door.held
	const mark = me.rpc.calls.length
	expect(await usdcOf(run.anvilUrl, manifest, aDemo), "nothing paid out before the reload").toBe(held)
	await openLive(page, { reload: true })
	door.release("abort")

	await expect.poll(() => usdcOf(run.anvilUrl, manifest, aDemo), { timeout: PAID_OUT_MS }).toBe(held + 3n * CENT)
	await expect(page.getByTestId(TESTIDS.payout)).toHaveCount(0)
	expect(me.rpc.countSince(mark, "eth_sendRawTransaction"), "paid once").toBe(1)
	expect((await feed(page)).at(0)).toMatchObject({ chain: "ethereum", source: "LIVE" })
})

test("[A11] a deposit Ethereum does not show is archived, listed with Check again, and kept across a reload", async ({
	page,
	me,
	run,
	manifest,
}) => {
	await openLive(page)
	const escrowed = await usdcOf(run.anvilUrl, manifest, manifest.l1.portal)

	// The deposit is signed and stored, its send held at the door, and the page reloads under it: it never reaches anvil.
	const door = me.rpc.holdNext("eth_sendRawTransaction")
	await pickScene(page, "deposit")
	await page.getByTestId(TESTIDS.tryIt).click()
	const [raw] = (await door.held) as [Hex]
	expect(parseTransaction(raw).to?.toLowerCase(), "the held send is the deposit itself").toBe(manifest.l1.router.toLowerCase())
	await openLive(page, { reload: true })
	door.release("abort")

	// The page's L1 reader puts its finalized block past the permit's deadline; the scan and Permit2's nonce stay real.
	const stop = me.rpc.rewrite("eth_getBlockByNumber", (block, [tag]) =>
		tag === "finalized" ? { ...(block as object), timestamp: toHex(BigInt((block as { timestamp: Hex }).timestamp) + 7_200n) } : block,
	)
	await compose(page, { actor: "alice", action: "claim", to: "alice" })
	const claim = await tryIt(page)
	expect([claim.kind, claim.detail]).toEqual(["failed", expect.stringContaining("keeps its record below")])
	const row = page.getByTestId(TESTIDS.archivedDeposit)
	await expect(row).toHaveText(/^0\.10 USDC from Alice's Ethereum wallet/)

	await openLive(page, { reload: true })
	await expect(row, "the record survives a reload").toHaveCount(1)
	const recheck = await tryIt(page, () => row.getByRole("button", { name: "Check again" }).click())
	expect(recheck.detail).toContain("Still no sign of it on Ethereum")
	await expect(row).toHaveCount(1)
	stop()
	expect(await usdcOf(run.anvilUrl, manifest, manifest.l1.portal), "nothing was deposited").toBe(escrowed)
})

test("Reset balances has galactica top alice back up to her starting balance", async ({ page }) => {
	await openLive(page)
	const [alice, galactica] = [await shownBalance(page, "alice"), await shownBalance(page, "galactica")]
	await compose(page, { actor: "alice", action: "send", to: "galactica", amount: "0.05" })
	expect((await tryIt(page)).kind).toBe("settled")
	await expectBalance(page, "galactica", galactica + 5n * CENT)

	const short = ALICE_SEED - (alice - 5n * CENT)
	const refund = short < galactica + 5n * CENT ? short : galactica + 5n * CENT
	const reset = await resetBalances(page)
	expect(reset.kind, reset.detail).toBe("settled")
	await expectBalance(page, "alice", alice - 5n * CENT + refund)
})

test("with the demo float empty, or nothing to claim, the page replays the recorded step and says so", async ({
	page,
	me,
	run,
	manifest,
}) => {
	const { key, address } = demoWallet(manifest, "alice")
	await openLive(page)

	await test.step("a claim with nothing pending", async () => {
		await pickScene(page, "claim")
		const r = await tryIt(page)
		expect(r.kind).toBe("settled")
		expect(r.detail).toContain("There is nothing to claim: deposit first. This replays the recorded run instead, so nothing moved now.")
		expect((await feed(page)).at(0)).toEqual({ step: "claim", chain: "aztec", source: "RECORDED" })
	})

	await test.step("a deposit from an empty Ethereum wallet", async () => {
		const float = await usdcOf(run.anvilUrl, manifest, address)
		await transferUsdc(run.anvilUrl, manifest, key, NOWHERE, float)
		try {
			const mark = me.rpc.calls.length
			await pickScene(page, "deposit")
			const r = await tryIt(page)
			expect(r.kind).toBe("settled")
			expect(r.detail).toContain("This Ethereum wallet holds 0.00 demo USDC, less than that. This replays the recorded run instead")
			expect((await feed(page)).at(0)).toEqual({ step: "deposit", chain: "ethereum", source: "RECORDED" })
			for (const method of [L2_SEND, ...L1_SENDS]) expect(me.rpc.countSince(mark, method), method).toBe(0)
		} finally {
			await mintUsdc(run.anvilUrl, manifest, key, float)
		}
	})
})
