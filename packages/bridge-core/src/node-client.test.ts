import { afterAll, describe, expect, it } from "bun:test"
import { createNodeClient, NODE_MAX_BATCH_SIZE } from "./node-client"

const batches: number[] = []
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const body = await req.json()
		const calls: { id: number }[] = Array.isArray(body) ? body : [body]
		batches.push(calls.length)
		const replies = calls.map(({ id }) => ({ jsonrpc: "2.0", id, result: 7 }))
		return Response.json(Array.isArray(body) ? replies : replies[0])
	},
})
afterAll(() => server.stop(true))

describe("createNodeClient", () => {
	it("splits the calls of one tick into batches of at most NODE_MAX_BATCH_SIZE", async () => {
		const node = createNodeClient(`http://127.0.0.1:${server.port}`)
		const results = await Promise.all(Array.from({ length: 10 }, () => node.getBlockNumber()))
		expect(results.map(Number)).toEqual(Array(10).fill(7))
		expect(batches.reduce((a, b) => a + b, 0)).toBe(10)
		expect(Math.max(...batches)).toBe(NODE_MAX_BATCH_SIZE)
	})
})
