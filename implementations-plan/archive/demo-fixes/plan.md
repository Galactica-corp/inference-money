---
plan: demo-fixes
tier: light
driver: claude-code
code_review: off
claude_model: opus
codex_model: sol
explainer: off
eli5_mode: skipped (director's brief)
trunk: dev
issues: [43, 61, 68, 72, 73, 84, 87, 88, 95]
---

## Outcome

- **2026-10-15, completed** (delivered in PR #104, awaiting merge): all nine issues, #43 with its comment's two variants and a payment that sent anything left unconfirmed on a conflict.
- **Dispositions**: `SentTx.refused` kept, its doc corrected (two integration clock specs assert it); `random.ts` reads `globalThis.process` (the showcase's polyfill made a bare `process` an unresolvable import); `readDemoFile` checks the bridge before the version, so an earlier deployment's v1 file reads as none; #87's rule covers production sources only; `castClaim` has no unit test of its own (no fake wallet; the helper's table and the e2e cover it); the unsalted `verifyDemoCast` branch is gone (no test needed it); `resilience.spec.ts`'s duplicate-nullifier race now expects the unconfirmed verdict; the committed recording keeps its old `pay` label until the next `smoke --record`.
- **Known limits**: none filed. `finalFate` trusting its node's finality is documented on the function.
- **Open items**: none.
- **Seeds**: none were issued (the director drove this run); nothing below is a live instruction.

# demo-fixes: the nine correctness fixes kept for the demo

## Outcome & Quality Bar

- **For whom**: a demo visitor on the showcase, the operator running `demo setup`, and an integrator calling bridge-core.
- **Excellent**: nothing that may have reached the node is sent again on the node's word alone (#43, #72). A claim survives a reorg that moves its Inbox leaf (#61). The page tells no untruth about privacy or traffic (#68, #88). Each fix is the smallest one the issue names, and it has a test for each branch.
- **Good enough**: no e2e scenario is added. The committed recording keeps its old `pay` label until the next `smoke --record`.

## Scope (decided)

The nine issues, plus #43's two variants named in its comment. #72 keeps bridge-core's own pre-send list refusals retryable through a marker class. The director answered both points on 2026-10-15. Not in scope: `deployments/`, `networks.ts`, `toolchain.json`, returns (`waitReturnable`), the deployer's `reclaim`.

## Architecture & Implementation

One arc, three phases by package. File map, change, test:

**Phase 1: bridge-core**
- #84 `merchants.ts` `paymentSide`: `merchantStatus(list, from, stamp?.at)`. Test (`merchants.test.ts`): a list synced before a switch-off and a stamp read after it give `Side.First` (the user side).
- #72 `merchants.ts`: export `class ListRefusal extends Error` (a rule refusal raised from the list before proving). `withFreshList` retries only when the rule is a stale-list rule AND the error is a `ListRefusal` or has a `SimulationError` (`@aztec-labs/stdlib/errors`) in its cause chain (depth 6, as `isUserRejection`). `payments.ts`: the three `throw new Error(TOKEN_REFUSALS.x)` in `openRequest`, `transferPrivate`, `payRequest` become `throw new ListRefusal(...)`; the message is unchanged. Tests (`merchants.test.ts`, one table): rule text on a plain `Error` is thrown with no retry; a `SimulationError` without a stale-list rule is thrown with no retry; the same text as a `SimulationError`, as a cause of one, or as a `ListRefusal` retries once; a retry that fails again is thrown, with no third attempt.
- #61 `claim.ts`: `waitConsumable` throws `MessageNotConsumableError` (same text). New `withRebuiltTicket(t, l1, m, keep, use)`: runs `use(t)`. On a missing message (that error, or `NOT_YET_CLAIMABLE` text), it runs `reconcileDeposit(t.draft)` once. When the result is a ticket whose `leafIndex` or `messageHash` differs, it calls `keep(rebuilt)` first, then `use(rebuilt)` once, outside the first catch. Otherwise it rethrows the first error. The rebuild reads L1 as the reader shows it now (receipt by hash, else the log scan), not a finalized log: that is `reconcileDeposit`'s contract, which the issue names. Test (`deposit.test.ts`, its fake L1, one table): the stored ticket says index 42; L1 says 43 (retried, `keep` before the second `use`), the same leaf and key, `pending`, `not-deposited` (each rethrows the first error); both triggers (the exhaustion error and the missing-message text); a `keep` that throws stops the retry; a second missing-message failure escapes with no third `use`; any other error makes no reconcile.
- #73 `random.ts`: at module evaluation, throw when `typeof process !== "undefined" && process.env?.SEED`; the message names the predictable-randomness hazard. The leaf subpaths import nothing from `random.ts`. Rewrite `random.test.ts`: a child `bun` under `SEED=1` imports `@inference-money/bridge-core` and exits non-zero with `SEED` in stderr; it imports `/manifest`, `/rules`, `/types` and exits 0; without `SEED` the main entry exits 0. `docs/integration.md`: one line.

**Phase 2: demo + deployer**
- #61 `demo/src/flows.ts` `castClaim(s, t, onWait, consent, rebuild?: { l1: L1Ctx; keep(t) })`: wraps its consumed-check, wait and claim in `withRebuiltTicket` when `rebuild` is given (`smoke` and `claimAgain` pass none). `deployer/src/demo.ts`: `SetupOps.claim(t, keep)`; `seedAll` stores a rebuilt ticket in `plan.tickets[seed]` (`store.write`) and passes it to `keepUntilFinal`. Test (`demo.test.ts`): an op that calls `keep` leaves the rebuilt ticket stored, and `finality` receives it. `castClaim` itself gets no unit test: it has no fake wallet today, the helper's table covers the logic, and the e2e runs its normal path.
- #68 `demo/src/world-view.ts`: `HIDDEN.pay = ["payer"]`. `docs/integration.md` "Visible": a merchant's x402 prices are public, so a request payment's amount usually names its merchant.
- #43 `demo/src/sent.ts`: keep `SentTx.refused` (two integration clock specs assert it) and correct its doc: the node's word alone, proving nothing. Only `fateOf` stops reading it.
- #95 `demo/src/files.ts`: the schema accepts version 2 only; `readDemoFile` refuses another version, naming `demo setup`; drop `castKeysOf`'s null. `cast.ts`: `CastKeys.merchantsSalt: string`; drop the unsalted derivation. `deployer/src/demo.ts`: drop `keptSalt`'s v1 branch. `deployer/src/verify.ts` `verifyDemoCast`: check only the published salted cast (the brief: no test needs the unsalted one). Its branch runs only off `local` and `testnet`, which the manifest schema does not admit today. Tests: `files.test.ts` (v1 refused), `cast.test.ts` (null case gone), `demo.test.ts` (v1 keptSalt case gone).
- #87 `deployer/src/deploy-l2.ts:68`, `local-actors.ts:11,26`: `randomSecret()`. Each value is a deploy salt, an account secret or an authwit nonce, so behaviour does not change. Add `biome/no-fr-random.grit` in a `biome.json` override over production sources (tests and `packages/integration` excluded); `packages/bridge-core/src/random.ts` holds no such call. This scope is narrower than the issue's literal "outside random.ts": tests keep `Fr.random()` for non-secret fixtures, and the PR says so. Check it by hand: a planted `Fr.random()` in a source fails `bun run lint`, the same line in a test passes.

**Phase 3: showcase**
- #43 `live/actions.ts` `fateOf`: a dropped copy gets `finalFate(node, hash, expiresAt)` always. `withConflictRetry`: rethrow at once when `kinds` is empty (a deposit never re-runs); with no send journalled since the attempt began, run once more (a conflict found before sending); with one, a one-send action is decided by `fateOf`, and a multi-send action (`pay`: an opening, then the payment) is unconfirmed (`MAY_STILL_LAND`), since its opening may land and a re-run would open another request. `pay`: forget the stored request only on a `ListRefusal` for the payment rule. Tests (`actions.test.ts`): a refused copy stays unconfirmed until a finalized block passes its expiry, then is sent again (the finalized-revert case stays); a deposit conflict is thrown after one attempt; a `pay` conflict after a send is unconfirmed after one attempt, before any send it runs once more; a payment refusal by text alone keeps the request.
- #61 `claimDeposit`: passes `rebuild` with `readerOf(ctx, p)` and a `keep` that stores the ticket. `claimed: true` is written onto the latest stored entry. Test: the mocked `castClaim` calls `keep`; the store then holds the rebuilt ticket with `claimed: true`.
- #87 `openFor`: `randomSecret()`.
- #95 `build/target.ts`, `src/env.d.ts`, `src/config/network.ts`, `src/demo/wallet.ts`: the salt is `string`; `target.test.ts` drops its v1 case and checks that v1 is refused.
- #88 `demo/useOpening.ts`: export `openOnce(start)`, a memoized starter (one promise per page); `useOpening(open, needed)` subscribes in an effect only when `needed`, and its cleanup only unsubscribes. `main.tsx`: `openDemo = openOnce(() => import("./demo/start").then((m) => m.startDemo()))`. `App` takes `openDemo` and passes `needed = modeOf(hash) !== "tour"` (`#proving` included). Tests: `App.test.tsx` under StrictMode, views stubbed, a deferred start counted inside `openOnce`: `#recorded` starts nothing; `#live`, then `#recorded`, then `#live` starts exactly once. `e2e/specs/tour.spec.ts` opens `/#recorded` first and asserts that `me.egress.allowed` holds no request to the node's or anvil's origin through the replay, before it switches to live.

**Alternatives not taken**: #61 inside `waitConsumable` (it has no L1 reader); the literal #72 (it drops the stale-list retry for local refusals); a `git grep` lint step for #87 (the Grit plugin reports through Biome, editors included); an `inferable` third visibility for #68 (the issue calls it richer, not needed).

## Security & Adversarial Considerations

- **Threat**: a node, or one of several behind a balancer, answers with rule text or `Invalid tx:` after it holds the tx. The fixes stop treating such text as proof that nothing was sent (#43, #72, the `pay` variant). A genuine `SimulationError` arises only before submission (the PXE's execution, or a decoded `simulatePublicCalls` revert); JSON-RPC errors become a plain `Error` whose cause is the parsed JSON (`safe_json_rpc_client.js`), which no field can turn into that prototype.
- **Known limit, unchanged**: `finalFate` trusts its node's receipts and finalized block. A node that lies about finality, or balanced backends that disagree, can still make a sent copy read `gone`. The fixes remove refusal text as a reason to resend; they do not authenticate finality (that would need proof verification or cross-node agreement, beyond these issues).
- **Reorg (#61)**: the rebuilt ticket comes from `reconcileDeposit` as the reader sees L1 now, which checks the router, the reader's chain and every draft field. The draft and salt never change. A wrong or stale rebuild only fails a claim; it cannot redirect one. A lying L1 RPC can only make the retry fail.
- **SEED (#73)**: fail closed at import; the browser's empty `process.env` makes the check a no-op there. It cannot see a SEED cleared after the SDK seeded itself.
- **Demo file (#95)**: a hand-edited v2 file with a valid salt is still trusted configuration; dropping v1 narrows what a build accepts, it authenticates nothing.
- **Privacy (#68, #88)**: the feed no longer calls an inferable field hidden; a `#recorded` page contacts neither chain.
- **Supply chain**: no new dependency; frozen lockfile.

## Assumptions

- **Facts**: `EmbeddedWallet.sendTx` simulates before `super.sendTx`, and the base send proves before `node.sendTx` (`wallets/dest/embedded/embedded_wallet.js:85-153`); the bridge sends with `NO_WAIT`, so nothing simulates after submission. Node errors are plain `Error` (`foundation/dest/json-rpc/client/safe_json_rpc_client.js:168-182`, `fetch.js:31-48`). `finalFate` returns `gone` for a revert in a finalized block, or once a finalized block passes the expiry without the tx (`payments.ts:310`). An Inbox message hash includes its leaf index, so a reordering reorg changes the key too. The leaf subpaths import only viem/zod (`manifest.ts`, `types.ts`, `rules.ts`). The testnet demo file is v2 (`deployments/testnet-demo.json`). The Grit plugin in an override flags sources and skips tests (probed on Biome 2.5.14).
- **Inferences**: a stale ticket's key has no witness, so `waitConsumable` exhausts on `waiting-for-inclusion`; the rebuild handles that and a claim's missing-message failure alike. The showcase bundles one `@aztec-labs/stdlib` for the wallet path, so `instanceof SimulationError` holds; a copy from elsewhere only stops a retry (fail closed).
- **Asks**: none open (scope answered by the director).

## Validation gates

Every gate: `bun run lint && bun run typecheck` plus the touched packages' unit tests, exit 0.
- **Phase 1**: `bun run --cwd packages/bridge-core test`.
- **Phase 2**: `bun run --cwd packages/demo test && bun run --cwd packages/deployer test`.
- **Phase 3**: `bun run --cwd apps/showcase test:components`, `bun run --cwd apps/showcase build:testnet` (7 checks pass), `RUN_ID=demo-fixes bun run test:e2e` (all specs pass).
- **Final**: `bun run test && bun run lint:actions`; `git diff --stat origin/dev` touches no `deployments/`, `networks.ts`, `toolchain.json`.

## Delivery

Single arc, one branch (`worktree-demo-fixes`), one PR to `dev` with the `e2e` label and `Closes #43, closes #61, closes #68, closes #72, closes #73, closes #84, closes #87, closes #88, closes #95`. The close-out is the PR's final commits. Phases are sequential (Phase 3 uses 1 and 2); no lanes.

## Post-implementation

1. Codex fix loop over `git diff origin/dev...HEAD`: `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol`, with plan.md, the adversarial ask, and the no-over-engineering and comment-quality rules verbatim. Verify each finding, fix, commit, `resume-codex.sh` with the fix diff. Stop when a round has nothing material; at round 3 with material findings, send BLOCKED. A fix that adds state, a lifecycle, a protocol, a recovery policy or a public contract stops for the director.
2. Rebase onto `origin/dev`, rerun the final gate, `gh pr create --base dev --label e2e`. Then the close-out commits: the Outcome block after the front matter (with `Known limits:` and `Open items:` lines and the retired seeds), lessons promoted into `implementations-plan/lessons.md` with a pruning pass, open items filed as issues, `git mv implementations-plan/demo-fixes implementations-plan/archive/demo-fixes` alone in its own commit, the index line moved to `archive/index.md`. Then `gh pr checks --watch` and DONE to the director. Never merge.
3. After the merge (the director or owner merges): `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/demo-fixes/plan.md` succeeds → `ExitWorktree` (`keep`), then `agent-worktree done demo-fixes --merged --trunk dev`. Relay a refusal; never force.

| Open work | Home |
|---|---|
| Work inside this PR | this plan and the PR |
| A bug or gap that outlives it | a GitHub issue with a domain label and a `Record` link |
| A suspected exploitable weakness | a private draft security advisory |
| A finding that needs unsupported conditions | a closed `known-limit` issue |

## Audit

Codex (gpt-6.1-sol, high), session `01a14087`: **conditional approve** — close the journalled multi-step `pay` retry, correct the finality and reader-trust claims, add the retry-bound and persistence-wiring tests.
- Adopted: the `pay` conflict after a send is unconfirmed (demonstrated: two openings could land); the trust claims rewritten (the `finalFate` known limit, `SimulationError`'s sources, `reconcileDeposit`'s current view, #73's and #95's limits); the Facts corrected; the test tables extended (#72 no-rule and second-failure, #61 every verdict, `keep` order and failure, #88 StrictMode with `openOnce`, `egress.allowed`); #87's narrower scope stated.
- Rejected: a `castClaim` unit test (no fake wallet exists; the helper's table and the e2e cover it); keeping the unsalted `verifyDemoCast` branch (the brief removes it unless a test needs it; none does).

Fix loop (session `01a140a4`): round 1, 0 material (two test gaps fixed); round 2, verified; round 3 (the `resilience.spec.ts` update after the full e2e run), verified.
