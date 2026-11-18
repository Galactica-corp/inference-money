import { spawn } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import { WALLET_TMP_ROOT } from "./owned-tmp"

/** Set in the child's env only; never a secret. */
export const REDACTED_CHILD = "INFERENCE_MONEY_REDACTED_CHILD"

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function redact(text: string, needles: string[]): string {
	return needles.reduce((out, n) => out.replace(new RegExp(escapeRegExp(n), "gi"), "[redacted]"), text)
}

/** Secrets hold no newline, so redacting whole lines never lets one straddle two writes. */
function pipeRedacted(from: Readable, to: Writable, needles: string[]): Promise<void> {
	let pending = ""
	from.setEncoding("utf8")
	from.on("data", (chunk: string) => {
		const lines = (pending + chunk).split("\n")
		pending = lines.pop() ?? ""
		if (lines.length > 0) to.write(redact(`${lines.join("\n")}\n`, needles))
	})
	return new Promise((done) =>
		from.on("end", () => {
			if (pending) to.write(redact(pending, needles))
			done()
		}),
	)
}

const GRACE_MS = 5_000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Whether the signal reached a member of the group; signal 0 only probes. */
function signalGroup(pgid: number, sig: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pgid, sig)
		return true
	} catch {
		return false
	}
}

async function groupGone(pgid: number): Promise<boolean> {
	for (const end = Date.now() + GRACE_MS; Date.now() < end; await sleep(100)) if (!signalGroup(pgid, 0)) return true
	return false
}

/**
 * SIGTERM, then SIGKILL for whatever outlives the grace period. Done once the group is empty, or a grace period after
 * the SIGKILL: a member still dying then (blocked in uninterruptible I/O) runs no more user code.
 */
async function reapGroup(pgid: number): Promise<void> {
	signalGroup(pgid, "SIGTERM")
	if (await groupGone(pgid)) return
	signalGroup(pgid, "SIGKILL")
	await groupGone(pgid)
}

/**
 * Runs `argv` under this runtime with stdout and stderr redacted line by line. Dependency loggers write to the fds
 * directly, so only a pipe catches everything; the child takes its secrets from `env`, never from argv. The child
 * leads its own process group, which is reaped on cancellation and after the child exits: a surviving descendant (a
 * prover, a build) would keep running, and could hold the pipes open. Once the group is reaped, the child's wallet dir
 * under `walletRoot` is removed: its store holds the account secret the child rebuilt, and a child killed by a signal
 * never reaches its own cleanup. The child never loads a `.env` file: it would read the one its parent was started
 * without.
 */
export async function runRedacted(
	argv: string[],
	needles: string[],
	out: Writable = process.stdout,
	err: Writable = process.stderr,
	env: NodeJS.ProcessEnv = process.env,
	walletRoot = WALLET_TMP_ROOT,
): Promise<number> {
	const childEnv = { ...env, [REDACTED_CHILD]: "1" }
	const child = spawn(process.execPath, ["--no-env-file", ...argv], { env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true })
	let reaping: Promise<void> | undefined
	const reap = () => {
		reaping ??= child.pid === undefined ? Promise.resolve() : reapGroup(child.pid)
		return reaping
	}
	const reapAndRemoveStore = async () => {
		await reap()
		if (child.pid !== undefined) rmSync(join(walletRoot, String(child.pid)), { recursive: true, force: true })
	}
	process.on("SIGINT", reap).on("SIGTERM", reap)
	try {
		const piped = Promise.all([pipeRedacted(child.stdout, out, needles), pipeRedacted(child.stderr, err, needles)])
		const code = await new Promise<number>((done, fail) => child.once("exit", (c) => done(c ?? 1)).once("error", fail))
		await reapAndRemoveStore()
		await Promise.race([piped, sleep(GRACE_MS)])
		return code
	} catch (e) {
		await reapAndRemoveStore()
		throw e
	} finally {
		process.off("SIGINT", reap).off("SIGTERM", reap)
		child.stdout.destroy()
		child.stderr.destroy()
	}
}

/** An error and its causes, one line each: the CLI's only error output. */
export function describeError(e: unknown): string {
	const lines: string[] = []
	for (let c: unknown = e, depth = 0; c !== undefined && depth < 8; depth++) {
		lines.push(c instanceof Error ? `${c.name}: ${c.message}` : String(c))
		c = c instanceof Error ? c.cause : undefined
	}
	return lines.join("\n  caused by: ")
}
