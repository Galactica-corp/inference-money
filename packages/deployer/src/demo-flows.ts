import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { registerSponsor, sponsoredPayment } from "@galactica-net/inference-money-core"
import { ensureAccount, startBlockHeartbeat } from "@galactica-net/inference-money-core/deploy"
import { type Actor, type CastMember, castMember } from "@galactica-net/inference-money-demo"
import { accountFor, type Session } from "./session"
import { openBridgeWallet } from "./wallet"

export type Log = (m: string) => void

/**
 * On local, a command that consumes an L1→L2 message beats its own blocks, since none come without traffic. The beats
 * come from a second wallet, so the session's record of what it sent holds only its own txs.
 */
export async function withHeartbeat<T>(s: Session, fn: () => Promise<T>): Promise<T> {
	if (s.m.network !== "local") return fn()
	const wallet = await openBridgeWallet(createAztecNodeClient(s.endpoints.nodeUrl), { prove: false })
	try {
		await registerSponsor(wallet, s.m)
		const stop = await startBlockHeartbeat(wallet, s.m)
		try {
			return await fn()
		} finally {
			await stop()
		}
	} finally {
		await wallet.stop()
	}
}

/** A cast member registered in a session's wallet, which can therefore sign as it. */
export interface Player extends CastMember {
	address: AztecAddress
}

/** Users' secrets derive from the users' tag, so enlisting one needs it. */
export async function enlist<A extends Actor>(s: Session, actors: readonly A[], tag?: string): Promise<Record<A, Player>> {
	const players = {} as Record<A, Player>
	for (const actor of actors) {
		const member = castMember(s.m, actor, tag)
		players[actor] = { ...member, address: await accountFor(s.wallet, member.secret) }
	}
	return players
}

export async function deployPlayers(s: Session, players: readonly Player[], log: Log): Promise<void> {
	const fees = { accountDeploy: async () => sponsoredPayment(s.m) }
	for (const p of players) await ensureAccount(s.wallet, p.secret, fees, log, p.actor)
}

/** A claim's wait, logged as the operator CLI reports progress. */
export const logWait = (log: Log) => (w: string) => log(`  ${w}`)
