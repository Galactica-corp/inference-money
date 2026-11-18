# Phase 2: the delay policy

- `delayPolicyChecks` is pure over `DelayReads` (setting, guardian slot, merchant list), read by `readDelays` in `token-reads.ts` at the list's block. `verify` and `merchants delay` share that read; `MerchantEntry` already carries each entry's delay and change time, so the per-entry `entryDelay` reads left `verify` (`merchants list` keeps its own).
- The guardian slot's decrease after a non-default `--merchant-delay` prints as `ok` with its time; strict verify passes a fresh `--merchant-delay 3600` deploy without a flag.
- `merchants delay` decides from a one-block read-back, not from its send: it records `l2.merchantDelay` only when the setting reads as requested and exits 1 on a send error, a stale setting or any unsynced merchant. `asAdmin` always returns 0, so the handler opens its own session.
- The deployer's `cli.test.ts` .env case spawns the CLI three times; at host load ~207, one start took 3.4 s and the case hit bun's 5 s default timeout. It passes once the load drops; nothing in this diff touches the entry point.
- The integration cases (`failing()` with `allowPending`, the tour verify with `--allow-pending`, transfers syncing its 1 h merchant back, the CLI strict-vs-allow case) are typechecked here and run in Phase 4.

## Gate (passed)
- `bun run lint`, `bun run typecheck`, `bun run test`: exit 0.
- `deploy:local --merchant-delay 3600` → `verify:local`: both exit 0; `ok guardian slot delay change pending: 86400s until …, then 3600s`; manifest 3600.
- `deploy:local` (manifest 86400) → `bridge demo setup local` → `bridge merchants delay local 7200`: all exit 0; "the setting reads 7200s: the manifest records it"; manifest 7200.
- `verify:local`: exit 1, `FAIL merchant … delay change pending: 86400s until …, then 7200s (--allow-pending accepts it while it settles)` for both demo merchants. `bridge verify local --allow-pending`: exit 0, both as `warn` with their time.
- `deploy:local` → `verify:local`: both exit 0, `every check passed`; manifest 86400.
