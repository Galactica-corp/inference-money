# Lessons

Gotchas that cost a past run and would bite other work, one line each with its archived detail; nothing repeats `AGENTS.md`.

## Aztec / Noir

- Deploy owner-initialized contracts deployer-bound, never `universalDeploy`: with a zero deployer, the first initializer takes the owner. [phase-6](archive/usdc-bridge/lessons/phase-6.md)
- Only finality settles a tx: keep a claim secret until its nullifier is `finalized`; a tx is gone once a finalized block passes its expiry, never on one node's DROPPED; `sendTx`'s `Invalid tx: …` comes after hand-off, so it settles a tx only from an honest node, and exits never trust it. The wallet-sdk strips `waitForStatus` (6.0.0-rc.1): send `NO_WAIT`, wait on the node. [phase-11](archive/usdc-bridge/lessons/phase-11.md), [phase-13](archive/galactica-compliant-usdc/lessons/phase-13.md), [phase-15](archive/galactica-compliant-usdc/lessons/phase-15.md), [phase-4](archive/audit-fixes-sdk-fees/lessons/phase-4.md)
- The Inbox range-checks a message's actor and hashes, never the fields hashed into them, and an ABI-decoded `EthAddress` holds any field: check each hashed value where the message is emitted. [phase-15](archive/galactica-compliant-usdc/lessons/phase-15.md)
- Move a local network's clock with `aztecDebug_warpL2TimeAtLeastTo` (L2 and L1 together; `evm_increaseTime` never passes a deadline), then wait for a block at the target: the warp's own block may carry its slot's start. [phase-10](archive/usdc-bridge/lessons/phase-10.md), [phase-5](archive/harden-security-whole-repo/lessons/phase-5.md)
- A tx expires by `anchor + 82 800` (6.0.0-rc.1: private calls cap it at `anchor + 86 399`, the PXE rounds down to hours). [phase-3](archive/harden-security-whole-repo/lessons/phase-3.md)
- TXE runs the committed artifact (`compile.sh` first), checks no expiry, moves its clock only when a test does, and shows no public logs, L2→L1 messages or handshakes: integration specs pin emits and note deliveries, `check-sole-consumer.sh` payouts. A read's expiry cap shows only at entry level: `get_current_value()` inside `private_context_at`, then `finish().expiration_timestamp`. [phase-4](archive/harden-security-whole-repo/lessons/phase-4.md), [phase-4](archive/tob-contracts-audit/lessons/phase-4.md), [phase-0](archive/pashov-audit-fizz/lessons/phase-0.md), [phase-2](archive/audit-fixes-contracts/lessons/phase-2.md)
- 6.0.0-rc.1: claimable means `getL1ToL2MessageMembershipWitness("latest", …)` resolves (`getL1ToL2MessageIndex` answers at L1 ingestion, too early); account deploys skip instance publication, so check `initializationStatus`, not `node.getContract`. [phase-11](archive/usdc-bridge/lessons/phase-11.md)
- `compile.sh --check` diffs a fresh build against HEAD's artifacts (after a toolchain bump, ones the new stdlib cannot parse): commit the rebuild, then check. [phase-11](archive/usdc-bridge/lessons/phase-11.md), [phase-3](archive/harden-security-whole-repo/lessons/phase-3.md)

## Foundry / halmos / Medusa

- halmos 0.3.3 leaves `ecrecover` uninterpreted: it proves an honest low-s `vm.sign` accepted, never a foreign signer refused. Prove signer rules in forge, with a mutant canary. [phase-0](archive/pashov-audit-fizz/lessons/phase-0.md)
- Sign before `vm.prank` or `vm.expectRevert`: a call argument that reads a contract (a digest) consumes them. [phase-3](archive/pashov-audit-fizz/lessons/phase-3.md)
- Medusa 1.5.1 reads `slither.useSlither`, not `enabled`, and exits 7 on any failed property: judge a campaign by its exit code and registered-property count. [phase-1](archive/pashov-audit-fizz/lessons/phase-1.md)

## Bun / TypeScript / tests

