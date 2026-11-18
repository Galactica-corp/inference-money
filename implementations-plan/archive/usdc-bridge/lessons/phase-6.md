# Phase 6 — Integration suite (`packages/integration`)

Status: **green 2026-09-26** (gate evidence below).

## Gate evidence

`bun run test:integration` → exit 0: **15 pass, 0 fail, 58 assertions, 3 files, 432 s**, against node 5.0.0 with JS 5.2.0. No fallback pin was needed; inference 1's execution and API half holds locally.

- The harness brought up its own run (`0beccc70-it-531103`), deployed, and verified every read-back before the first spec.
- Teardown stopped exactly its two groups: aztec pgid 531241 and anvil pgid 531226, with 0 members left in either.
- It left 0 registry rows, no net state, no forge cache, no wallet tmp dir and no local manifest.
- Spec → test: deposits.test (1 public claim, 2 sponsored private claim + payer, 3 wrong-recipient relayer, 4 double claim public + private, 10 receipt timeout → reconcile, 11 lost wallet response → log scan, 14 network identity); exits.test (5 public exit with Outbox before/after, 6 sponsored private exit + payer, 7 memory-less resume to another recipient, 8 withdraw replay, 12 two identical exits in one tx); guards.test (9 deployer-bound init, 13 unfunded sponsor, 15 pause).
- Bun prints only failures when stdout is not a TTY, so the per-spec pass lines are not in the log; the summary counts are.

## What was built

- **`packages/integration`** (bun:test).
  - `test/setup.ts` is a `--preload` whose `beforeAll`/`afterAll` run once around the whole suite.
  - `test/harness.ts` owns the run:
    - its own network (`it-<pid>`), or attach via `NET_L1_RPC` + `NET_NODE_URL`;
    - `deployLocal`, which verifies every read-back before any spec runs;
    - an owned tmp scope for the wallet stores;
    - two wallets: the actors' and the heartbeat's;
    - a block heartbeat;
    - teardown of every step in reverse, each even if an earlier one failed. Teardown removes the run's forge cache and manifest, so per-pid runs leave nothing behind.
  - `test/actors.ts` holds fresh L1 keys (anvil `setBalance` plus a MockUsdc mint, with Permit2 approved through core's `ensurePermit2Allowance`) and fresh sponsor-deployed L2 accounts. The flow helpers call core's real API.
  - Specs: `deposits.test.ts` (1, 2, 3, 4, 10, 11, 14), `exits.test.ts` (5, 6, 7, 8, 12), `guards.test.ts` (9, 13, 15).
  - CI `integration.yml` covers biome and typecheck; the live specs are this local gate. There is a root `test:integration` script.
- **Fee payer, observed rather than inferred.**
  - The actor wallet's node client is wrapped: every `sendTx` records `tx.data.feePayer` (the kernel's committed payer) and the tx hash before forwarding.
  - The heartbeat runs in a separate, unrecorded wallet, so the record holds only actor txs.
  - Specs 2 and 6 assert that the submitted tx's payer is the SponsoredFPC, which proves inference 4 for the embedded wallet.
- **Heartbeat.** The heartbeat account revokes a random, never-granted public authwit every 3 s through `withBlockHeartbeat` (the freeze's cheapest public tx). This also exercises the AuthRegistry the deploy published at `0x1e8e…`. The Phase 5 open risk about public authwits is closed locally: specs 5, 8 and 12 run public burns authorized through that registry.

## Core changes the suite forced

1. **`pause.ts`** (new): `isBridgePaused` / `assertBridgeLive` / `BridgePausedError`.
   - The flag is read from public storage at the artifact layout's `is_paused` slot; the contract has no getter.
   - `submitDeposit` now **requires** the L2 node and reads the flag before the signature and again before the send (accepted risk 4, D20).
   - `verify.ts` uses the same reader instead of a hard-coded slot.
2. **`FeeChoice` is honored for public ops too** (`feeFor`). Before this, `claim` and `exitToL1` silently ignored an explicit `fee: "sponsored"` on public operations and always used the wallet's default payer.
   - That default is the sender's own Fee Juice, which a fresh account does not have, so public claims by new users could not be paid.
   - Defaults are unchanged: private ops are sponsored, public ones use the wallet.
3. **`reconcileDeposit` read a cached tip.**
   - Why it matters: viem caches `getBlockNumber` for about 4 s per client. After `waitForTransactionReceipt`, the cached tip can be the block **before** the deposit. The log scan then stopped one block short and returned "pending" (spec 11, run 2).
   - Worse: a cached tip below the `finalized` block could skip blocks whose absence the "not-deposited" verdict relies on. The user would discard a claimable deposit.
   - Fix: an uncached tip read, and the scan runs through `max(tip, finalized)`. A unit test pins the lagging-tip case.
4. Deployer: an `index.ts` entry point, plus:
   - `openLocalWallet`, extracted from `withLocalWallet`;
   - `enterOwnedTmpDir`, the unscoped form a suite's hooks need, with `withOwnedTmpDir` rebuilt on it and its tests unchanged;
   - `l1Chain`, `forgeRunDir`.

## Findings

- **Deployer-bound instances cannot be published by anyone else.** The ContractInstanceRegistry takes the deployer from `msg_sender`, so an attacker publishing "the same" instance lands at another address; the owner-bound address stays unpublished.
  - The first draft of spec 9 had the attacker publish, then asserted only that the attacker's constructor call failed. That assertion passed on a "Contract … is not deployed" error, not on the deployer check.
  - The spec now asserts three things: the attacker's publish leaves the address unpublished; after the owner publishes (the window a split publish/initialize would open), the attacker's constructor fails with "not the contract deployer"; the owner's succeeds.
- **Core names its L1 signer by address**, the JSON-RPC account a browser wallet exposes. A fresh test key is not one of anvil's, so viem sent `eth_signTypedData_v4` to anvil ("No Signer available"). The actors wrap their wallet client to sign locally for their own address, as an injected wallet does. Core is unchanged: its production path is exactly this JSON-RPC shape.
- The local 5.0.0 network proves epochs within seconds under the heartbeat. Every exit spec ran its real Outbox withdraw.

## Attempts

- Run 1: 1 pass / 14 fail. Thirteen failures were the signer issue, one was the spec 9 flaw above.
- Run 2: 14 pass / 1 fail. Spec 11 hit the cached tip.
- Run 3: 15 pass / 0 fail, clean teardown.

## Moved from lessons.md

- The local network skips real-proof verification (5.0.0): proof acceptance is proven only on testnet. [plan](../plan.md)
