/**
 * The L1 ABI surface bridge-core calls, hand-written so browsers never load forge artifacts. abi.test.ts pins every
 * entry to the compiled contracts (router, portal, Permit2's interface) and to @aztec-foundation/l1-artifacts (Outbox,
 * Registry, Rollup).
 */

/** OpenZeppelin's ECDSA recovery errors: a compact, high-s or unrecoverable signature, refused before Permit2. */
const ECDSA_ERRORS = [
	{ type: "error", name: "ECDSAInvalidSignature", inputs: [] },
	{ type: "error", name: "ECDSAInvalidSignatureLength", inputs: [{ name: "length", type: "uint256" }] },
	{ type: "error", name: "ECDSAInvalidSignatureS", inputs: [{ name: "s", type: "bytes32" }] },
] as const

const PERMIT2_DEPOSIT_ROUTER_ERRORS = [
	{ type: "error", name: "AmountExceedsL2Max", inputs: [] },
	{ type: "error", name: "InexactPull", inputs: [] },
	{ type: "error", name: "NotAContract", inputs: [] },
	{ type: "error", name: "PrivateDepositNamesRecipient", inputs: [] },
	{ type: "error", name: "PublicDepositNeedsRecipient", inputs: [] },
	{ type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
	{ type: "error", name: "ResidualBalance", inputs: [] },
	{ type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
	{ type: "error", name: "SignerIsNotTheCaller", inputs: [] },
	{ type: "error", name: "ZeroAmount", inputs: [] },
	...ECDSA_ERRORS,
] as const

/**
 * The two Permit2 signature errors a deposit can surface; they decode only when Permit2 raises them itself (a 7702
 * delegate returning the wrong magic value). A delegate with no `isValidSignature`, or one that reverts, fails with
 * its own revert, often empty. abi.test.ts pins both selectors.
 */
export const PERMIT2_SIGNATURE_ERRORS = [
	{ type: "error", name: "InvalidContractSignature", inputs: [] },
	{ type: "error", name: "InvalidSigner", inputs: [] },
] as const

/** The portal's refusals a router deposit bubbles that the router never raises itself; abi.test.ts pins them to the portal. */
export const PORTAL_BUBBLED_ERRORS = [{ type: "error", name: "RollupNotCanonical", inputs: [] }] as const

export const PERMIT2_DEPOSIT_ROUTER_ABI = [
	{
		type: "function",
		name: "deposit",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "amount", type: "uint256" },
			{ name: "aztecRecipient", type: "bytes32" },
			{ name: "secretHash", type: "bytes32" },
			{ name: "isPrivate", type: "bool" },
			{ name: "nonce", type: "uint256" },
			{ name: "deadline", type: "uint256" },
			{ name: "signature", type: "bytes" },
		],
		outputs: [
			{ name: "key", type: "bytes32" },
			{ name: "index", type: "uint256" },
		],
	},
	{
		type: "event",
		name: "Deposit",
		anonymous: false,
		inputs: [
			{ name: "depositor", type: "address", indexed: true },
			{ name: "aztecRecipient", type: "bytes32", indexed: true },
			{ name: "key", type: "bytes32", indexed: false },
			{ name: "index", type: "uint256", indexed: false },
			{ name: "amount", type: "uint256", indexed: false },
			{ name: "secretHash", type: "bytes32", indexed: false },
			{ name: "isPrivate", type: "bool", indexed: false },
		],
	},
	{ type: "function", name: "PERMIT2", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "PORTAL", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "TOKEN", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	...PERMIT2_DEPOSIT_ROUTER_ERRORS,
	...PERMIT2_SIGNATURE_ERRORS,
	...PORTAL_BUBBLED_ERRORS,
] as const

/** Permit2's unordered nonces: bit `nonce & 0xff` of word `nonce >> 8` is set once a permit with that nonce is used. */
export const PERMIT2_NONCE_ABI = [
	{
		type: "function",
		name: "nonceBitmap",
		stateMutability: "view",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "wordPos", type: "uint256" },
		],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const

const view = <const N extends string, const T extends string>(name: N, type: T) =>
	({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type }] }) as const

