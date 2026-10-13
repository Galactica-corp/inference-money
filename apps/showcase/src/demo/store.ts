import type { PaymentRecord, PaymentStore } from "@galactica-net/inference-money-core"

/** String values under one prefix. Storage can be absent or throw (private windows, quota, blocked site data). */
export interface KeyValue {
	get(key: string): string | undefined
	/** False when the write is kept only in this page's memory, which a reload loses. */
	set(key: string, value: string | undefined): boolean
	keys(): string[]
}

/** A send's recovery record would not survive a reload, so the page could neither resume the send nor stop a repeat. */
export class UnsavedRecordError extends Error {
	constructor() {
		super(
			"This browser isn't saving this page's data, so the page stopped rather than lose track of what it sends. Allow site data for this page, or leave private browsing, then try again.",
		)
		this.name = "UnsavedRecordError"
	}
}

/** Writes a record a send depends on, or leaves the key as it was and throws, so the send never leaves. */
export function setDurably(kv: KeyValue, key: string, value: string): void {
	const before = kv.get(key)
	if (kv.set(key, value)) return
	kv.set(key, before)
	throw new UnsavedRecordError()
}

/**
 * `localStorage` under `prefix`, the source of truth while it works (other tabs write it too). A key whose last write
 * failed (no storage, quota, blocked site data) is kept in memory instead, so nothing this page wrote reads back as
 * absent before a reload.
 */
export function localKeyValue(prefix: string, storage?: Storage): KeyValue {
	const unsaved = new Map<string, string | undefined>()
	const attempt = <T>(fn: (s: Storage) => T, fallback: T): T => {
		try {
			// Read here, inside the catch: with site data blocked, the `localStorage` getter itself throws.
			const s = storage ?? globalThis.localStorage
			return s ? fn(s) : fallback
		} catch {
			return fallback
		}
	}
	const stored = (): string[] =>
		attempt((s) => {
			const out: string[] = []
			for (let i = 0; i < s.length; i++) {
				const k = s.key(i)
				if (k?.startsWith(prefix)) out.push(k.slice(prefix.length))
			}
			return out
		}, [])
	return {
		get: (key) => (unsaved.has(key) ? unsaved.get(key) : attempt((s) => s.getItem(prefix + key) ?? undefined, undefined)),
		set: (key, value) => {
			const saved = attempt((s) => {
				if (value === undefined) s.removeItem(prefix + key)
				else s.setItem(prefix + key, value)
				return true
			}, false)
			if (saved) unsaved.delete(key)
			else unsaved.set(key, value)
			return saved
		},
		keys: () => {
			const all = new Set([...stored(), ...unsaved.keys()])
			return [...all].filter((k) => !unsaved.has(k) || unsaved.get(k) !== undefined)
		},
	}
}

/** One promise chain per key: exclusive within this page, which is all a browser without Web Locks offers. */
function pageLocks(): (key: string, fn: () => Promise<unknown>) => Promise<unknown> {
	const tails = new Map<string, Promise<unknown>>()
	return (key, fn) => {
		const run = (tails.get(key) ?? Promise.resolve()).then(fn)
		tails.set(
			key,
			run.catch(() => undefined),
		)
		return run
	}
}

/**
 * Payment records that survive a reload, so a payment sent before it is never sent again. Web Locks make each
 * request's read-modify-write exclusive across this browser's tabs.
 */
export function browserPaymentStore(kv: KeyValue, locks: LockManager | undefined = globalThis.navigator?.locks): PaymentStore {
	const local = pageLocks()
	return {
		locked: <T>(key: string, fn: () => Promise<T>): Promise<T> =>
			(locks ? locks.request(`payment:${key}`, fn) : local(key, fn)) as Promise<T>,
		get: async (key) => {
			const raw = kv.get(`payment:${key}`)
			return raw === undefined ? undefined : (JSON.parse(raw) as PaymentRecord)
		},
		put: async (key, record) => {
			if (record === undefined) kv.set(`payment:${key}`, undefined)
			else setDurably(kv, `payment:${key}`, JSON.stringify(record))
		},
	}
}
