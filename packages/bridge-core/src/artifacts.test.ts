import { describe, expect, it } from "bun:test"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract"
import { sponsoredFpcArtifact, tokenArtifact, tokenBridgeArtifact, tokenMinterProxyArtifact } from "./artifacts"

// The on-chain identities the deploy and every client register: a changed artifact must fail here before it ships.
describe("L2 artifacts derive their pinned class ids", () => {
	it.each([
		["TokenBridge", tokenBridgeArtifact, "0x0acad864bf73a8fe1dad449b47d5c17bdf1cdf2e62aeaa05bf32c753e8a2f2d6"],
		["TokenMinterProxy", tokenMinterProxyArtifact, "0x1d736ba69e4fa12e04e01a65e757103ef3522b23b573a712be0ce16628914961"],
		["Token (merchant fork)", tokenArtifact, "0x0e9ea7df488bcf4c07b8575448a03622a27cec8f47caec68991ef119149a5ca5"],
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
