# Phase 5: heavy gates and the Codex fix loop

## Heavy gates

- `lint:actions` exit 0.
- First `test:integration`: every spec failed before a test ran, because the node exited with "Cannot find module
  'bcrypto.node'". This worktree's `packages/local-network/toolchain` install never compiled bcrypto's addon (its
  install script is `node-gyp rebuild`, and node-gyp was not on PATH then). `node-gyp rebuild` in
  `toolchain/node_modules/bcrypto`, with nvm's npm `node-gyp-bin` on PATH, fixed it. No pin or lock moved.
- Second run: an own goal. Editing `TokenPortal.sol` while the suite ran made every later `verify` fail its portal
  bytecode and creation-tx checks, since verify compares the deployed portal against a fresh build of the working
  tree. Before that point, `demo setup` (salted) and both smoke runs had passed. Freeze `contracts/evm/src` while an
  integration or e2e run is live; the final gate reruns on the final code.

## Codex round 1 (gpt-6.1-sol, high, read-only; session 01a137bf-a7e4-7e31-8140-2177fa7945f9)

1. medium, adopted: the Aztec registry is a USDC sink both sides already know (`m.l1.registry`, the portal's
   `registry`). The pinned `Registry.sol` has only `addRollup`, `updateRewardDistributor` and getters. Refused in
   `_requireDepositor` and `assertExitIntent`; `proveRejectsBadRefund` picks from 7 (14 paths); `_assumeValidRefund`,
   the roundtrip fuzz and the fizz handler exclude or draw it; docs, GL-21, A24 and A26 name it. Gas +1 280 on public
   deposits; snapshot refreshed. The bound rollup also moves only its fee and staking assets, but it is not in the
   manifest, so the SDK could not refuse it; left out of both lists.
2. low, adopted: plan.md's threat model described pre-change failure paths; restated as the property each change
   secures.
3. comment, adopted: deleted `_requireRollupVersion`'s rollback note and `FAKE_ROLLUP_VERSION`'s restating comment.
4. comment, adopted: `runSetup`'s doc keeps only its constraints.
- Gates after the fixes: test:evm 132/132; halmos exactly 16 (`check_depositPublic_rejectsBadRefund` 14 paths); gas
  within tolerance; Slither 0; Medusa 300 s, 73 passed; bridge-core exit tests 29/29; Biome clean.
- Negative control for the registry rule: with it deleted, halmos does not report a counterexample but errors (a Z3
  sort mismatch on its sha256 model once the deposit path reaches the message hash), which the gate still counts as a
  failure. Concretely, `proveRejectsBadRefund(funded, 6, …)` fails on `BAD_REFUND_DEPOSITED` without the rule and
  holds with it. Run halmos only after `forge build --ast --force`, as the gate does: a cached build skips the AST.

## Codex round 2 (resumed)

- "MATERIAL: no", with no findings. The loop converged in two rounds.

## Final gates (on 6632d72)

- `test:integration` 53/53 specs (1 989 s) and 6/6 clock specs (284 s), exit 0, network down.
- `test:e2e` 9/9 (5.6 min), exit 0, network reaped. `agent.sh` names its own run (`showcase-e2e-<pid>-<time>`) over
  an inherited `RUN_ID`. Its "Existing nullifier" page error is the resilience spec's deliberate conflict.
- `compile.sh --check` exit 0; origin/dev unmoved since 0d4460e; lint, typecheck (8/8), `bun run test` (cold cache:
  bridge-core 202, demo 15, deployer 90, showcase 99 passed and 5 skipped) and `build:testnet` (7/7) exit 0.

LESSONS_FILE=implementations-plan/pre-redeploy/lessons/phase-5.md
