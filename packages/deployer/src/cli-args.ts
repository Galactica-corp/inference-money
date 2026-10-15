/** `bun run bridge <command>`: what each command takes. A trailing `...` arg takes the rest of the line. */
const COMMANDS = {
	deploy: { args: ["local|testnet"], flags: ["merchant-delay"] },
	"admin address": { args: [] },
	"admin accept": { args: ["manifest"] },
	"admin propose": { args: ["manifest", "address"] },
	"disposable init": { args: [] },
	"disposable exec": { args: ["command..."] },
	"disposable destroy": { args: ["manifest"] },
	"merchants add": { args: ["manifest", "account..."] },
	"merchants off": { args: ["manifest", "account"] },
	"merchants on": { args: ["manifest", "account"] },
	"merchants delay": { args: ["manifest", "seconds"] },
	"merchants guardian": { args: ["manifest", "address"] },
	"merchants cancel": { args: ["manifest", "account"] },
	"merchants list": { args: ["manifest"] },
	pause: { args: ["manifest", "on|off"] },
	verify: { args: ["manifest"], flags: ["tour", "node", "l1-rpc", "guardian", "allow-pending"] },
	smoke: { args: ["manifest"], flags: ["record"] },
	export: { args: ["manifest"], flags: ["out"] },
	"manifest-path": { args: ["local"] },
	"demo setup": { args: ["manifest"], flags: ["rotate"] },
	"demo status": { args: ["manifest"] },
	"demo reset": { args: ["manifest"] },
	"demo fund": { args: ["manifest"] },
	probe: { args: ["testnet"] },
	scan: { args: ["secrets"] },
} as const satisfies Record<string, { args: readonly string[]; flags?: readonly string[] }>

export type Command = keyof typeof COMMANDS

/** Flags that take no value. */
const SWITCHES = new Set(["rotate", "allow-pending"])
/** Flags a command cannot run without. */
const REQUIRED: Partial<Record<Command, string[]>> = { export: ["out"] }

export interface Invocation {
	command: Command
	args: string[]
	flags: Record<string, string | true>
}

export const USAGE = `usage: bun run bridge <command>   (<manifest> is a path, or "local" for this RUN_ID's run)\n${Object.entries(COMMANDS)
	.map(([name, spec]) => {
		const flags = ("flags" in spec ? spec.flags : []).map((f) => (SWITCHES.has(f) ? ` [--${f}]` : ` [--${f} <${f}>]`))
		return `  ${name} ${spec.args.map((a) => `<${a}>`).join(" ")}${flags.join("")}`
	})
	.join("\n")}`

class UsageError extends Error {
	override name = "UsageError"
}

const PLACEHOLDERS = new Set(["manifest", "address", "account", "seconds"])

/** Any other arg is a literal (`local|testnet`, `on|off`, `secrets`): one of its spellings. */
function checkLiteral(name: string, value: string): void {
	if (!PLACEHOLDERS.has(name) && !name.split("|").includes(value)) {
		throw new UsageError(`expected ${name.replaceAll("|", " or ")}`)
	}
}

function splitFlags(words: string[], allowed: readonly string[]): { positional: string[]; flags: Record<string, string | true> } {
	const positional: string[] = []
	const flags: Record<string, string | true> = {}
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string
		if (!word.startsWith("--")) {
			positional.push(word)
			continue
		}
		const name = word.slice(2)
		if (!allowed.includes(name)) throw new UsageError(`unknown flag --${name}`)
		if (SWITCHES.has(name)) flags[name] = true
		else {
			const value = words[++i]
			if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`)
			flags[name] = value
		}
	}
	return { positional, flags }
}

/** Parses argv after the script name. A usage error names what is wrong, never the value it rejected. */
export function parseInvocation(argv: readonly string[]): Invocation {
	const two = argv.slice(0, 2).join(" ")
	const command = (two in COMMANDS ? two : argv[0]) as Command | undefined
	if (command === undefined || !(command in COMMANDS)) throw new UsageError(USAGE)
	const spec: { args: readonly string[]; flags?: readonly string[] } = COMMANDS[command]
	const rest = argv.slice(command.split(" ").length)
	const variadic = spec.args.at(-1)?.endsWith("...") === true
	if (command === "disposable exec") {
		if (rest.length === 0) throw new UsageError("disposable exec needs a bridge command to run")
		return { command, args: [...rest], flags: {} }
	}
	const { positional, flags } = splitFlags(rest, spec.flags ?? [])
	const fixed = variadic ? spec.args.length - 1 : spec.args.length
	if (positional.length < spec.args.length || (!variadic && positional.length > fixed)) {
		throw new UsageError(`${command} takes ${spec.args.map((a) => `<${a}>`).join(" ")}`)
	}
	spec.args.slice(0, fixed).forEach((name, i) => {
		checkLiteral(name, positional[i] as string)
	})
	for (const name of REQUIRED[command] ?? []) if (!(name in flags)) throw new UsageError(`${command} needs --${name}`)
	return { command, args: positional, flags }
}

/** Every tx's expiry (the token's `STANDARD_TX_LIFETIME`); a merchant read capped at or below it stands out. */
const STANDARD_TX_LIFETIME = 82_800n

/** A delay in seconds within the token's bounds, [3600, 86400]; one that marks merchant proofs warns on stderr. */
export function parseDelay(value: string): bigint {
	if (!/^\d+$/.test(value)) throw new UsageError("a delay is a whole number of seconds")
	const delay = BigInt(value)
	if (delay < 3600n || delay > 86_400n) throw new UsageError("a delay must be within [3600, 86400] seconds")
	if (delay <= STANDARD_TX_LIFETIME)
		console.warn(
			`warning: a merchant delay of ${STANDARD_TX_LIFETIME} s or less shortens the expiry of every tx that proves a merchant side, which marks those txs`,
		)
	return delay
}
