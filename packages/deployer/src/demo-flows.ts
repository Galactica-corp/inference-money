import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { registerSponsor, sponsoredPayment } from "@galactica-net/inference-money-core"
import { ensureAccount, startBlockHeartbeat } from "@galactica-net/inference-money-core/deploy"
import { type Actor, type CastKeys, type CastMember, castMember, demoDigest } from "@galactica-net/inference-money-demo"
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

/** The cast's Aztec secrets derive from the published demo's keys, so enlisting needs them. */
export async function enlist<A extends Actor>(s: Session, actors: readonly A[], keys: CastKeys): Promise<Record<A, Player>> {
	const players = {} as Record<A, Player>
	for (const actor of actors) {
		const member = castMember(s.m, actor, keys)
		players[actor] = { ...member, address: await accountFor(s.wallet, member.secret) }
	}
	return players
}

const sponsoredDeploy = (s: Session) => ({ accountDeploy: async () => sponsoredPayment(s.m) })

export async function deployPlayers(s: Session, players: readonly Player[], log: Log): Promise<void> {
	for (const p of players) await ensureAccount(s.wallet, p.secret, sponsoredDeploy(s), log, p.actor)
}

/**
 * The account that sends `demo fund`'s Fee Juice claim, deployed unless someone already has: derived from the
 * deployment alone, so it needs no published demo, and it is no cast member and never holds USDC.
 */
export function sponsorClaimer(s: Session, log: Log): Promise<AztecAddress> {
	const secret = new Fr(demoDigest(`${s.m.l2.bridge.address}/sponsor-claimer/aztec`) % Fr.MODULUS)
	return ensureAccount(s.wallet, secret, sponsoredDeploy(s), log, "sponsor claimer")
}

/** A claim's wait, logged as the operator CLI reports progress. */
export const logWait = (log: Log) => (w: string) => log(`  ${w}`)
