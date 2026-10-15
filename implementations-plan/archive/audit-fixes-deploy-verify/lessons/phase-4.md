# Phase 4: full heavy gates

- Ran on `59abae8`: Phases 1–3 with dev synced through #45. A first run on `9ad0c2b` was stopped when #45 landed, so the gates would cover the PR's code. The stopped run's processes died with it, and its registry rows needed a `net:down`.
- `RUN_ID=deploy-verify bun run test:integration`: 50/50 specs (2577 s) and 6/6 clock specs (306 s), exit 0. An earlier run on Phases 1–2 alone (`3040770`) also passed: 49/49 and 6/6.
- `bun run test:e2e`: 9/9 passed (7.6 min), `withdraw-only.spec.ts` included, exit 0.
- `bun run lint:actions`: exit 0, with the fast gates on the merge.
- Afterwards `~/.agents/ports.md` holds no row for `deploy-verify` or the e2e run, and no process from either is alive.
