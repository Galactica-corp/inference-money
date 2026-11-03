import { describe, expect, it } from "bun:test"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract"
import { sponsoredFpcArtifact, tokenArtifact, tokenBridgeArtifact, tokenMinterProxyArtifact } from "./artifacts"

// The on-chain identities the deploy and every client register: a changed artifact must fail here before it ships.
describe("L2 artifacts derive their pinned class ids", () => {
	it.each([
		["TokenBridge", tokenBridgeArtifact, "0x230bd9e62b0c89b52ea5221c288798d5b7b2bd83c20e5f7c28e8815aee8f8889"],
		["TokenMinterProxy", tokenMinterProxyArtifact, "0x155a365113346e4c3fee2c7a90b25fd66ebcba0c6a7ad285d8fa77b3fa9902a0"],
		["Token (merchant fork)", tokenArtifact, "0x15014dcf36ee757a9c333c476c3d0b9936439a84efcd04f4d1ecd0583ddee1a4"],
	] as const)("%s", async (_, artifact, classId) => {
		expect((await getContractClassFromArtifact(artifact)).id.toString()).toBe(classId)
	})

	// The address the testnet publishes and a local network funds at genesis.
	it("SponsoredFPC derives the canonical sponsor at salt 0", async () => {
		const instance = await getContractInstanceFromInstantiationParams(sponsoredFpcArtifact, { salt: Fr.ZERO })
		expect(instance.currentContractClassId.toString()).toBe("0x233391319da4f9877f724afd66d93a2d0dbb4a288f41e99093dbb30f41ee3335")
		expect(instance.address.toString()).toBe("0x2d8fff82a3b0c15d0a89169e7d8d043e079ab94d52031f1de1e4972ebad169d3")
	})
})
