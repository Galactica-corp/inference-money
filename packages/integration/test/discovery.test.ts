import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { computeLogTag, computeSiloedPrivateLogFirstField } from "@aztec-labs/stdlib/hash"
import { SiloedTag } from "@aztec-labs/stdlib/logs"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { exitToL1, fundingAddress, l2UsdcBalance, randomSecret, registerBridgeContracts, signingKeyFor } from "@inference-money/bridge-core"
import { openBridgeWallet } from "@inference-money/deployer"
import type { Address } from "viem"
import { claimable, claimFor, deposit, l1Actor, merchantActor, payFor, sentDuring, USDC } from "./actors"
import { harness, INTEGRATION, newAccount } from "./harness"
import { as, token } from "./token"

// aztec-nr v6.0.0-rc.3's STANDARD_HANDSHAKE_REGISTRY_ADDRESS and DomainSeparator.NON_INTERACTIVE_HANDSHAKE_LOG_TAG: the
// registry announces a non-interactive handshake under a tag anyone derives from the recipient's address alone.
const HANDSHAKE_REGISTRY = AztecAddress.fromStringUnsafe("0x198aa5f21f7a13761f4729c544fb6edcae73a484d57b248b6390eb0dc5c06040")
const NON_INTERACTIVE_HANDSHAKE_LOG_TAG = 4046403018

/** The txs holding a private log under `account`'s handshake tag. */
async function announcedTo(account: AztecAddress): Promise<string[]> {
	const raw = await computeLogTag(account.toField(), NON_INTERACTIVE_HANDSHAKE_LOG_TAG)
	const tag = new SiloedTag(await computeSiloedPrivateLogFirstField(HANDSHAKE_REGISTRY, raw))
	const [logs] = await harness().node.getPrivateLogsByTags({ tags: [tag] })
	return [...new Set((logs ?? []).map((l) => l.txHash.toString()))]
}

/** Sends one tx and waits until the node has its block, so a log query sees the tx's logs. */
async function landed(send: () => Promise<unknown>): Promise<string> {
	const txs = await sentDuring(send)
	const hash = txs.at(-1)?.hash
	if (!hash) throw new Error("no tx was sent")
	for (let tries = 0; tries < 60; tries++) {
		if ((await harness().node.getTxReceipt(TxHash.fromString(hash))).blockNumber !== undefined) return hash
		await Bun.sleep(1_000)
	}
	throw new Error(`tx ${hash} is not in a block`)
}

interface Step {
	name: string
	/** The private balance a second wallet holding only the account's secret reads. */
	restored: bigint
	announced: string[]
}

/** An account U and a merchant: U's own notes first, then notes between two different accounts. */
class Scenario {
	readonly steps: Step[] = []
	readonly announced = { shopBefore: [] as string[], shopAfterPayment: [] as string[] }
	readonly others = {
		/**
		 * Private balances this wallet reads once each step landed, before its tag query: the shop's, the puller's, the
		 * shop's, U's. Not the second wallet: U's change from the merchant's pull is tagged under the merchant.
		 */
		read: [] as bigint[],
		selfShield: [] as string[],
		shieldPull: "",
		puller: [] as string[],
		pull: "",
		shop: [] as string[],
		user: [] as string[],
	}
	paymentTx = ""
	depositor: Address = "0x"
	restoredFunding: Address | undefined
	private restored: EmbeddedWallet | undefined
	private u = AztecAddress.ZERO
	private shop = AztecAddress.ZERO

	async run(): Promise<void> {
		const { manifest: m, node, sends, wallet } = harness()
		const secret = randomSecret()
		const [l1, shop, u] = await Promise.all([l1Actor(), merchantActor(), newAccount(wallet, m, secret)])
		Object.assign(this, { u, shop, depositor: l1.account })

		const t = await deposit(l1, "private", u, 7n * USDC)
		await claimable(t, u)
		await landed(async () => expect(await claimFor(t)).toBe("claimed"))
		this.restored = await openBridgeWallet(node, { prove: false })
		await registerBridgeContracts(this.restored, m)
		await this.restored.createSchnorrAccount(secret, Fr.ZERO, signingKeyFor(secret))
		this.restoredFunding = await fundingAddress(this.restored, m, u)
		await this.record("claim")

		this.announced.shopBefore = await announcedTo(shop)
		this.paymentTx = await landed(() => token().methods.transfer_private_to_private!(u, shop, 2n * USDC, 0).send(as(u)))
		await this.record("payment")
		this.announced.shopAfterPayment = await announcedTo(shop)

		await landed(() => token().methods.transfer_private_to_private!(u, u, 1n * USDC, 0).send(as(u)))
		await this.record("send to itself")

		// From notes of 4 and 1, an exit of 2 leaves change whichever notes it takes.
		const exit = { kind: "private", from: u, recipientL1: l1.account, amount: 2n * USDC } as const
		await landed(() => exitToL1(exit, wallet, sends, m, { fee: payFor("private") }))
		await this.record("exit")
	}

