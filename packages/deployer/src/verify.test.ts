import { describe, expect, it } from "bun:test"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { MANIFEST } from "../../bridge-core/src/test/fixtures"
import { verifyEnvironment } from "./verify"

const publishedEverywhere = { getContract: async () => ({}) } as unknown as AztecNode
const sponsorCheck = async (network: "local" | "testnet") => {
	const m = { ...MANIFEST, network, l2: { ...MANIFEST.l2, sponsoredFpc: undefined } }
	return (await verifyEnvironment(publishedEverywhere, m)).find((c) => c.name === "SponsoredFPC")
}

describe("verifyEnvironment", () => {
	it("fails a manifest with no fee sponsor anywhere but a local network", async () => {
		expect(await sponsorCheck("testnet")).toMatchObject({ ok: false, detail: expect.stringMatching(/fee payer/) })
		expect(await sponsorCheck("local")).toMatchObject({ ok: true })
	})
})
