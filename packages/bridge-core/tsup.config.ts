import { defineConfig } from "tsup"

// The published build: one ESM entry per subpath export; the contract artifacts land in chunks the entries share.
export default defineConfig({
	entry: {
		index: "src/index.ts",
		deploy: "src/deploy/index.ts",
		deployments: "src/deployments.ts",
		manifest: "src/manifest.ts",
		networks: "src/deploy/networks.ts",
		rules: "src/rules.ts",
		types: "src/types.ts",
	},
	format: ["esm"],
	target: "es2023",
	splitting: true,
	sourcemap: false,
	clean: true,
	// Declarations come from tsc (scripts/pack.ts): tsup's dts build does not run under TypeScript 6.
	dts: false,
})
