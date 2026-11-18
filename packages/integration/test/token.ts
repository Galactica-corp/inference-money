import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import type { TxReceipt } from "@aztec-labs/aztec.js/tx"
import { type MerchantList, sponsoredPayment, syncMerchantList, tokenArtifact } from "@galactica-net/inference-money-core"
import { harness } from "./harness"

export const tokenAddress = () => AztecAddress.fromStringUnsafe(harness().manifest.l2.token.address)
export const token = () => Contract.at(tokenAddress(), tokenArtifact, harness().wallet)
export const sponsored = () => ({ paymentMethod: sponsoredPayment(harness().manifest) })

/** Sends as `from`, paid by the sponsor (test accounts hold no Fee Juice). */
export const as = (from: AztecAddress) => ({ from, fee: sponsored() })

/** As the merchant admin, which a local deploy hands to the local admin. */
export const asAdmin = () => as(harness().owner)

export async function listMerchant(account: AztecAddress): Promise<void> {
	await token().methods.add_merchant!(account).send(asAdmin())
}

export const merchantList = (): Promise<MerchantList> => syncMerchantList(harness().node, tokenAddress())

/** The timestamp of the block `receipt`'s tx landed in. */
export async function blockTimestamp(receipt: TxReceipt): Promise<bigint> {
	if (receipt.blockNumber === undefined) throw new Error(`tx ${receipt.txHash} is not mined`)
	const data = await harness().node.getBlockData(receipt.blockNumber)
	if (!data) throw new Error(`no block ${receipt.blockNumber}`)
	return data.header.globalVariables.timestamp
}
