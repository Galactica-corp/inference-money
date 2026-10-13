import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { publishContractClass, publishInstance } from "@aztec-labs/aztec.js/deployment"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { getPublishableStandardContracts } from "@aztec-labs/standard-contracts"

/**
 * Publishes the standard contracts aztec-nr reaches in public (AuthRegistry, PublicChecks, HandshakeRegistry) wherever
 * the node lacks them: neither a local network (AuthRegistry only) nor testnet seeds them all, and without them a
 * public authwit, which the public exit's burn consumes, could never be checked.
 */
export async function ensureStandardContracts(
	wallet: Wallet,
	node: Pick<AztecNode, "getContract" | "getContractClass">,
	send: { from: AztecAddress; fee?: { paymentMethod: FeePaymentMethod } },
	log: (m: string) => void,
): Promise<AztecAddress[]> {
	const published: AztecAddress[] = []
	for (const c of await getPublishableStandardContracts()) {
		if (await node.getContract(c.address)) continue
		if (!(await node.getContractClass(c.instance.currentContractClassId))) {
			log(`publishing class ${c.artifact.name}`)
			await (await publishContractClass(wallet, c.artifact)).send(send)
		}
		log(`publishing ${c.artifact.name} at ${c.address}`)
		await publishInstance(wallet, c.instance).send(send)
		published.push(c.address)
	}
	return published
}

/** The standard contracts the bridge's L2 contracts need published. */
export async function standardContractAddresses(): Promise<{ name: string; address: AztecAddress }[]> {
	return (await getPublishableStandardContracts()).map((c) => ({ name: c.artifact.name, address: c.address }))
}
