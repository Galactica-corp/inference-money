import { ACTORS, USERS } from "@galactica-net/inference-money-demo"
import { z } from "zod"
import { type KeyValue, setDurably } from "./store"

const digits = z.string().regex(/^\d+$/)

const pendingDepositSchema = z.strictObject({
	id: z.string(),
	user: z.enum(USERS),
	since: z.number(),
	/** `encodeTicket("draft", …)`, kept from the moment it may be broadcast, so a reload never deposits twice. */
	draft: z.string().optional(),
	/** `encodeTicket("claim", …)`. */
	claim: z.string().optional(),
	/** Claimed at a proposed block, and kept until the claim is final: a prune undoes it, and only this secret claims again. */
	claimed: z.literal(true).optional(),
})

const pendingExitSchema = z.strictObject({
	id: z.string(),
	actor: z.enum(ACTORS),
	since: z.number(),
	/** The burn as it left for the node, before any response: the withdrawal is located from it after a reload. */
	sent: z
		.strictObject({
			l2TxHash: z.string().regex(/^0x[0-9a-f]{64}$/),
			recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
			amount: digits,
			expiresAt: digits,
		})
		.optional(),
	/** `encodeTicket("exit", …)`, once the withdrawal is located. */
	ticket: z.string().optional(),
})

/** A deposit this page sent: its draft until it mines, then its claim ticket until the claim is final. */
export type PendingDeposit = z.infer<typeof pendingDepositSchema>
/** An exit this page sent, until its withdrawal pays out on Ethereum. */
export type PendingExit = z.infer<typeof pendingExitSchema>

/** The page's unfinished cross-chain steps, which a reload resumes. */
export interface Tickets {
	deposits(): PendingDeposit[]
	/** Throws `UnsavedRecordError` when the record would not survive a reload. */
	putDeposit(d: PendingDeposit): void
	dropDeposit(id: string): void
	exits(): PendingExit[]
	/** Throws `UnsavedRecordError` when the record would not survive a reload. */
	putExit(e: PendingExit): void
	dropExit(id: string): void
}

/** Oldest first; an entry that no longer parses as one is skipped, never thrown. */
function read<T extends { since: number }>(kv: KeyValue, kind: string, schema: z.ZodType<T>): T[] {
	return kv
		.keys()
		.filter((k) => k.startsWith(`${kind}:`))
		.flatMap((k) => {
			try {
				const parsed = schema.safeParse(JSON.parse(kv.get(k) ?? "null"))
				return parsed.success ? [parsed.data] : []
			} catch {
				return []
			}
		})
		.sort((a, b) => a.since - b.since)
}

export function tickets(kv: KeyValue): Tickets {
	return {
		deposits: () => read(kv, "deposit", pendingDepositSchema),
		putDeposit: (d) => setDurably(kv, `deposit:${d.id}`, JSON.stringify(d)),
		dropDeposit: (id) => {
			kv.set(`deposit:${id}`, undefined)
		},
		exits: () => read(kv, "exit", pendingExitSchema),
		putExit: (e) => setDurably(kv, `exit:${e.id}`, JSON.stringify(e)),
		dropExit: (id) => {
			kv.set(`exit:${id}`, undefined)
		},
	}
}
