import { describe, expect, it } from "bun:test"
import { parseDelay, parseInvocation } from "./cli-args"

describe("bridge CLI arguments", () => {
	it("parses grouped commands, variadic args, valued flags and switches", () => {
		expect(parseInvocation(["merchants", "add", "local", "0xa", "0xb"])).toEqual({
			command: "merchants add",
			args: ["local", "0xa", "0xb"],
			flags: {},
		})
		expect(parseInvocation(["verify", "m.json", "--tour", "t.json", "--l1-rpc", "http://x"])).toEqual({
			command: "verify",
			args: ["m.json"],
			flags: { tour: "t.json", "l1-rpc": "http://x" },
		})
		expect(parseInvocation(["demo", "setup", "local", "--rotate"]).flags).toEqual({ rotate: true })
		expect(parseInvocation(["verify", "local", "--allow-pending", "--node", "http://n"]).flags).toEqual({
			"allow-pending": true,
			node: "http://n",
		})
		expect(parseInvocation(["disposable", "exec", "deploy", "testnet", "--merchant-delay", "3600"]).args).toEqual([
			"deploy",
			"testnet",
			"--merchant-delay",
			"3600",
		])
	})

	it("refuses unknown commands and flags, wrong arity, bad literals and a missing required flag", () => {
		for (const argv of [
			["deploy"],
			["deploy", "mainnet"],
			["pause", "local", "maybe"],
			["merchants", "off", "local"],
			["verify", "m.json", "--bogus", "1"],
			["verify", "m.json", "--tour"],
			["export", "m.json"],
			["probe", "mainnet"],
			["disposable", "exec"],
			["frobnicate"],
		]) {
			expect(() => parseInvocation(argv), argv.join(" ")).toThrow()
		}
	})

	it("bounds a delay to the token's [3600, 86400] seconds", () => {
		expect(parseDelay("3600")).toBe(3600n)
		for (const bad of ["3599", "86401", "1h", "-1"]) expect(() => parseDelay(bad)).toThrow()
	})
})
