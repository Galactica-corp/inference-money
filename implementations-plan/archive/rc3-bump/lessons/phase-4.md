# Phase 4 — converge

## I2 — portal and router bytecode

- Two scratch trees of `contracts/evm/src` + `foundry.toml`, dependencies copied flat (no symlinks): one with the
  worktree's `@aztec-foundation/l1-artifacts@6.0.0-rc.6`, one with `6.0.0-rc.1` from `npm pack` (its integrity equals
  the base lock's). Foundry 1.7.1: `forge inspect <c> bytecode` and `deployedBytecode` are identical for
  `TokenPortal` and `Permit2DepositRouter`. So `test:evm:formal` and `test:evm:slither` are not required by the gate.

## Local Foundry

- PATH's forge here is the Aztec node's 1.4.1, so `forge fmt --check` reformats untouched files. The repo's 1.7.1 was
  fetched from the foundry-rs release, its sha256 equal to GitHub's asset digest and `gh attestation verify` bound to
  `foundry-rs/foundry` `release.yml@refs/tags/v1.7.1` (`4072e487`), into `~/.cache/inference-money/foundry-1.7.1/bin`.

## Local node install

- The first integration run died at node start: `Cannot find module 'bcrypto.node'`. Phase 1 locked
  `packages/local-network/toolchain` with `--ignore-scripts`, so its one trusted build never ran, and `install-node.sh`'s
  frozen install reported no changes. A reinstall from an empty `node_modules` then failed on `node-gyp: command not
  found` (Bun ships none); with npm's bundled `bin/node-gyp-bin` on PATH, `bcrypto` built and the node booted. CI
  installs that tree fresh. `test:e2e` names its own run (`showcase-e2e-<pid>-<time>`, `e2e/run/common.sh`) whatever
  `RUN_ID` says.

## D10 — the refund integration spec, dropped

- A sent tx returns a receipt and offchain output only (aztec.js rc.3 `TxSendResultMined`), and `UintNote::partial`
  draws its randomness at proving, so a direct client never learns a `transfer_private_to_public_with_commitment`
  commitment now that it emits no effect. Only a pull-and-refund contract can use it, as upstream's AMM does.
- Its failure mode (the owner's PXE finding a self-delivered partial note completed in public) is `[A22]` one-payment's
  (m1 opens for itself, alice pays publicly, m1's private balance asserted). The PXE resolves every unconstrained
  self-send to an address-derived tag (`private_execution_oracle.resolveTaggingStrategy`), so the refund to self
  announces no handshake.

## Docs

- `docs/ci-pipeline.md` said the node toolchain lock is "the same tree" as an aztec-up install. aztec-up's install is an
  unlocked `npm install`; a bump re-resolves our lock with Bun, keeping transitive pins, so the claim was narrowed.

## Gate

- `compile.sh --check`: all three crates match their source (Token `0x11db2d2d…ab70`).
- Lint, typecheck, unit tests (bridge-core 197, deployer 89, local-network 16, demo 12, contracts 8), showcase
  component tests (99, 5 skipped), `build:testnet`, `test:evm` (130), `test:evm:gas`, actionlint: exit 0.
- `test:evm:fork` through `https://ethereum-sepolia-rpc.publicnode.com`: 12/12, the new Inbox included.
- `probe:testnet`: 19/19.
- `test:integration` (`RUN_ID=rc3-bump`, the rc.3 node): 53 specs and 6 clock specs, 0 failures, 2 536 s wall.
- CI Presto compat step, run locally from six roots: the real pair skips (`run=false`, the warning); without its env
  it fails; a forced-equal pair runs; a missing package, a range pin and another pair fail.

## Codex fix loop (gpt-6.1-sol, high)

- Round 1: no material finding, two minor. Fixed: `docs/operations.md` "A mark the admin keeps" still described the
  rc.1 mark (a schedule of the current value keeps an entry pending for D, and the guardian cannot end it); it now says
  only a real switch-off marks, undone and scheduled again to persist (a repeated `off` is a no-op), and the guardian's
  cancel unmarks. Kept: the comment over `request_effects()` in `test/rules_requests.nr`, which states what the
  returned tuple holds; the signature does not.
- Round 2: no material finding; the operations fix confirmed against the token and rc.6 (a read anchors at a committed
  block, so no read sees between a one-tx `on` and `off`); the `request_effects()` comment kept by agreement. One minor,
  fixed: `docs/integration.md` said only a contract refunding "in the same tx" can use a refund commitment, but a
  calling contract may keep it and refund later; and "unlike upstream" implied upstream stamps.
- Gates after the fixes: `test:e2e` 9/9 (4.9 min of specs, 558 s wall, its own run id).
