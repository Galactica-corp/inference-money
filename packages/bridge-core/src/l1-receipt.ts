/**
 * `waitForTransactionReceipt` throws its timeout even when the tx is mined (RPC flake, slow inclusion); a flow that
 * dies on that timeout abandons a confirmed deposit. So each timed-out round is followed by a direct receipt read, and
 * only exhausted rounds throw.
 */
export interface L1ReceiptClient<R> {
	waitForTransactionReceipt: (args: { hash: `0x${string}`; timeout?: number }) => Promise<R>
	getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<R>
}

export interface AwaitL1ReceiptOptions {
	/** Default 8 rounds (~12 min at the default round timeout). */
	attempts?: number
	/** Per-round `waitForTransactionReceipt` timeout; default 90 s. */
	attemptTimeoutMs?: number
	onStillWaiting?: (attempt: number) => void
	waitMs?: (ms: number) => Promise<void>
}

const REVERTED = /reverted on-chain/

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface ReadBackOptions {
	/** Default 15 reads. */
	attempts?: number
	/** Between reads; default 2 s. */
	delayMs?: number
	waitMs?: (ms: number) => Promise<void>
}

/**
 * Reads until `settled` holds or the attempts run out, and returns the last read: a load-balanced RPC can answer from
 * a backend behind the block of the receipt it just returned, so one stale read after a receipt proves nothing.
 */
export async function readBack<T>(read: () => Promise<T>, settled: (value: T) => boolean, opts: ReadBackOptions = {}): Promise<T> {
	const attempts = opts.attempts ?? 15
	const wait = opts.waitMs ?? sleep
	let value = await read()
	for (let i = 1; i < attempts && !settled(value); i++) {
		await wait(opts.delayMs ?? 2_000)
		value = await read()
	}
	return value
}

/** A reverted tx also has a receipt, and callers treat any returned receipt as "landed": a revert throws, final. */
function assertNotReverted<R>(receipt: R, hash: `0x${string}`): R {
	if ((receipt as { status?: unknown })?.status === "reverted") {
		throw new Error(`The Ethereum transaction ${hash} reverted on-chain. Nothing was transferred.`)
	}
	return receipt
}

async function probeMinedReceipt<R>(client: L1ReceiptClient<R>, hash: `0x${string}`): Promise<R | undefined> {
	try {
		return await client.getTransactionReceipt({ hash })
	} catch {
		return undefined
	}
}

export async function awaitL1Receipt<R>(client: L1ReceiptClient<R>, hash: `0x${string}`, opts: AwaitL1ReceiptOptions = {}): Promise<R> {
	const attempts = opts.attempts ?? 8
	const attemptTimeoutMs = opts.attemptTimeoutMs ?? 90_000
	const wait = opts.waitMs ?? sleep
	let lastError: unknown
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return assertNotReverted(await client.waitForTransactionReceipt({ hash, timeout: attemptTimeoutMs }), hash)
		} catch (e) {
			if (e instanceof Error && REVERTED.test(e.message)) throw e
			lastError = e
			const mined = await probeMinedReceipt(client, hash)
			if (mined !== undefined) return assertNotReverted(mined, hash)
			opts.onStillWaiting?.(attempt)
			await wait(2_000)
		}
	}
	throw new Error(
		`The Ethereum transaction ${hash} was not confirmed after ${attempts} rounds of waiting. It may still confirm: ` +
			"the deposit is kept, and re-checking finds it without sending a new transaction.",
		{ cause: lastError },
	)
}
