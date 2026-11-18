import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { L1TxUtils } from "@aztec-labs/ethereum/l1-tx-utils"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { type Address, decodeFunctionData, encodeFunctionResult, getAddress, type Hex, parseAbi, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { bridgeFeeJuice } from "./fee-juice"
import { TESTNET } from "./networks"

const KEY = `0x${"0b".repeat(32)}` as const
const TOKEN = getAddress("0x00000000000000000000000000000000000f3e00")
const UNPINNED = EthAddress.fromString("0x00000000000000000000000000000000000a0de0")
const MINT = 10n ** 21n

const L1_ABI = parseAbi([
	"function UNDERLYING() view returns (address)",
	"function mintAmount() view returns (uint256)",
	"function mint(address)",
	"function approve(address, uint256) returns (bool)",
	"function depositToAztecPublic(bytes32, uint256, bytes32) returns (bytes32, uint256)",
])

/** What the pinned contracts answer; any other call fails, so a read from a node-chosen address cannot succeed. */
const ANSWERS: Record<string, unknown> = {
	[`${getAddress(TESTNET.feeJuicePortal)} UNDERLYING`]: TOKEN,
	[`${getAddress(TESTNET.feeAssetHandler)} mintAmount`]: MINT,
	[`${getAddress(TESTNET.feeJuicePortal)} depositToAztecPublic`]: [toHex(0, { size: 32 }), 0n],
}

function l1Stub() {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const { id, method, params } = (await req.json()) as { id: number; method: string; params: [{ to: Address; data: Hex }] }
			if (method === "eth_chainId") return Response.json({ jsonrpc: "2.0", id, result: toHex(TESTNET.l1ChainId) })
			const call = method === "eth_call" ? decodeFunctionData({ abi: L1_ABI, data: params[0].data }) : undefined
			const answer = call && ANSWERS[`${getAddress(params[0].to)} ${call.functionName}`]
			if (!call || answer === undefined) return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: method } })
			return Response.json({
				jsonrpc: "2.0",
				id,
				result: encodeFunctionResult({ abi: L1_ABI, functionName: call.functionName, result: answer } as never),
			})
		},
	})
}

afterEach(() => mock.restore())

describe("bridgeFeeJuice", () => {
	it("mints, approves and deposits against the pins and the pinned portal's token, whatever the node names", async () => {
		const signed: { to: Address; call: string; args: readonly unknown[] }[] = []
		spyOn(L1TxUtils.prototype, "sendAndMonitorTransaction").mockImplementation(async (req) => {
			const { functionName, args } = decodeFunctionData({ abi: L1_ABI, data: req.data as Hex })
			signed.push({ to: getAddress(req.to as Address), call: functionName, args: args ?? [] })
			return { receipt: { logs: [] } } as never
		})
		const nodeChosen = { feeJuiceAddress: UNPINNED, feeJuicePortalAddress: UNPINNED, feeAssetHandlerAddress: UNPINNED }
		const getNodeInfo = mock(async () => ({ l1ContractAddresses: nodeChosen }))
		const server = l1Stub()
		const to = AztecAddress.fromStringUnsafe(toHex(7, { size: 32 }))
		try {
			const bridging = bridgeFeeJuice({
				node: { getNodeInfo } as unknown as AztecNode,
				pins: TESTNET,
				l1RpcUrl: server.url.href,
				l1PrivateKey: KEY,
				to,
				log: () => {},
			})
			// The stubbed deposit receipt carries no event, so the bridge stops right after its three L1 txs.
			await expect(bridging).rejects.toThrow("DepositToAztecPublic")
		} finally {
			await server.stop(true)
		}
		const [portal, handler] = [getAddress(TESTNET.feeJuicePortal), getAddress(TESTNET.feeAssetHandler)]
		expect(signed.map(({ to, call }) => `${call}@${to}`)).toEqual([
			`mint@${handler}`,
			`approve@${TOKEN}`,
			`depositToAztecPublic@${portal}`,
		])
		expect(signed[0]?.args).toEqual([privateKeyToAccount(KEY).address])
		expect(signed[1]?.args).toEqual([portal, MINT])
		expect(signed[2]?.args.slice(0, 2)).toEqual([to.toString(), MINT])
		expect(getNodeInfo).not.toHaveBeenCalled()
	})
})
