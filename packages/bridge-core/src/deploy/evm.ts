import type { Abi, Hex } from "viem"

export interface EvmArtifact {
	abi: Abi
	bytecode: Hex
	deployedBytecode: Hex
	/** Byte ranges of the runtime code that the constructor fills with immutables. */
	immutableRanges: { start: number; length: number }[]
}

/** The contracts a deploy and its verification use. */
export interface BridgeEvmArtifacts {
	portal: EvmArtifact
	router: EvmArtifact
	mockUsdc: EvmArtifact
}

/** Where forge writes each one under its out dir: `<source>/<name>.json`. */
export const BRIDGE_EVM_SOURCES = {
	portal: { source: "TokenPortal.sol", name: "TokenPortal" },
	router: { source: "Permit2DepositRouter.sol", name: "Permit2DepositRouter" },
	mockUsdc: { source: "MockUsdc.sol", name: "MockUsdc" },
} as const satisfies Record<keyof BridgeEvmArtifacts, { source: string; name: string }>

/** The fields a deploy needs out of one forge artifact. */
export function evmArtifactFromForge(raw: unknown): EvmArtifact {
	const r = raw as {
		abi: Abi
		bytecode: { object: Hex }
		deployedBytecode: { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> }
	}
	return {
		abi: r.abi,
		bytecode: r.bytecode.object,
		deployedBytecode: r.deployedBytecode.object,
		immutableRanges: Object.values(r.deployedBytecode.immutableReferences ?? {}).flat(),
	}
}
