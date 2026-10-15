import { parseManifest } from "@inference-money/bridge-core/manifest"
import { ethereumKey } from "@inference-money/demo/keys"
import { parseTour } from "@inference-money/demo/tour"
import { TESTNET } from "@inference-money/deployer/networks"
import { createPublicClient, erc20Abi, type Hex, http, isAddressEqual } from "viem"
import { privateKeyToAddress } from "viem/accounts"
import { PRESTO_DEFAULT, servedHeaders } from "../../build/target"
import { TESTIDS } from "../../src/lib/testids"
import { l2Receipt } from "../fixtures/chain"
import { L2_SEND } from "../fixtures/rpc"
import { CHEATS, expectRefused } from "../pages/cheats"
import { compose, feed, newRows, openLive, pickScene, tryIt, USDC } from "../pages/live"
import { expect, test } from "./fixtures"

/** A long-lived deployment: a fresh browser store syncs every demo account from its deploy block. */
const WALLET_READY_MS = 20 * 60_000
const sepolia = createPublicClient({ transport: http(TESTNET.defaultL1RpcUrl) })

test("[A29] serves the testnet build as built: its manifest, its tour, its headers, and links to txs that executed", async ({
	page,
	request,
	manifest,
	tour,
}) => {
	const response = await page.goto("/#recorded")
	const headers = response?.headers() ?? {}
	const built = servedHeaders({
		manifest,
		usersTag: "",
		merchantsSalt: "",
		l1RpcUrl: TESTNET.defaultL1RpcUrl,
		proofs: "real",
		presto: PRESTO_DEFAULT,
		tour,
	})
	for (const [name, value] of Object.entries(built)) expect(headers[name.toLowerCase()], name).toBe(value)
	expect(await page.evaluate(() => crossOriginIsolated), "the page is cross-origin isolated").toBe(true)
	await expect(page.getByTestId(TESTIDS.network)).toHaveText("Aztec testnet · real proofs")
	expect(parseManifest(await (await request.get("/bridge-manifest.json")).json())).toEqual(manifest)
	expect(parseTour(await (await request.get("/showcase-tour.json")).json())).toEqual(tour)

	// Paused on the last scene's outcome, the feed holds every recorded row.
	await page.getByRole("button", { name: "Pause" }).click()
	await pickScene(page, "withdraw")
	const rows = await feed(page)
	expect(rows.map((r) => r.step)).toEqual(tour.steps.map((s) => s.id).reverse())
	for (const s of tour.steps) {
		const link = s.l2 ? `${TESTNET.explorer.l2Tx}${s.l2.txHash}` : s.l1 && `${TESTNET.explorer.l1Tx}${s.l1.txHash}`
		expect(rows.find((r) => r.step === s.id)?.href, s.id).toBe(link)
		// Read from the chains themselves, not the explorers' pages.
		if (s.l1) expect((await sepolia.getTransactionReceipt({ hash: s.l1.txHash as Hex })).status, s.id).toBe("success")
		if (s.l2) expect(await l2Receipt(manifest.l2.nodeUrl, s.l2.txHash), s.id).toMatchObject({ executionResult: "success" })
	}
})

test("[A29] live on testnet: every cheat refused with nothing sent, galactica's refund proven here, A_demo's deposit", async ({
	page,
	rpc,
	manifest,
}) => {
	await openLive(page, { readyMs: WALLET_READY_MS })
	for (const cheat of CHEATS) await test.step(cheat[0], () => expectRefused(page, rpc, cheat))

	await test.step("galactica refunds alice 0.01, proven in this browser", async () => {
		const [before, mark] = [await feed(page), rpc.calls.length]
		await compose(page, { actor: "galactica", action: "send", to: "alice", amount: "0.01" })
		const run = await tryIt(page)
		expect(run.kind, run.detail).toBe("settled")
		const [row, ...more] = await newRows(page, before)
		expect([row, more.length]).toMatchObject([{ chain: "aztec", source: "LIVE", href: `${TESTNET.explorer.l2Tx}${row?.step}` }, 0])
		expect(rpc.countSince(mark, L2_SEND), "one tx sent").toBe(1)
		expect(await l2Receipt(manifest.l2.nodeUrl, row?.step ?? "")).toMatchObject({ executionResult: "success" })
	})

	await test.step("A_demo deposits 0.01 for alice on Ethereum", async () => {
		const aDemo = privateKeyToAddress(ethereumKey(manifest.l2.bridge.address, "alice"))
		const usdc = () => sepolia.readContract({ address: manifest.l1.usdc, abi: erc20Abi, functionName: "balanceOf", args: [aDemo] })
		const [held, before] = [await usdc(), await feed(page)]
		await compose(page, { actor: "alice", action: "deposit", to: "alice", amount: "0.01" })
		const run = await tryIt(page)
		expect(run.kind, run.detail).toBe("settled")
		const [row] = await newRows(page, before)
		expect(row, "a live deposit, not the recording's").toMatchObject({ chain: "ethereum", source: "LIVE" })
		const receipt = await sepolia.getTransactionReceipt({ hash: row?.href?.replace(TESTNET.explorer.l1Tx, "") as Hex })
		expect(receipt.status).toBe("success")
		expect(isAddressEqual(receipt.from, aDemo) && receipt.to !== null && isAddressEqual(receipt.to, manifest.l1.router)).toBe(true)
		expect(await usdc()).toBe(held - USDC / 100n)
	})
})
