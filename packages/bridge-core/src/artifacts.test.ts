import { describe, expect, it } from "bun:test"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract"
import { sponsoredFpcArtifact, tokenArtifact, tokenBridgeArtifact, tokenMinterProxyArtifact } from "./artifacts"

// The on-chain identities the deploy and every client register: a changed artifact must fail here before it ships.
describe("L2 artifacts derive their pinned class ids", () => {
	it.each([
		["TokenBridge", tokenBridgeArtifact, "0x264966763e6cc1feb7a859bc81f10858596098810eca5d153ed0439f08d3c197"],
		["TokenMinterProxy", tokenMinterProxyArtifact, "0x07892e36eb9f2753917094690bdb426e1932fd411de8bd637647de76ebd5bcb4"],
		["Token (merchant fork)", tokenArtifact, "0x11db2d2d902677a8bc27da6ad379f9d05a02461f26d849cc619d23d89fa9ab70"],
	] as const)("%s", async (_, artifact, classId) => {
		expect((await getContractClassFromArtifact(artifact)).id.toString()).toBe(classId)
	})

	// The address the testnet publishes and a local network funds at genesis.
	it("SponsoredFPC derives the canonical sponsor at salt 0", async () => {
		const instance = await getContractInstanceFromInstantiationParams(sponsoredFpcArtifact, { salt: Fr.ZERO })
		expect(instance.currentContractClassId.toString()).toBe("0x0d6670f2e8fdfcddc0436f10a43f9b06e5e5ee8797c0b0540e39d35881632437")
		expect(instance.address.toString()).toBe("0x2adfb70e860909f0db8268b3fec80bce52a94559963444f5c0341816b8412130")
	})
})
