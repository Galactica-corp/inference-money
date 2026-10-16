import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MANIFEST } from "../../bridge-core/src/test/fixtures"
import { aztecAddressOf, castMember } from "./cast"
import { castKeysOf, demoFilePath, demoFileSchema, readDemoFile, writeDemoFile } from "./files"

const bridge = MANIFEST.l2.bridge.address
const usersTag = "0123456789abcdef0123456789abcdef"
const merchantsSalt = `0x${"1f".repeat(32)}`
const dir = mkdtempSync(join(tmpdir(), "demo-file-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("demo file", () => {
	it("derives the merchants from the published salt (pinned), which every demo carries", async () => {
		const galactica = async (file: unknown) =>
			(await aztecAddressOf(castMember(MANIFEST, "galactica", castKeysOf(demoFileSchema.parse(file))))).toString()
		expect(await galactica({ version: 2, bridge, usersTag, merchantsSalt })).toBe(
			"0x1c73b1482122c8eca78d69f5b3a3a766c74d28d137be3ae027c11067f7a2952f",
		)
		expect(() => demoFileSchema.parse({ version: 2, bridge, usersTag }), "v2 needs its salt").toThrow()
	})

	it("publishes version 2, which reads back as this deployment's", () => {
		const ref = { path: join(dir, "testnet.json"), m: MANIFEST }
		const path = writeDemoFile(ref, { usersTag, merchantsSalt })
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2, bridge, usersTag, merchantsSalt })
		expect(readDemoFile(ref)).toEqual({ version: 2, bridge, usersTag, merchantsSalt })
	})

	it("refuses this deployment's version-1 demo, naming demo setup, and ignores one an earlier deployment left", () => {
		const ref = { path: join(dir, "testnet.json"), m: MANIFEST }
		writeFileSync(demoFilePath(ref), JSON.stringify({ version: 1, bridge, usersTag }))
		expect(() => readDemoFile(ref)).toThrow("bridge demo setup")
		writeFileSync(demoFilePath(ref), JSON.stringify({ version: 1, bridge: `0x${"ab".repeat(32)}`, usersTag }))
		expect(readDemoFile(ref)).toBeUndefined()
	})
})