- bun reads `bunfig.toml` from the cwd only (a nested standalone project misses the root's age gate and linker, `bun run --cwd` its preload) and applies the age gate only at resolution: lock a young version under a temporary `minimumReleaseAgeExcludes` entry, never commit one. An optional package skipped before it joined stays skipped until its parent leaves `bun.lock` (`aztec-wsdb binary not found`). [phase-3](archive/usdc-bridge/lessons/phase-3.md), [phase-10](archive/usdc-bridge/lessons/phase-10.md), [phase-11](archive/usdc-bridge/lessons/phase-11.md), [phase-1](archive/presto-showcase/lessons/phase-1.md)
- `Bun.spawn` (1.4.0–1.4.2) ignores `process.env` deletions: spawn a child that must not inherit a secret through `node:child_process` or `Bun.$`. [phase-8](archive/galactica-compliant-usdc/lessons/phase-8.md)
- A closure's inner functions count toward its function's 80-line budget; use a class with private methods. [phase-9](archive/usdc-bridge/lessons/phase-9.md)
- Assert the failure reason: a spec passing on "not deployed", self-test fixtures sharing one dir and `fail_on_revert = false` invariants all passed vacuously. [phase-3](archive/usdc-bridge/lessons/phase-3.md), [phase-6](archive/usdc-bridge/lessons/phase-6.md)

## viem / L1

- viem caches `getBlockNumber` ~4 s per client, so a tip read after a receipt can predate the tx: use `cacheTime: 0`, scan through `max(tip, finalized)`. [phase-6](archive/usdc-bridge/lessons/phase-6.md)
- viem trusts its RPC: a receipt wait follows replacements and cancellations, `deployContract` returns the echoed hash, `prepareTransactionRequest` keeps a filled `chainId` (2.56.7). Sign in process; check the chain id, the receipt's hash or event. One `TransactionNotFound` from a load-balanced RPC is not a drop. [phase-7](archive/usdc-bridge/lessons/phase-7.md), [phase-10](archive/usdc-bridge/lessons/phase-10.md), [phase-5](archive/audit-fixes-deploy-verify/lessons/phase-5.md)
- Anvil caps `eth_estimateGas` at balance ÷ `maxFeePerGas`; past it, an out-of-gas inside a call reverts with empty data ("unknown reason") while `eth_call` passes, and the local publisher's tips climb to 120 gwei (#40). [phase-4](archive/audit-fixes-claims/lessons/phase-4.md)

## Browser e2e

- A local network can finish a flow between Playwright polls: assert durable state, not a transient step. [phase-10](archive/usdc-bridge/lessons/phase-10.md)

## CI

- Reproduce CI with `CI=true GITHUB_ACTIONS=true FORCE_COLOR=0` (ANSI codes broke a `$`-anchored grep) and ubuntu-24.04's shellcheck 0.9.0, which predates SC2329 (disable `SC2317,SC2329`) and flags `A && B || true` (SC2015). `lint:shell` checks `git ls-files` only: shellcheck a new script before its first commit. [phase-10](archive/usdc-bridge/lessons/phase-10.md), [phase-4](archive/presto-showcase/lessons/phase-4.md), [phase-11](archive/pashov-audit-fizz/lessons/phase-11.md)
- Path filters must list every shared root file a suite loads (`test-preload.ts` was missing from three). [phase-10](archive/usdc-bridge/lessons/phase-10.md)

## Testnet ops

- Sepolia's canonical Aztec rollup can switch unannounced (2026-09-28), and `TokenPortal.initialize` binds the canonical one: `probe:testnet` before any spend. [phase-7](archive/usdc-bridge/lessons/phase-7.md)
- `env-exec` refuses a dirty keyed tree: commit each run's manifest and `keyed-worktree.sh sync` before the next request; run one at a time (a live wallet store fails the other's exit scan). `secrets:scan` fails on a cache symlink resolving outside its roots (a Python venv). `demo fund` checks no balance first; each testnet `demo setup` pass waits about an hour on finality. [phase-18](archive/pashov-audit-fizz/lessons/phase-18.md)

## Harness / host

- The worktree guard refuses what it cannot prove stays in the worktree (git pipelines or loops, `git` inside a path or heredoc, variable-built paths, `cd` elsewhere): run a written script or plain commands; start tmux as `tmux new-session -d -s <name> "<cmd>"`. [phase-1](archive/usdc-bridge/lessons/phase-1.md)
- A cached `aztec-node-*` install dies with the worktree that ran `install-node.sh` (`toolchain is incomplete`): install your own, select it with `AZTEC_NODE_HOME` (2026-10-03). [phase-4](archive/tob-contracts-audit/lessons/phase-4.md)
- The Aztec node's Unix sockets live in its TMPDIR: past 107 bytes (a long run id) the bind fails silently and the node never answers. [phase-10](archive/galactica-compliant-usdc/lessons/phase-10.md)
