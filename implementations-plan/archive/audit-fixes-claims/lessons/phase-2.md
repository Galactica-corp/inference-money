# Phase 2: demo and deployer keep every draft and setup

- `castDeposit` takes a `PriorDraft { draft, abandon() }`. `abandon` runs before any approval; a throwing `abandon` stops the deposit before a new draft exists (tested: nothing approved, stored or sent).
- `castDeposit` stores the draft a second time once `submitDeposit` returns, so the stored copy carries its tx hash.
- `PlanStore.clear` became `abandon` + `archive`; `archive` renames `setup.json` to `setup-<tag>.json` through the new atomic `StateDir.rename`. Abandoned drafts go to `abandoned-<nonce hex>.json` (`keepAbandonedDraft`), shared by `demo setup` and the smoke.
- `seedTicket` already named its ticket `stored`; the draft decode reads `plan.drafts[seed]` directly.
- Gate: lint exit 0, typecheck clean, `bun run test` green except `cli.test.ts`'s spawn test, which timed out at 5 s with the host's load average at about 239 (parallel batches). It passes alone with `--timeout 60000` in 4.9 s, and the CLI entry point imports nothing this phase changed before its handlers load. Not a regression; re-checked at the final gate.
