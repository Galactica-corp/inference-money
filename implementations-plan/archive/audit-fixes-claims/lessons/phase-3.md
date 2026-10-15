# Phase 3: the showcase keeps, skips and shows

- `PendingDeposit` gained `final` and `archived`; the schema is strict, so `store.test.ts` round-trips both through the real `tickets()`.
- `claimableEntry` skips archived and final records before decoding, so neither is dropped as unreadable either.
- `recheckDeposit` runs inside `ctx.demo.exclusive` and re-reads the record there: a claim run and a re-check never write the same record at once. A missing, final or unarchived record answers "nothing to check".
- The mocked reconcile returns `{ ...ticket, draft: d }` for a "found" draft, so the test can read the stored claim's draft back and prove the salt carried over.
- `useRun.recheck` reuses the run guard (`running`, `busy`), so "Check again" is disabled while a step runs and vice versa. The Reset link's classes became `linkButton`, shared with the row's button.
- Gate: lint 0, typecheck 0, `bun run test` all 0 fail (the CLI spawn test passed this time at load ~218), `test:components` 95 passed.
