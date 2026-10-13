import { describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import { sponsoredPayment } from "@inference-money/bridge-core"
import { topUpSponsor } from "@inference-money/deployer"
import { L1_CHAIN_ID } from "@inference-money/local-network"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { l2Actor } from "./actors"
import { harness, INTEGRATION } from "./harness"

describe.skipIf(!INTEGRATION)("sponsor top-up", () => {
	it("a faucet mint bridged to the sponsor and claimed publicly by any account raises its Fee Juice", async () => {
		const { manifest: m, node, wallet, l1 } = harness()
		const key = generatePrivateKey()
		await l1.test.setBalance({ address: privateKeyToAccount(key).address, value: 10n ** 20n })
		const sponsor = AztecAddress.fromStringUnsafe(m.l2.sponsoredFpc as string)
		const before = await getFeeJuiceBalance(sponsor, node)
		// The run's own node stands in for a live network's pins.
		const { feeJuicePortalAddress: portal, feeAssetHandlerAddress: handler } = (await node.getNodeInfo()).l1ContractAddresses
		if (!handler) throw new Error("the local network deployed no fee asset handler")
		const pins = { l1ChainId: L1_CHAIN_ID, feeJuicePortal: portal.toString(), feeAssetHandler: handler.toString() }
		const after = await topUpSponsor({
			node,
			wallet,
			from: await l2Actor(),
			sponsor,
			fee: { paymentMethod: sponsoredPayment(m) },
			bridge: { pins, l1RpcUrl: l1.rpcUrl, l1PrivateKey: key },
			log: () => {},
		})
		expect(after).toBeGreaterThan(before)
	})
})