// The portal's withdraw reverts with the Outbox's errors, so they are listed here for decoding too.
const OUTBOX_CONSUME_ERRORS = [
	{
		type: "error",
		name: "Outbox__AlreadyNullified",
		inputs: [
			{ name: "epoch", type: "uint256" },
			{ name: "leafIndex", type: "uint256" },
		],
	},
	{ type: "error", name: "Outbox__NothingToConsumeAtEpoch", inputs: [{ name: "epoch", type: "uint256" }] },
	{ type: "error", name: "Outbox__InvalidNumCheckpointsInEpoch", inputs: [{ name: "numCheckpointsInEpoch", type: "uint256" }] },
	{
		type: "error",
		name: "Outbox__LeafIndexOutOfBounds",
		inputs: [
			{ name: "leafIndex", type: "uint256" },
			{ name: "pathLength", type: "uint256" },
		],
	},
	{ type: "error", name: "Outbox__PathTooLong", inputs: [] },
	{
		type: "error",
		name: "MerkleLib__InvalidRoot",
		inputs: [
			{ name: "expected", type: "bytes32" },
			{ name: "actual", type: "bytes32" },
			{ name: "leaf", type: "bytes32" },
			{ name: "leafIndex", type: "uint256" },
		],
	},
	{ type: "error", name: "MerkleLib__InvalidIndexForPathLength", inputs: [] },
] as const

const DEPOSIT_OUTPUTS = [
	{ name: "", type: "bytes32" },
	{ name: "", type: "uint256" },
] as const

/** The portal's deposits, for integrators calling it directly; bridge-core's own flow goes through the router. */
const PORTAL_DEPOSIT_ABI = [
	{
		type: "function",
		name: "depositToAztecPublic",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_depositor", type: "address" },
			{ name: "_to", type: "bytes32" },
			{ name: "_amount", type: "uint256" },
			{ name: "_secretHash", type: "bytes32" },
		],
		outputs: DEPOSIT_OUTPUTS,
	},
	{
		type: "function",
		name: "depositToAztecPrivate",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_depositor", type: "address" },
			{ name: "_amount", type: "uint256" },
			{ name: "_secretHashForL2MessageConsumption", type: "bytes32" },
			{ name: "_deadline", type: "uint256" },
			{ name: "_signature", type: "bytes" },
		],
		outputs: DEPOSIT_OUTPUTS,
	},
	{
		type: "function",
		name: "depositToAztecPublicFor",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_depositor", type: "address" },
			{ name: "_to", type: "bytes32" },
			{ name: "_amount", type: "uint256" },
			{ name: "_secretHash", type: "bytes32" },
		],
		outputs: DEPOSIT_OUTPUTS,
	},
	{
		type: "function",
		name: "depositToAztecPrivateFor",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_depositor", type: "address" },
			{ name: "_amount", type: "uint256" },
			{ name: "_secretHashForL2MessageConsumption", type: "bytes32" },
		],
		outputs: DEPOSIT_OUTPUTS,
	},
	{
		type: "function",
		name: "fundingAuthorizationDigest",
		stateMutability: "view",
		inputs: [
			{ name: "_depositor", type: "address" },
			{ name: "_submitter", type: "address" },
			{ name: "_amount", type: "uint256" },
			{ name: "_secretHash", type: "bytes32" },
			{ name: "_deadline", type: "uint256" },
		],
		outputs: [{ name: "", type: "bytes32" }],
	},
	{
		type: "function",
		name: "authorizationUsed",
		stateMutability: "view",
		inputs: [{ name: "digest", type: "bytes32" }],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "eip712Domain",
		stateMutability: "view",
		inputs: [],
		outputs: [
			{ name: "fields", type: "bytes1" },
			{ name: "name", type: "string" },
			{ name: "version", type: "string" },
			{ name: "chainId", type: "uint256" },
			{ name: "verifyingContract", type: "address" },
			{ name: "salt", type: "bytes32" },
			{ name: "extensions", type: "uint256[]" },
		],
	},
	{
		type: "event",
		name: "DepositToAztecPublic",
		inputs: [
			{ name: "depositor", type: "address", indexed: true },
			{ name: "to", type: "bytes32", indexed: false },
			{ name: "amount", type: "uint256", indexed: false },
			{ name: "secretHash", type: "bytes32", indexed: false },
			{ name: "key", type: "bytes32", indexed: false },
			{ name: "index", type: "uint256", indexed: false },
		],
	},
	{
		type: "event",
		name: "DepositToAztecPrivate",
		inputs: [
			{ name: "depositor", type: "address", indexed: true },
			{ name: "amount", type: "uint256", indexed: false },
			{ name: "secretHashForL2MessageConsumption", type: "bytes32", indexed: false },
			{ name: "key", type: "bytes32", indexed: false },
			{ name: "index", type: "uint256", indexed: false },
		],
	},
] as const

