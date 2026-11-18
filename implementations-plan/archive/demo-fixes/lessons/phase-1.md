# Phase 1: bridge-core (#84, #72, #61, #73)

- Plan audit, Codex gpt-6.1-sol high (session 01a14087): conditional approve; the `pay` re-run after a sent opening was the one demonstrated gap (folded into phase 3). Director approved with both scope points.
- #72: the node's JSON-RPC errors are plain `Error` with the parsed JSON as `cause` (`safe_json_rpc_client.js`); a genuine `SimulationError` only comes from proving or `simulatePublicCalls` before the send. `ListRefusal` marks the three list-based refusals so the stale-list retry keeps covering them.
- #73: a child `bun -e 'await import("@inference-money/bridge-core")'` with `cwd` in the package resolves the package by self-reference; the import under `SEED=1` exits non-zero in ~1 s. The old `random.test.ts` imported `random.ts` under `SEED=7`, so it had to go.
- #61: `withRebuiltTicket` keeps the retry outside the first catch, so a second failure escapes; tests drive `reconcileDeposit` through the existing fake L1, with a `key` option added to `depositLog`.
- Gate: `bun run lint`, `bun run --cwd packages/bridge-core typecheck`, `bun run --cwd packages/bridge-core test` (208 pass).
