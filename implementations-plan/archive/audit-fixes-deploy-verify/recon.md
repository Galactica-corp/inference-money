# Recon: audit-fixes-deploy-verify

Base: `origin/dev` at `ad77d10`. One reuse sweep (Sonnet explorer) plus the driver's own reads of every file the plan edits. No open GitHub issues (`gh issue list --state open` is empty).

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| Derive a CREATE address locally, pin the nonce, compare the receipt | none in source: grep `getContractAddress\|getTransactionCount\|encodeDeployData\|blockTag` over `packages/` and `apps/` `*.ts(x)` (non-test) found nothing; no `nonce:` is ever passed to `deployContract`. `packages/deployer/src/l1.ts` `deployEvm` + `mined` are the place | adapt `deployEvm` (same `L1Signer` shape) |
| Refuse a replacement's receipt | `packages/bridge-core/src/withdraw.ts:152-155` compares `receipt.transactionHash` with the sent hash | reuse the idea; viem 2.56.7 `waitForTransactionReceipt` resolves with a replacement's receipt (`actions/public/waitForTransactionReceipt.ts:314-323`) |
| Fetch a tx by hash and check its input | `bridge-core/src/withdraw.ts:244` (`getTransaction`), `apps/showcase/e2e/fixtures/chain.ts:80-85` (e2e only) | build new in `verify.ts`, same viem calls |
| Warning vs failure in `verify` | `deployer/src/preflight.ts` `Check { ok, warn? }`; `verify.ts:29` `warn()`; `assertAllPass` prints `ok`/`warn`/`FAIL` and throws on `!ok`; `verify-cli.ts:48-49` counts warnings | reuse as-is |
| A boolean CLI flag | `cli-args.ts` `SWITCHES` (`rotate`), `COMMANDS.verify.flags` | reuse: add `allow-pending` |
| Entry and guardian-slot delay reads | `token-reads.ts` `entryDelay`, `guardianDelay`, `DelayState`; `verify.ts:181-200` `delayCheck`/`verifyDelays` (a pending change already only warns) | adapt `delayCheck`/`verifyDelays` |
| Pending switch reads | `bridge-core/src/merchants.ts` `MerchantEntry {off, scheduledOff, changeAt}`; `merchantStatus().pending` is `changeAt > at`, true even when the scheduled value equals the current one (a switch back on keeps the entry marked) | reuse the entry; a pending switch is `changeAt > at` (`merchantStatus().pending`), marked-but-unchanged included |
| `merchants list` showing pending changes | `deployer/src/admin.ts:131-146` `describeMerchants` | unchanged (already shows both) |
| Manifest optional fields | `bridge-core/src/manifest.ts` strict schema; `.optional()` precedent `l2.sponsoredFpc/admin/interimAdmin`. The module is a leaf the showcase's build config loads under Node: no relative imports | adapt: add optional fields with literal bounds |
| Canonical vs bound rollup | `bridge-core/src/network.ts:56-81` `assertNetworkIdentity` reads the registry's canonical rollup and throws on any mismatch; `TokenPortal.sol:98` has `IRollup public rollup`, but `TOKEN_PORTAL_ABI` (`abi.ts:233`) lacks the view; `abi.test.ts` pins the ABI against the forge build | adapt; one ABI line |
| Gate callers | `verify.ts:254-257`, `smoke.ts:333`, `apps/showcase/src/demo/start.ts:18`, `packages/integration/test/deposits.test.ts:236-241` | adapt each to the returned `{ depositsOpen }` |
| A page-level notice | `apps/showcase/src/ui/Layout.tsx` `notice` slot (holds `PrestoRibbon`, `LiveMode.tsx:177-184`); `role="alert"` footer pattern (`LiveMode.tsx:166`); `disabled={!ready \|\| v.busy}` on Try it | adapt: notice in the slot, Try it disabled for a deposit draft |
| Showcase component tests | `LiveMode.test.tsx` `fakeEngine`, `ready = { status: "ready" }`, `TESTIDS` | reuse; `ready` gains `depositsOpen` |
| Browser e2e that rewrites an RPC answer | `apps/showcase/e2e/fixtures/rpc.ts` `recordRpc` routes the run's anvil and node origins with `context.route` and `fallback`; Playwright runs the last-registered route first | build new spec on the same mechanism |
| Verify drift integration cases | `packages/integration/test/operator.test.ts:106-226` `failing(m)` cases ("a delay setting not yet synced…" filters by check name) | adapt: new creation-tx and pending cases; update the delay case's filter |

## Conventions to match

- Checks are `check(name, ok, detail)`, `pin(name, actual, want)`, `warn(name, detail)`; a throwing read is a failed check via `attempt`.
- Deployer unit tests are `bun:test` with `--preload ../../test-preload.ts`; fakes are plain objects cast to viem types (`bridge-core/src/network.test.ts:10-32`).
- Integration cases assert the exact list of failing check names.
- Showcase: vitest + Testing Library, `TESTIDS` for selectors; jsdom tests fake the wallet layer.
- Complexity: cognitive ≤ 15, ≤ 80 lines per production function (biome).

## Collision and dedup risks

- Parallel batches edit `verify.ts` (sdk-fees: a sponsor check), `abi.ts`, `actions.ts`, `demo.ts` (claims), `docs/operations.md` and `docs/integration.md` (all), `testnet.ts` (keyed-ops: inside `selfFundedFees` only; this batch may edit `deployTestnet`). Keep hunks small and local; rebase on `origin/dev` before the PR.
- `fee-juice.ts`, `preflight.ts`, `redact.ts` are out of scope (they belong to the keyed-ops batch).
- Integration ordering: `merchants.test.ts` leaves `m1` marked (`off == scheduledOff == false`, `changeAt` in the future) before `operator.test.ts` runs. Under the strict policy (a pending switch is any `changeAt > at`, marked-but-unchanged included), every verify unrelated to pending changes must pass `allowPending`, and `transfers.test.ts` must restore its short-delay merchant.
- The committed `deployments/testnet.json` and `apps/showcase/src/test/manifest.fixture.json` lack every new field, so each must be optional.
- `docs/architecture.md:32` already names the deposit strand; `docs/integration.md:56` says "withdrawals still pay" without the condition (the bound rollup must still prove). `implementations-plan/follow-ups.md:23` holds O-11.