export const TOKEN_PORTAL_ABI = [
	{
		type: "function",
		name: "withdraw",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_recipient", type: "address" },
			{ name: "_amount", type: "uint256" },
			{ name: "_withCaller", type: "bool" },
			{ name: "_epoch", type: "uint256" },
			{ name: "_numCheckpointsInEpoch", type: "uint256" },
			{ name: "_leafIndex", type: "uint256" },
			{ name: "_path", type: "bytes32[]" },
		],
		outputs: [],
	},
	view("registry", "address"),
	view("underlying", "address"),
	view("l2Bridge", "bytes32"),
	view("rollupVersion", "uint256"),
	view("initializer", "address"),
	view("rollup", "address"),
	view("inbox", "address"),
	view("outbox", "address"),
	{
		type: "event",
		name: "PortalInitialized",
		inputs: [
			{ name: "registry", type: "address", indexed: false },
			{ name: "underlying", type: "address", indexed: true },
			{ name: "l2Bridge", type: "bytes32", indexed: false },
			{ name: "router", type: "address", indexed: false },
			{ name: "rollup", type: "address", indexed: false },
			{ name: "inbox", type: "address", indexed: false },
			{ name: "outbox", type: "address", indexed: false },
			{ name: "rollupVersion", type: "uint256", indexed: false },
		],
	},
	{
		type: "event",
		name: "Withdraw",
		inputs: [
			{ name: "recipient", type: "address", indexed: true },
			{ name: "amount", type: "uint256", indexed: false },
			{ name: "callerOnL1", type: "address", indexed: false },
		],
	},
	...PORTAL_DEPOSIT_ABI,
	{ type: "error", name: "AmountExceedsL2Max", inputs: [] },
	{ type: "error", name: "RecipientExceedsFieldMax", inputs: [] },
	{ type: "error", name: "InexactTransfer", inputs: [] },
	{ type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
	{ type: "error", name: "ZeroAmount", inputs: [] },
	...PORTAL_BUBBLED_ERRORS,
	{ type: "error", name: "InvalidDepositor", inputs: [] },
	{ type: "error", name: "NotRouter", inputs: [] },
	{ type: "error", name: "AuthorizationExpired", inputs: [{ name: "deadline", type: "uint256" }] },
	{ type: "error", name: "AuthorizationUsed", inputs: [] },
	{ type: "error", name: "SignerIsNotTheDepositor", inputs: [] },
	...ECDSA_ERRORS,
	...OUTBOX_CONSUME_ERRORS,
] as const

export const OUTBOX_ABI = [
	{
		type: "function",
		name: "getRoots",
		stateMutability: "view",
		inputs: [{ name: "_epoch", type: "uint256" }],
		outputs: [{ name: "", type: "bytes32[32]" }],
	},
	{
		type: "function",
		name: "hasMessageBeenConsumedAtEpoch",
		stateMutability: "view",
		inputs: [
			{ name: "_epoch", type: "uint256" },
			{ name: "_leafId", type: "uint256" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "event",
		name: "MessageConsumed",
		inputs: [
			{ name: "epoch", type: "uint256", indexed: true },
			{ name: "root", type: "bytes32", indexed: true },
			{ name: "messageHash", type: "bytes32", indexed: true },
			{ name: "leafId", type: "uint256", indexed: false },
			{ name: "numCheckpointsInEpoch", type: "uint256", indexed: false },
		],
	},
] as const

export const REGISTRY_ABI = [view("getCanonicalRollup", "address")] as const
