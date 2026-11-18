import { describe, expect, it } from "bun:test"
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { poseidon2HashBytes } from "@aztec-labs/foundation/crypto/sync"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET } from "./claim-secret"
import {
	DOM_SEP__TOKEN_BRIDGE_SPLIT_CHANGE,
	DOM_SEP__TOKEN_BRIDGE_SPLIT_CLAIM,
	DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU,
	DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU_SPENT,
	splitChangeCommitment,
	splitIou,
	splitIouSpent,
	splitSecret,
	splitSecretHash,
} from "./split-secret"
import { DOM_SEP__MERCHANT_REF_PAID, DOM_SEP__MERCHANT_REQUEST_PAID, DOM_SEP__MERCHANT_STAMP, DOM_SEP__MERCHANT_STAMP_PAD } from "./stamp"

// The same literals as contracts/aztec/keystone: a drift strands every split deposit made against the derivation.
describe("split deposits (cross-toolchain vectors)", () => {
	const u32 = (s: string) => Number(poseidon2HashBytes(Buffer.from(s)).toBigInt() & 0xffff_ffffn)

	it("the separators equal their runtime derivations and differ from every other one of ours", () => {
		const split = [
			[DOM_SEP__TOKEN_BRIDGE_SPLIT_CLAIM, "dom_sep__token_bridge_split_claim"],
			[DOM_SEP__TOKEN_BRIDGE_SPLIT_CHANGE, "dom_sep__token_bridge_split_change"],
			[DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU, "dom_sep__token_bridge_split_iou"],
			[DOM_SEP__TOKEN_BRIDGE_SPLIT_IOU_SPENT, "dom_sep__token_bridge_split_iou_spent"],
		] as const
		for (const [value, name] of split) expect<number>(value).toBe(u32(name))
		const all = [
			...split.map(([value]) => value),
			DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET,
			DOM_SEP__MERCHANT_STAMP,
			DOM_SEP__MERCHANT_STAMP_PAD,
			DOM_SEP__MERCHANT_REQUEST_PAID,
			DOM_SEP__MERCHANT_REF_PAID,
		]
		expect(new Set(all).size).toBe(all.length)
	})

	it("derives the keystone's vectors", async () => {
		const changeCommitment = splitChangeCommitment(AztecAddress.fromBigIntUnsafe(0xb0bn), new Fr(0xc4an))
		expect(changeCommitment.toString()).toBe("0x05638567cae588d4788786ca6618f8a0b7defdb2a79d36192f285bc71dd1156c")
		const terms = {
			merchant: AztecAddress.fromBigIntUnsafe(0x1234n),
			price: 370_000n,
			paymentRef: new Fr(0x5eedn),
			changeCommitment,
			salt: new Fr(0x5a17n),
		}
		const secret = splitSecret(terms)
		expect(secret.toString()).toBe("0x0be589ab30a5cf8caa2bf22214569a74cbeb6f2e3c24eb6f7d2387c7904430b5")
		expect((await splitSecretHash(terms)).toString()).toBe("0x1af4aba403e86583e7c58bfa4547816624a1e6e62f4528477326260f88e17f7e")
		const iou = splitIou(changeCommitment, 9_630_000n, EthAddress.fromString("0x000000000000000000000000000000000000d0d0"), secret, 7n)
		expect(iou.toString()).toBe("0x2af308710636feef23eee13508e0c464cc0cfdaa8b6f892c33eceb5e6cb9688d")
		expect(splitIouSpent(iou, new Fr(0xc4an)).toString()).toBe("0x26edfaa45f414c967cff5ba9203bb7dcc3b1067c18b282829fd85c1c1508bf77")
	})
})
