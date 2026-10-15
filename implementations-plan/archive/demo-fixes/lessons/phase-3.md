# Phase 3: showcase (#43, #61, #88) and the quality loop

- #61: `claimDeposit` builds the L1 reader before the claim, and viem refuses an empty URL, so the action tests' `ctxWith` now carries a dead `http://127.0.0.1:9` (nothing dials it; every reader is mocked).
- #73 surfaced here: `build:testnet` failed with `Rolldown failed to resolve import "vite-plugin-node-polyfills/shims/process"` from `bridge-core/src/random.ts`. The showcase's `nodePolyfills({ globals: { process: true } })` injects an import into any module with a bare `process`, resolved from that module's package, which lacks the plugin. Reading `globalThis.process` avoids the injection; a browser still has no SEED.
- #88: `useOpening(open, needed)` with `openOnce`; a mutant that ignores `needed` fails `App.test.tsx` ("the recording opens nothing: expected 1 to be +0").
- Gates: showcase typecheck, lint, `test:components` 102 pass; `build:testnet` 7 checks pass.

## Codex fix loop (gpt-6.1-sol, high, session 01a140a4)

- Round 1: `MATERIAL FINDINGS: 0`; two test gaps adopted: the key-only rebuild case passed even if `use` got the old ticket, and `#proving` was never the first view to open the wallet. Fixed in eba7d87.
- Round 2 (resumed): both verified, no regressions, `MATERIAL FINDINGS: 0`. Converged.
