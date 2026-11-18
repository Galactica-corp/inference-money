# Phase 2: the opener rule

- The opener must be a merchant at the list's block and at `list.at + MERCHANT_MAX_DELAY`: `merchantStatus` past `changeAt` reads `scheduledOff`, so a pending switch-off refuses and a cancelled one (future `changeAt`, `scheduledOff` false) does not.
- The fake wallet's NO_WAIT send returns no `offchainEffects`, so an opening that passes the rule fails later in `openedCommitment`; the test asserts the send happened and the refusal text is absent.
- Gate: lint and typecheck green; every suite green except deployer `cli.test.ts` "never loads a .env…" again, on its 5 s timeout. One CLI start takes about 3.4 s at load average 260, and the test spawns three. With `--timeout 30000` the file passes 3/3, so the failure comes from host load, not this diff.
