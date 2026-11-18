import type { WorldItem } from "@galactica-net/inference-money-demo/tour"
import { formatUsdc } from "@/demo/amount"

/** `0x1234…cdef`; anything shorter than an address is shown whole. */
export const shortHex = (v: string): string => (/^0x[0-9a-fA-F]{40,}$/.test(v) ? `${v.slice(0, 6)}…${v.slice(-4)}` : v)

/** A signed USDC amount in base units, as the stage shows it: `+7.00`, `−3.00`, `0.00`. */
export function signedUsdc(v: bigint): string {
	const sign = v > 0n ? "+" : v < 0n ? "−" : ""
	return `${sign}${usdc2(v < 0n ? -v : v)}`
}

/** Two decimals at least, every significant digit kept: `10` → `10.00`, `0.000001` → `0.000001`. */
export function usdc2(v: bigint): string {
	const s = formatUsdc(v)
	const [whole, fraction = ""] = s.split(".")
	return `${whole}.${fraction.padEnd(2, "0")}`
}

const USDC_LABELS = new Set(["amount", "USDC total supply"])

/** Fee juice, Aztec's fee asset, has 18 decimals (its L1 token, symbol FEE, says so). */
const FEE_JUICE = 1e18

/** A fee in fee juice, to four significant digits; display only, so a float is precise enough. */
export const feeJuice = (v: bigint): string => (Number(v) / FEE_JUICE).toLocaleString("en-US", { maximumSignificantDigits: 4 })

/** A public field as the feed shows it: USDC amounts in USDC, times as UTC, addresses shortened. */
export function itemValue(item: WorldItem): string | undefined {
	const v = item.value
	if (v === undefined) return undefined
	if (USDC_LABELS.has(item.label) && /^\d+$/.test(v)) return `${usdc2(BigInt(v))} USDC`
	if (item.label === "fee" && /^\d+$/.test(v)) return `${feeJuice(BigInt(v))} fee juice`
	if (item.label === "expires at" && /^\d+$/.test(v)) return `${new Date(Number(v) * 1000).toISOString().slice(11, 16)} UTC`
	if (/^\d{5,}$/.test(v)) return BigInt(v).toLocaleString("en-US")
	return shortHex(v)
}
