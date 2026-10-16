import { Fr } from "@aztec-labs/aztec.js/fields"

// With SEED in the process environment, the Aztec foundation draws every random value from a 32-bit counter, the PXE's
// note randomness and the keys that encrypt note logs included. A browser has no SEED. Read through `globalThis`: the
// showcase's polyfill rewrites a bare `process` into an import this package cannot resolve.
if (globalThis.process?.env?.SEED) {
	throw new Error(
		"SEED is set, which makes the Aztec SDK's randomness predictable and every note this process creates readable: unset it before loading bridge-core",
	)
}

/** A uniform field element from the platform CSPRNG, for anything that must stay secret; never `Fr.random()`. */
export function randomSecret(): Fr {
	return Fr.fromBufferReduce(Buffer.from(crypto.getRandomValues(new Uint8Array(64))))
}
