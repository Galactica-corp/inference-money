import { describe, expect, it, vi } from "vitest"
import { browserPaymentStore, localKeyValue, UnsavedRecordError } from "./store"
import { tickets } from "./tickets"

/** The page's storage, but refusing every write, as a full quota or blocked site data does. */
const fullStorage = (): Storage => {
	const refuse = () => {
		throw new DOMException("quota", "QuotaExceededError")
	}
	return {
		get length() {
			return localStorage.length
		},
		key: (i) => localStorage.key(i),
		getItem: (k) => localStorage.getItem(k),
		setItem: refuse,
		removeItem: refuse,
		clear: refuse,
	}
}

describe("browser stores", () => {
	it("keep each deployment's records apart, survive a new store on the same storage, and keep a failed write for the page", () => {
		const a = localKeyValue("im/a/")
		a.set("x", "1")
		expect(localKeyValue("im/a/").get("x")).toBe("1")
		expect(localKeyValue("im/b/").get("x")).toBeUndefined()
		const full = localKeyValue("im/a/", fullStorage())
		expect(full.set("y", "2")).toBe(false)
		expect([full.get("y"), localKeyValue("im/a/").get("y")]).toEqual(["2", undefined])
		expect(full.keys().sort()).toEqual(["x", "y"])
	})

	it("hold a payment record across a reload, and lock through Web Locks when the browser has them", async () => {
		const held: string[] = []
		const request = async (name: string, fn: () => Promise<unknown>) => {
			held.push(name)
			return fn()
		}
		const locks = { request } as unknown as LockManager
		const store = browserPaymentStore(localKeyValue("im/a/"), locks)
		await store.locked("k", () => store.put("k", { state: "sent", owner: "o", txHash: "0x1", expiresAt: "9" }))
		expect(held).toEqual(["payment:k"])
		expect(await browserPaymentStore(localKeyValue("im/a/"), undefined).get("k")).toEqual({
			state: "sent",
			owner: "o",
			txHash: "0x1",
			expiresAt: "9",
		})
	})

	it("list pending deposits and exits oldest first, and skip an entry that no longer parses as one", () => {
		const kv = localKeyValue("im/a/")
		const t = tickets(kv)
		t.putExit({ id: "e2", actor: "alice", since: 2, ticket: "t2" })
		t.putExit({ id: "e1", actor: "bob", since: 1, ticket: "t1" })
		kv.set("exit:broken", "{")
		kv.set("exit:null", "null")
		kv.set("exit:undated", JSON.stringify({ id: "u", actor: "alice", ticket: "t" }))
		const sent = { l2TxHash: `0x${"12".repeat(32)}`, recipient: `0x${"ab".repeat(20)}`, amount: "oops", expiresAt: "9" }
		kv.set("exit:unpriced", JSON.stringify({ id: "x", actor: "alice", since: 0, sent }))
		t.putDeposit({ id: "d1", user: "alice", since: 3, draft: "d" })
		t.putDeposit({ id: "d2", user: "bob", since: 4, draft: "d", archived: true })
		t.putDeposit({ id: "d3", user: "bob", since: 5, claim: "c", claimed: true, final: true })
		expect(t.exits().map((e) => e.id)).toEqual(["e1", "e2"])
		t.dropExit("e1")
		expect(t.exits().map((e) => e.id)).toEqual(["e2"])
		expect(t.deposits()).toEqual([
			{ id: "d1", user: "alice", since: 3, draft: "d" },
			{ id: "d2", user: "bob", since: 4, draft: "d", archived: true },
			{ id: "d3", user: "bob", since: 5, claim: "c", claimed: true, final: true },
		])
	})

	it("refuse a send's record that a reload would lose, before the send leaves, while releases still go through", async () => {
		const kv = localKeyValue("im/full/", fullStorage())
		const t = tickets(kv)
		expect(() => t.putDeposit({ id: "d", user: "alice", since: 0, draft: "d" })).toThrow(UnsavedRecordError)
		expect(() => t.putExit({ id: "e", actor: "alice", since: 0 })).toThrow(UnsavedRecordError)
		const payments = browserPaymentStore(kv, undefined)
		const sent = { state: "sent", owner: "o", txHash: "0x1", expiresAt: "9" } as const
		await expect(payments.put("k", sent)).rejects.toThrow(UnsavedRecordError)
		await payments.put("k", undefined)
		t.dropExit("e")
		expect([t.deposits(), t.exits(), await payments.get("k")]).toEqual([[], [], undefined])
	})

	it("keep working in memory when reading localStorage itself throws, as with site data blocked", () => {
		const denied = vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError")
		})
		try {
			const kv = localKeyValue("im/blocked/")
			kv.set("x", "1")
			expect([kv.get("x"), kv.keys()]).toEqual(["1", ["x"]])
		} finally {
			denied.mockRestore()
		}
	})
})
