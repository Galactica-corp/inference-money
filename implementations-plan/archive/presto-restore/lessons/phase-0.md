# Phase 0: setup (2026-10-14)

- Homed at `origin/dev` 437ae93. `bun install --frozen-lockfile`: 762 packages.
- Both cached rc.3 nodes (`aztec-node-rc3-bump`, `aztec-node-pre-redeploy`) were dangling: their `node_modules` symlinks pointed into torn-down worktrees. Installed `~/.cache/inference-money/aztec-node-presto-restore` with `install-node.sh`, nvm's `node-gyp-bin` on PATH; `bcrypto.node` compiled.
- Warm-up `test:e2e` on the rc.1 pin: 9 passed, Playwright 5.0 min, about 11 min end to end.
- `@alejoamiras/presto@6.0.0-rc.3` was not on npm at 15:56Z; a poller checks every 10 minutes.

## Plan audit (Codex gpt-6.1-sol, high; session 01a13b20-7e13-75b1-86db-8c05f1039fc8)

Conditional approve; all five findings adopted (see plan.md, Plan audit). Verified before adopting: npm 11.19.0 has `audit signatures --include-attestations`; `reap_run` in `apps/showcase/e2e/run/common.sh` deletes the state dir on a passing run.
