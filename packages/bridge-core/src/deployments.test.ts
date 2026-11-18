import { describe, expect, it } from "bun:test"
import { DEPLOYMENTS } from "./deployments"
import { BRIDGE_CONTRACTS, instanceFromRecord } from "./instances"

// A release ships artifacts and addresses together: artifacts that no longer derive a shipped address must fail here.
describe.each(Object.entries(DEPLOYMENTS))("the shipped %s deployment", (name, m) => {
	it("names its own network", () => {
		expect(m.network).toBe(name as typeof m.network)
	})

	it.each(BRIDGE_CONTRACTS)("%s derives its recorded address from this package's artifact", async (key, artifact) => {
		expect((await instanceFromRecord(artifact, m.l2[key])).address.toString()).toBe(m.l2[key].address)
	})
})
