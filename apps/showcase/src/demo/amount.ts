import { MAX_L2_AMOUNT } from "@galactica-net/inference-money-core/types"

export const USDC_DECIMALS = 6
const UNIT = 10n ** BigInt(USDC_DECIMALS)

export type AmountResult = { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly error: string }

/**
 * Typed text to base units, exactly: digits with at most one decimal point and six decimals. No sign, exponent,
 * grouping or rounding, so what the user typed is what gets signed.
 */
export function parseUsdc(text: string): AmountResult {
	const t = text.trim()
	if (t === "") return { ok: false, error: "Enter an amount." }
	if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: "Use digits and at most one decimal point, like 12.5." }
	const [whole = "0", fraction = ""] = t.split(".")
	if (fraction.length > USDC_DECIMALS) return { ok: false, error: "USDC has at most 6 decimal places." }
	const value = BigInt(whole) * UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, "0"))
	if (value === 0n) return { ok: false, error: "The amount must be more than zero." }
	if (value > MAX_L2_AMOUNT) return { ok: false, error: "That amount is too large to bridge." }
	return { ok: true, value }
}

/** Every digit, never rounded: `1234567` base units read `1.234567`, `1000000` reads `1`. */
export function formatUsdc(value: bigint): string {
	const whole = (value / UNIT).toLocaleString("en-US")
	const fraction = (value % UNIT).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "")
	return fraction ? `${whole}.${fraction}` : whole
}
