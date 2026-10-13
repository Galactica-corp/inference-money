import { describe, expect, it } from "bun:test"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { publishInstance } from "@aztec-labs/aztec.js/deployment"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ContractArtifact } from "@aztec-labs/stdlib/abi"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/stdlib/contract"
import {
	BridgePausedError,
	claim,
	isBridgePaused,
	prepareDeposit,
	SponsorUnavailableError,
	sponsoredFpcArtifact,
	sponsoredPayment,
	submitDeposit,
	tokenBridgeArtifact,
	tokenMinterProxyArtifact,
} from "@galactica-net/inference-money-core"
import { claimable, claimFor, deposit, depositsBy, l1Actor, l1Now, l2Actor, l2Balances, merchantActor, setPaused, USDC } from "./actors"
import { harness, INTEGRATION } from "./harness"

describe.skipIf(!INTEGRATION)("guards", () => {
	it("[A7] a deployer-bound proxy or bridge can be neither published nor initialized first by anyone else", async () => {
		const { manifest: m, wallet, owner, node } = harness()
		const attacker = await l2Actor()
		const fee = { paymentMethod: sponsoredPayment(m) }
		const bridgeArgs = [
			AztecAddress.fromStringUnsafe(m.l2.proxy.address),
			AztecAddress.fromStringUnsafe(m.l2.token.address),
			EthAddress.fromString(m.l1.portal),
		]
		const targets: [ContractArtifact, unknown[]][] = [
			[tokenMinterProxyArtifact, []],
			[tokenBridgeArtifact, bridgeArgs],
		]
		for (const [artifact, args] of targets) {
			const instance = await getContractInstanceFromInstantiationParams(artifact, {
				constructorArtifact: "constructor",
				constructorArgs: args,
				salt: Fr.random(),
				deployer: owner,
			})
			await wallet.registerContract(instance, artifact)
			// The registry takes the deployer from msg_sender, so an attacker's publish lands at another address.
			await publishInstance(wallet, instance).send({ from: attacker, fee })
			expect(await node.getContract(instance.address)).toBeUndefined()
			// The window a split deploy would open: published, not yet initialized.
			await publishInstance(wallet, instance).send({ from: owner, fee })
			const c = Contract.at(instance.address, artifact, wallet)
			await expect(c.methods.constructor!(...args).send({ from: attacker, fee })).rejects.toThrow(/not the contract deployer/i)
			await c.methods.constructor!(...args).send({ from: owner, fee })
		}
	})

	it("[A15] a sponsor that cannot pay is a SponsorUnavailableError and the ticket survives to be claimed", async () => {
		const { manifest: m, wallet, node } = harness()
		const unfunded = await getContractInstanceFromInstantiationParams(sponsoredFpcArtifact, { salt: new Fr(1) })
		await wallet.registerContract(unfunded, sponsoredFpcArtifact)
		const broke = { ...m, l2: { ...m.l2, sponsoredFpc: unfunded.address.toString() as `0x${string}` } }
		const [l1, bob] = await Promise.all([l1Actor(), l2Actor()])
		const t = await deposit(l1, "private", bob, USDC)
		await claimable(t, bob)
		await expect(claim(t, node, wallet, broke, { from: bob, allowBind: true })).rejects.toBeInstanceOf(SponsorUnavailableError)
		expect(await claim(t, node, wallet, m, { from: bob, allowBind: true })).toBe("claimed")
		expect((await l2Balances(bob)).private).toBe(USDC)
	})

	it("[A6] while paused a new deposit is refused before signing and an in-flight claim fails; after unpausing it lands", async () => {
		const { manifest: m, node } = harness()
		const [l1, bob] = await Promise.all([l1Actor(), merchantActor()])
		const inFlight = await deposit(l1, "public", bob, USDC)
		await claimable(inFlight, bob)
		await setPaused(true)
		try {
			expect(await isBridgePaused(node, m)).toBe(true)
			await expect(claimFor(inFlight)).rejects.toThrow("Bridge is paused")
			const d = await prepareDeposit({ amount: USDC, recipient: bob, kind: "public" }, m, await l1Now())
			await expect(submitDeposit(d, l1, m, node)).rejects.toBeInstanceOf(BridgePausedError)
			expect(d.submission).toBeUndefined()
		} finally {
			await setPaused(false)
		}
		expect(await isBridgePaused(node, m)).toBe(false)
		expect(await claimFor(inFlight)).toBe("claimed")
		expect(await depositsBy(l1.account)).toBe(1)
		expect((await l2Balances(bob)).public).toBe(USDC)
	})
})
