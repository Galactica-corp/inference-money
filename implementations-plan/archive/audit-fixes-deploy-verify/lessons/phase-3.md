# Phase 3: withdraw-only mode after a rollup switch

- `assertNetworkIdentity` pins the portal's stored `registry`, `inbox`, `outbox` and `rollupVersion` and reads `depositsOpen` only once every pin holds, so a manifest naming another registry fails as a `NetworkMismatchError`, not as a raw contract-call error from `getCanonicalRollup` at the wrong address. `ROLLUP_ABI` lost its last caller and went, with its pin in `abi.test.ts`.
- The live composer opens on the deposit preset, so with deposits closed Try it starts disabled. Two e2e consequences: `openLive` (which expects Try it enabled) cannot be used after a reload with deposits closed, and `countRuns` must start only once a non-deposit draft is picked, since it counts every disabled → enabled edge as a run.
- e2e specs cannot import showcase modules that use the `@/` alias (`e2e/tsconfig.json` has no `paths`); the spec matches the notice by its first sentence and checks the refusal carries the notice's text.
- The spec's route answers `getCanonicalRollup` with `route.fetch()` + `route.fulfill({ response, json })`, which keeps anvil's CORS headers (the page is cross-origin isolated) and patches only the matching ids of a batch.

## Codex fix loop (gpt-6.1-sol, high)
- Round 1 (session `01a13621`): approve with fixes, four Low, all adopted. A proven exit pays whether or not the bound rollup keeps proving; only creating and proving new exits needs it (architecture, integration, the verify warning). An unbound account can still bind through a private deposit made before the switch (architecture, follow-ups). Only a fresh acceptance run cannot pass after a switch; a journaled one continues (operations). Two narrating doc comments deleted.
- Round 2 (same session, over `f95f66e` and the net diff): approve, no new material findings. Loop converged.

## Gate (passed)
- `bun run lint`, `bun run typecheck`, `bun run --cwd apps/showcase test:components`: exit 0. `bun run test`: every workspace exits 0 but deployer, whose `cli.test.ts` "never loads a .env from the working directory" times out at its 5 s limit under host load (5.7 s, rerun 5.6 s, load average 200–370); it passes alone with `--timeout 60000`, and nothing in this diff enters its import graph.
- `RUN_ID=dv-rollup bun run net:up` → `deploy:local` → `verify:local`: exit 0; `ok network identity (node + the portal's rollup)` and no deposits warning in both verifies. `net:down`: exit 0, no registry row left.
- `bun run test:e2e -- withdraw-only.spec.ts`: 1 passed (1.0 min); the run reaped its network.
