# Phase 1 — the open delay re-sync

## Gate evidence

- `compile.sh --check`: token class id `0x25170a05…bc5d` (pinned in `artifacts.test.ts`); proxy and bridge class ids unchanged. The proxy's committed artifact still changes: its debug symbols index the token's source files, so any token source edit renumbers them.
- `bun run test:noir`: token 185 passed (manifest 184 names), token_bridge 85, keystone 20.
- `check-sole-consumer.sh`, `check-stamp-constraint.sh`, `bun run lint`, `bun run typecheck`: exit 0.
- `bun run test`: every workspace green except the deployer's CLI `.env` test, which timed out at 5 s twice under a host load average of 228 on 188 cores; it spawns three CLIs and does not touch the token.

## The guard reads the delay in force

`a_strangers_sync_never_lowers_the_delay_in_force` sets the setting (12 h) between a pending decrease (1 h) and the delay in force (24 h). A guard comparing against the scheduled delay would let a stranger re-schedule 12 h, restarting the decrease clock; the guard compares against `get_current_delay()` and refuses.