	/** The merchant shields to itself, another account pulls its public tokens, and it pulls U's private ones. */
	async runBetweenAccounts(): Promise<void> {
		const { manifest: m, wallet } = harness()
		const { u, shop, others } = this
		const read = async (balance: Promise<bigint>) => others.read.push(await balance)
		const privateOf = (who: AztecAddress) => l2UsdcBalance(wallet, m, who, "private")
		const puller = await newAccount(wallet, m)
		await landed(() => token().methods.transfer_private_to_public!(shop, shop, 2n * USDC, 0).send(as(shop)))
		await landed(() => token().methods.transfer_public_to_private!(shop, shop, 1n * USDC, 0).send(as(shop)))
		await read(privateOf(shop))
		others.selfShield = await announcedTo(shop)

		const shieldPull = token().methods.transfer_public_to_private!(shop, puller, 1n * USDC, Fr.random())
		const shopWitness = await wallet.createAuthWit(shop, { caller: puller, call: await shieldPull.getFunctionCall() })
		others.shieldPull = await landed(() => shieldPull.send({ ...as(puller), authWitnesses: [shopWitness], additionalScopes: [shop] }))
		await read(privateOf(puller))
		others.puller = await announcedTo(puller)

		const pull = token().methods.transfer_private_to_private!(u, shop, 1n * USDC, Fr.random())
		const userWitness = await wallet.createAuthWit(u, { caller: shop, call: await pull.getFunctionCall() })
		others.pull = await landed(() => pull.send({ ...as(shop), authWitnesses: [userWitness], additionalScopes: [u] }))
		await read(privateOf(shop))
		await read(privateOf(u))
		others.shop = await announcedTo(shop)
		others.user = await announcedTo(u)
	}

	/** Reads the second wallet's balance, then U's announcements, once the step's tx has landed. */
	private async record(name: string): Promise<void> {
		const restored = await this.restoredBalance()
		this.steps.push({ name, restored, announced: await announcedTo(this.u) })
	}

	private restoredBalance(): Promise<bigint> {
		if (!this.restored) throw new Error("the second wallet is not open")
		return l2UsdcBalance(this.restored, harness().manifest, this.u, "private")
	}

	stop = () => this.restored?.stop()
}

describe.skipIf(!INTEGRATION)("who a note's delivery announces", () => {
	const scenario = new Scenario()
	beforeAll(async () => {
		await scenario.run()
		await scenario.runBetweenAccounts()
	}, 900_000)
	afterAll(() => scenario.stop())

	it("[A31] a claim, a payment's change, a send to itself and a private exit announce nothing under the account's address", () => {
		expect(scenario.steps.map((s) => [s.name, s.announced])).toEqual([
			["claim", []],
			["payment", []],
			["send to itself", []],
			["exit", []],
		])
		// The control: the payment's note to the merchant announces exactly one handshake, under the merchant's tag.
		expect(scenario.announced.shopBefore).toEqual([])
		expect(scenario.announced.shopAfterPayment).toEqual([scenario.paymentTx])
	})

	it("[A31] a wallet holding only the account's secret finds every note, with no registerSender", () => {
		expect(scenario.steps.map((s) => [s.name, s.restored])).toEqual([
			["claim", 7n * USDC],
			["payment", 5n * USDC],
			["send to itself", 5n * USDC],
			["exit", 3n * USDC],
		])
		expect(scenario.restoredFunding?.toLowerCase()).toBe(scenario.depositor.toLowerCase())
	})

	it("[A31] a shield to oneself announces nothing; a note pulled by authwit to its caller announces the caller's handshake", () => {
		const { others, paymentTx } = scenario
		expect(others.read).toEqual([1n * USDC, 1n * USDC, 2n * USDC, 2n * USDC])
		expect(others.selfShield).toEqual([paymentTx])
		expect(others.puller).toEqual([others.shieldPull])
		expect([...others.shop].sort()).toEqual([paymentTx, others.pull].sort())
		// The pulled account's change is still a self-delivery.
		expect(others.user).toEqual([])
	})
})
