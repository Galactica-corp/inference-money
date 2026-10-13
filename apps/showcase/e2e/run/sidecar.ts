/**
 * Keeps the run's local network building blocks for the suite's whole life: the network builds one only when a tx
 * arrives, so a deposit's message would never become claimable from the page. Bun, since the deployer and
 * local-network packages are Bun-only; it reads the manifest at startup, so it starts after the deploy.
 *
 *   RUN_ID=<run>  SIDECAR_PORT=<port>  bun e2e/run/sidecar.ts
 *
 * GET /health → 200 once the heartbeat runs.
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { registerBridgeContracts, registerSponsor } from "@galactica-net/inference-money-core"
import {
	enterOwnedTmpDir,
	localManifestPath,
	openBridgeWallet,
	readManifest,
	startBlockHeartbeat,
} from "@galactica-net/inference-money-deployer"
import { resolveEndpoints, runIdFor } from "@galactica-net/inference-money-local-network"

async function main(): Promise<void> {
	const runId = runIdFor()
	const port = Number(process.env.SIDECAR_PORT)
	if (!Number.isInteger(port) || port <= 0) throw new Error("SIDECAR_PORT must name the port this run claimed")
	const m = readManifest(localManifestPath(runId))
	const exitTmp = enterOwnedTmpDir()
	const wallet = await openBridgeWallet(createAztecNodeClient(resolveEndpoints(runId).nodeUrl), { prove: false })
	await registerSponsor(wallet, m)
	await registerBridgeContracts(wallet, m)
	const stopBeat = await startBlockHeartbeat(wallet, m)

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch: (req) =>
			req.method === "GET" && new URL(req.url).pathname === "/health"
				? Response.json({ ok: true })
				: new Response("not found", { status: 404 }),
	})
	console.log(`[sidecar] ${runId} beating, health on ${server.url}`)

	const shutdown = async () => {
		server.stop(true)
		await stopBeat().catch(() => {})
		await wallet.stop().catch(() => {})
		exitTmp()
		process.exit(0)
	}
	process.once("SIGTERM", shutdown)
	process.once("SIGINT", shutdown)
}

await main()
