# Phase 1: one fee vocabulary, and the sponsor guard

- `@ts-expect-error` in `src/*.test.ts` is enforced: `bun run typecheck` passed with both new lines, so each one marks a real type error (an unused one fails tsc).
- `verifyEnvironment` is now exported for its unit test; a stub node with `getContract` is enough on the sponsor-less path, since `getFeeJuiceBalance` runs only with a sponsor.
- Gate: lint, typecheck green. `bun run test`: everything green except deployer `cli.test.ts` "never loads a .env…", which hit its 5 s timeout on spawned `bun run` processes at load average 263. On a rerun of the deployer suite alone, 54/54 passed. The showcase's `test:components` is the same `vitest run` the root `test` runs (92 passed, 5 skipped).
