import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import {
	type BuildTarget,
	EMBEDDED_MANIFEST,
	EMBEDDED_TOUR,
	headersFile,
	ISOLATION_HEADERS,
	resolveTarget,
	servedHeaders,
} from "./build/target.ts"

const APP_ROOT = fileURLToPath(new URL(".", import.meta.url))
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))

/** Node's resolution walk, from one package's real root to a dependency it declares. */
function depRoot(fromRoot: string, dep: string): string {
	for (let dir = fromRoot; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", dep)
		if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate)
		if (dirname(dir) === dir) throw new Error(`${dep} is not reachable from ${fromRoot}`)
	}
}

/**
 * The wallet's SQLite-OPFS stores load `sqlite3.wasm` through emscripten's `locateFile` fallback, a bare
 * `assets/sqlite3.wasm` beside the worker chunk that no bundler rewrites, so unhashed copies are emitted there. The
 * walk follows declared dependencies (wallets → pxe → kv-store → sqlite3mc-wasm) because the isolated linker lets a
 * package see only what it declares.
 */
function sqliteWasmEmit(): Plugin {
	const pxe = depRoot(depRoot(APP_ROOT, "@aztec-labs/wallets"), "@aztec-labs/pxe")
	const wasm = depRoot(depRoot(pxe, "@aztec-labs/kv-store"), "@aztec-labs/sqlite3mc-wasm")
	return {
		name: "showcase-sqlite-wasm",
		apply: "build",
		generateBundle() {
			for (const file of ["sqlite3.wasm", "sqlite3-opfs-async-proxy.js"]) {
				this.emitFile({ type: "asset", fileName: `assets/${file}`, source: readFileSync(join(wasm, "vendor/jswasm", file)) })
			}
		},
	}
}

/** `_headers` for Workers static assets, and the exact manifest string the bundle embeds, for the identity check. */
function outputsPlugin(target: BuildTarget, embedded: string): Plugin {
	let outDir = "dist"
	return {
		name: "showcase-outputs",
		apply: "build",
		configResolved(config) {
			outDir = resolve(config.root, config.build.outDir)
		},
		closeBundle() {
			writeFileSync(resolve(outDir, "_headers"), headersFile(target))
			writeFileSync(resolve(outDir, EMBEDDED_MANIFEST), embedded)
			writeFileSync(resolve(outDir, EMBEDDED_TOUR), JSON.stringify(target.tour))
		},
	}
}

export default defineConfig(() => {
	const target = resolveTarget(process.env, REPO_ROOT)
	const devPort = Number(process.env.WEB_DEV_PORT) || 5180
	const embedded = JSON.stringify(target.manifest)
	return {
		define: {
			__BRIDGE_MANIFEST__: embedded,
			__SHOWCASE_USERS_TAG__: JSON.stringify(target.usersTag),
			__SHOWCASE_MERCHANTS_SALT__: JSON.stringify(target.merchantsSalt),
			__SHOWCASE_L1_RPC__: JSON.stringify(target.l1RpcUrl),
			__SHOWCASE_PROOFS__: JSON.stringify(target.proofs),
			__SHOWCASE_PRESTO__: JSON.stringify(target.presto),
			__SHOWCASE_TOUR__: JSON.stringify(target.tour),
		},
		resolve: {
			alias: [
				{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
				// The Buffer global injects this import into every module, workspace packages included, which the
				// isolated linker cannot resolve from their own location: pin it to this app's copy.
				{
					find: "vite-plugin-node-polyfills/shims/buffer",
					replacement: fileURLToPath(import.meta.resolve("vite-plugin-node-polyfills/shims/buffer")),
				},
				{ find: "detect-node", replacement: resolve(APP_ROOT, "src/shims/detect-node.ts") },
			],
			// Two copies of a wasm binding package split init from use, and the wasm instance never resolves.
			dedupe: ["@aztec-foundation/noir-noirc_abi", "@aztec-foundation/noir-acvm_js"],
		},
		// The dev server's prebundling breaks their wasm and worker URLs.
		optimizeDeps: { exclude: ["@aztec-foundation/bb.js", "@aztec-foundation/noir-acvm_js", "@aztec-foundation/noir-noirc_abi"] },
		worker: { format: "es" as const },
		plugins: [
			react(),
			tailwindcss(),
			// Aztec packages read `process`/`Buffer` at module top level.
			nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
			sqliteWasmEmit(),
			outputsPlugin(target, embedded),
		],
		// Dev keeps the inline HMR preamble, so it gets isolation only; preview serves exactly what production does.
		server: { port: devPort, strictPort: !process.env.WEB_DEV_PORT, headers: ISOLATION_HEADERS },
		preview: { headers: servedHeaders(target) },
		build: { target: "es2023", sourcemap: true },
	}
})
