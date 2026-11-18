---
plan: audit-fixes-claims
tier: light
driver: claude-code
eli5_mode: file
code_review: off
claude_model: opus
codex_model: sol
explainer: off
harden: no
quality: production
trunk: dev
---

## Outcome

**2026-10-13, completed.** Delivered in PR #41 to `dev`, with the close-out commits on the same PR.

- **Shipped**:
  - `reconcileDeposit` answers `not-deposited` only while Permit2 shows the permit's nonce unused at the finalized block past the deadline.
  - A local key's send keeps its submission on a refusal-shaped error.
  - `castDeposit` hands a stored prior draft to its owner to keep, and stores the new draft again with its tx hash.
  - `demo setup` and the smoke keep replaced drafts as `abandoned-<nonce>.json` and archive `setup.json` as `setup-<tag>.json`.
  - The showcase archives a deposit its L1 reader calls never sent and lists it with Check again; it marks final a claim the node calls finalized. It drops neither.
  - Docs and assurance map A11 and A19 are updated.
- **Tests**: unit (the nonce word, bit and block; the refusal gate; the keep-then-replace order; the archive transitions), integration (the nonce read on a real Permit2 once finality reaches a landed deposit), e2e A11 (archived, kept across a reload, re-checked).
- **By decision, not open**:
  - Final records get no row; only archived drafts get Check again (owner's call, through the director).
  - The smoke still removes its own finished journal, and an undecodable record is still skipped. Both are outside this plan, and `architecture.md` and A11 say so.
  - A JSON-RPC wallet's own refusal still frees its draft (Security).
- **Open items**: #40 (on a local network, a demo account's withdraw can fail gas estimation once the publisher's tips reach 120 gwei; unrelated to this change).
- **Seeds retired**: this plan's `/goal` and `/loop` seeds are retired. This is a record, never a task list.

# audit-fixes-claims: a claim record is archived or marked final, never deleted

A deposit's USDC sits in the portal until someone presents its claim salt, and the salt lives only in the client's record. This plan guarantees that no such record is deleted or overwritten on a reader's answer: the showcase, `demo setup` and the smoke archive a draft their L1 reader calls never sent, and mark final a claim their node calls finalized. It also makes `reconcileDeposit`'s "never sent" require the permit's Permit2 nonce to be unused at the finalized block.

## Outcome & Quality Bar

**For whom**: a depositor whose L1 reader or Aztec node answered wrongly or late, on the showcase page or in `demo setup`; and an integrator who copies bridge-core's recovery pattern for real funds.

**What excellent looks like**:

1. No claim salt or claim draft is deleted or overwritten on one remote answer. Each record is archived or marked final, in `localStorage` or in the deployer's state dir.
2. An honest but lagging L1 reader can no longer produce `not-deposited` for a deposit that mined: the verdict also needs the permit's Permit2 nonce unspent at the finalized block.
3. The page shows an archived deposit as a row with a "Check again" button, and its copy says what happened and what to do next.

**Good enough**: final records stay silent in `localStorage` (they are the success path); recovering an archived salt by hand is acceptable, as is a second deposit the visitor chooses to make. No second L1 or L2 source is added (the owner declined one earlier).

## Architecture & Implementation

**bridge-core** (`packages/bridge-core`)

- `abi.ts`: a new export `PERMIT2_NONCE_ABI` with `nonceBitmap(address owner, uint256 wordPos) view returns (uint256)`. `abi.test.ts` pins it to `forgeAbi("ISignatureTransfer")`.
- `deposit.ts` `locateDeposit`: after an empty scan with the finalized block past the deadline, read `nonceBitmap(s.account, nonce >> 8)` on the draft's Permit2 (`d.typedData.domain.verifyingContract`) at `finalized.number`. A set bit answers `"pending"`. A failed read throws into `reconcileDeposit`'s catch, which answers `"pending"`. The owner is the submitter: the router passes `msg.sender` as the Permit2 owner (`Permit2DepositRouter.sol:100`). Why the finalized block: once its timestamp is past the deadline, no later block can include the permit, so a deposit that mined at all mined at or below it, and its bit is set there.
- `deposit.ts` `signAndSend`: clear `submission` on a rejection only when the signer is a JSON-RPC wallet (`signerOf(l1)` is a bare address or an account of `type: "json-rpc"`). A local key's raw send has no user to refuse it, so a rejection-shaped error there came from the RPC and the draft stays submitted.
- `errors.ts`: unchanged. The local-key gate removes the RPC's power over this path; the classifier stays as the wallet path needs it.
- Docs: `Reconciled` names the nonce condition; `claim.ts`'s `waitClaimFinalized` and `claim` say finality is the node's word and records are archived, never deleted.

**demo** (`packages/demo/src/flows.ts`)

- `castDeposit(s, signer, p, prior: PriorDraft | undefined, persist, on?)` with `interface PriorDraft { draft: DepositDraft; abandon(): void }`. On `not-deposited` it calls `prior.abandon()` before any approval or send. Contract: `abandon` persists the whole prior synchronously and throws on failure; a throw stops `castDeposit` before the new draft exists, so a retry finds the original salt in place. `SetupOps.deposit` carries the same type.
- It calls `persist(d)` a second time once `submitDeposit` returns, so the stored draft carries `l1TxHash` and `ticketByHash` works after a reload.

**deployer** (`packages/deployer/src`)

- `run-state.ts`: `StateDir.rename(from, to)` (atomic, directory synced); `keepAbandonedDraft(dir, d)` writes `abandoned-<permit nonce hex>.json`. Named by nonce, a crash-and-resume that abandons the same draft twice rewrites the same file.
- `demo.ts`: `PlanStore` becomes `{ read, write, abandon(d), archive(tag) }`; `clear` goes. `seedTicket` hands `castDeposit` a `PriorDraft` whose `abandon` calls `store.abandon`. `runSetup` ends with `publish(tag)` then `store.archive(tag)`, which renames `setup.json` to `setup-<tag>.json`. `demoSetup` resumes only from `setup.json`, so an archived file never re-runs or re-publishes a setup.
- `smoke.ts`: its deposit step passes a `PriorDraft` whose `abandon` calls `keepAbandonedDraft`. The smoke's own end-of-run cleanup of `smoke.json` is unchanged (not a remote answer; another finding's surface).
- `claim-finality.ts`: comment only. `reclaim` already throws on `not-deposited`, which stops the setup with the ticket still stored; with `archive` replacing `clear`, nothing deletes it later either.

**showcase** (`apps/showcase/src`)

- `demo/tickets.ts`: `PendingDeposit` gains `archived: true?` and `final: true?` (strict schema, so declared there).
- `live/actions.ts`:
  - `fromDraft`: `not-deposited` writes `{ ...p, archived: true }` and returns copy that says the record is kept below.
  - `stillClaimed`: a finalized hit writes `{ ...p, final: true }`.
  - `claimableEntry` skips archived and final records.
  - New `archivedDeposits(ctx)` lists archived records (id, user, amount). New `recheckDeposit(ctx, id)` reads the current record inside `ctx.demo.exclusive` (a missing, final or no-longer-archived record is a no-op) and runs `reconcileDeposit` again: a ticket rewrites it as a claim (the ticket carries the same salt), `pending` unarchives it as a draft, `not-deposited` keeps it archived. Each rewrite is one `putDeposit` on the same key, which `setDurably` rolls back on a failed write. It returns a sentence for the verdict line.
- `live/engine.ts`, `live/useLive.ts`: `LiveEngine.archived()` and `LiveEngine.recheck(id)`; `useChains` refreshes the list with the payouts; `recheck` shows its sentence in the verdict and refreshes.
- `live/LiveMode.tsx`: `ArchivedDeposits` beside `Payouts`: a titled section, one `<li data-testid="archived-deposit">` per record with a "Check again" button, disabled while a run is busy. `lib/testids.ts` gains the id.

**Critical flow (showcase)**: deposit stored at "depositing" → stored again with its tx hash → reload → Claim → `reconcileDeposit` (hash, then log scan, then nonce bit) → `not-deposited` → record archived, not dropped → row with "Check again" → `recheckDeposit` → claimable, back to waiting, or still archived.

**File-level change map**: `bridge-core/src/{abi,abi.test,deposit,deposit.test,claim}.ts`; `demo/src/{flows,flows-mocked.test}.ts`; `deployer/src/{run-state,run-state.test,demo,demo.test,smoke,claim-finality}.ts`; `showcase/src/demo/{tickets,store.test}.ts`, `showcase/src/live/{actions,actions.test,engine,useLive,LiveMode,LiveMode.test}.ts(x)`, `showcase/src/lib/testids.ts`; `showcase/e2e/{fixtures/rpc.ts,specs/resilience.spec.ts}`; `integration/test/deposits.test.ts`; `docs/{integration,architecture,operations,assurance-map}.md`.

**Trade-offs and alternatives not taken**:

- *Archive in the persist closure* instead of a `PriorDraft` callback: fewer signature changes, but it hides the rule "a prior is replaced only after a `not-deposited` verdict" inside each caller. The callback puts the verdict and the archive side by side.
- *Abandoned drafts inside `setup.json`* instead of their own files: one fewer helper, but the smoke removes `smoke.json` at the end of every run, so the smoke would need a second mechanism. One nonce-named file serves both.
- *Show final records in the page too*: every successful claim would leave a row for ever. Rejected; a final record is the success path.
- *An L1-anchored finality check*: a second trusted source, which the owner declined earlier.

## Security & Adversarial Considerations

- **Trust model**: the L1 RPC (the pinned public endpoint by default) and the Aztec node are unauthenticated readers, so no answer of theirs may authorize an irreversible step on the client. After this plan their answers can only delay a record or archive it.
- **Named residuals**: a reader that misreports Permit2's state too still yields `not-deposited`, and the record is then archived, not lost. A node's wrong "finalized" marks a record final; its salt stays in `localStorage` and in `setup-<tag>.json`, recoverable by hand. `demo setup` publishes the users' tag on the node's word (bounded to demo funds).
- **Send refusals**: a local key's send no longer treats refusal-shaped error text as a refusal. A JSON-RPC wallet's own refusal still frees the draft, as it must; that path keeps trusting the refusal's provenance (`isUserRejection`, `errors.ts:6-17`).
- **Storage**: archived records add no new secret class; they are the same salts, kept where they already were (owner-only state dir, mode 0700, never in a checkout; the page's `localStorage` per deployment). Abandoned-draft file names carry the permit nonce, which is public on L1 once used and secret-free otherwise.
- **Frontend**: the row renders amounts and holder names from the app's own records through React (no HTML injection); the button sends nothing on its own beyond L1 reads.
- **Supply chain / crypto / least privilege**: no new dependency, no new key, no CI permission change. The nonce read uses viem's `readContract` already in the lockfile.

## Assumptions

**Facts**

1. The router passes `msg.sender` as the Permit2 owner and emits it as `depositor` (`contracts/evm/src/Permit2DepositRouter.sol:93-116`), and `submission.account` is that sender (`deposit.ts:198`).
2. `nonceBitmap(address,uint256)` is in the repo's `ISignatureTransfer` (`contracts/evm/src/interfaces/ISignatureTransfer.sol:31`) and on canonical Permit2.
3. Inside its reader body, `reconcileDeposit` turns every non-`NetworkMismatchError` failure into `"pending"` (`deposit.ts:316-324`; the deployment checks before it throw), so a failed bitmap read can never yield `not-deposited`. The same catch means a test expecting `"pending"` passes on a broken read too, so tests assert the read itself.
4. `signerOf` returns the wallet client's own account object or the bare address (`types.ts:22-25`); every in-repo caller (showcase, deployer) signs with a local key (`demoL1`, `l1Signer`).
5. `demoSetup` resumes iff `setup.json` exists (`demo.ts:221`); `StateDir.write` already relies on `renameSync` + `syncDir` for atomicity (`run-state.ts:100-107`).
6. The showcase's deposit records are strict zod objects (`tickets.ts:7`): an undeclared field makes `read` skip the record.
7. The local network runs anvil with `--slots-in-an-epoch 1` (`local-network/src/network.ts:127`), so its finalized block is a couple of blocks behind the tip.
8. `castDeposit` has three callers: showcase `deposit` (never a prior), deployer `seedTicket`, deployer smoke.

**Inferences**

1. A deposit that mined sets its nonce bit at a block no later than the first finalized block past the deadline (Permit2 checks `block.timestamp <= deadline`; timestamps only grow). A reorg below finality is out of the model.
2. `readContract` at `finalized.number` is served by ordinary (non-archive) RPCs: finality trails the tip by about 64 blocks on Sepolia, usually inside a provider's recent-state window (not a guarantee). If not, the read fails and the answer is `pending` (a wedge, not a loss). A set bit proves the nonce was consumed or invalidated by its owner, not specifically a deposit; `pending` stays the conservative answer either way.
3. The e2e can produce a real never-sent draft by holding the deposit's `eth_sendRawTransaction`, reloading under it and aborting it (the A13 pattern), then rewriting the finalized header's timestamp, which models a wrong reader (not real deadline expiry) without moving the network's clock. The spec checks the held request targets the router and that no deposit landed.

**Asks**: none. The director's brief and the cards decide every product question (archive policy, the row, its scope). The docs phase names where kept records live and how to recover a salt from them by hand.

## Phases

### Phase 1: bridge-core verdict and send ✓

1. Add `PERMIT2_NONCE_ABI` and its pin.
2. Read the nonce bit in `locateDeposit` before `not-deposited`.
3. Gate the rejection clear on a JSON-RPC signer.
4. Update the `Reconciled`, `reconcileDeposit`, `waitClaimFinalized` and `claim` docs.
5. Tests: a deterministic nonce in word 5 at bit 255. A reader with no receipt and no logs, its finalized block past the deadline, answers `pending` with that bit set; an unrelated bit in the same word, or bit 255 of another word, leaves `not-deposited`; the stub asserts the read's address, owner, word and block. A failed bitmap read answers `pending`. A real local `Account` whose send throws rejection-shaped text stays submitted; an account of `type: "json-rpc"` and a bare address (the existing test) are freed.
6. `abi.test.ts` pins `PERMIT2_NONCE_ABI`.

**Validation gate**

- Commands: `bun run lint && bun run typecheck && bun run --cwd packages/bridge-core test` (its `test` builds the EVM artifacts first)
- Pass: exit 0; `deposit.test.ts` and `abi.test.ts` green, including the new cases.
- Layers: lint, typecheck, unit.

### Phase 2: demo and deployer keep every draft and setup ✓

1. Add `PriorDraft`, `abandon` on `not-deposited`, and the second `persist` in `castDeposit`.
2. Add `StateDir.rename` and `keepAbandonedDraft`.
3. Change `PlanStore` to `abandon` and `archive`; wire `seedTicket`, `runSetup`, `stateStore`, the smoke deposit step.
4. Fix the `claim-finality.ts`, `flows.ts` and `demo.ts` comments.
5. Tests: `castDeposit` abandons a `not-deposited` prior before depositing anew and persists twice, the second time with the hash; an `abandon` that throws stops it before any approval, persist or send. `runSetup` archives instead of clearing (the first `demo.test.ts` case flips); a resumed seed whose prior is abandoned keeps it. `StateDir.rename` moves the file and `keepAbandonedDraft` names it by nonce.

**Validation gate**

- Commands: `bun run lint && bun run typecheck && bun run test`
- Pass: exit 0; `flows-mocked.test.ts`, `demo.test.ts`, `run-state.test.ts` green.
- Layers: lint, typecheck, unit.

### Phase 3: the showcase keeps, skips and shows ✓

1. Declare `archived` and `final` in the tickets schema.
2. Archive in `fromDraft`, mark final in `stillClaimed`, skip both in `claimableEntry`.
3. Add `archivedDeposits` and `recheckDeposit`; wire the engine, `useLive`, and the `ArchivedDeposits` row with "Check again".
4. Tests: `actions.test.ts`: the finalized case keeps the record as final (the assertion at line 229 flips); a node's "finalized" on a ticket this page never claimed keeps its salt; a `not-deposited` draft is archived and skipped by later claims; one table drives a re-check through all three verdicts (ticket, `pending`, `not-deposited`) and asserts the salt is the same after each; a re-check of a missing or final record does nothing. `LiveMode.test.tsx`: the row renders and its button calls `recheck` and shows the answer. `store.test.ts`: the real schema keeps both flags.

**Validation gate**

- Commands: `bun run lint && bun run typecheck && bun run test && bun run --cwd apps/showcase test:components`
- Pass: exit 0; the named tests green.
- Layers: lint, typecheck, unit, component.

### Phase 4: docs, integration and e2e ✓

1. Docs: `docs/integration.md:60`, `docs/architecture.md:40`, `docs/operations.md:101`, `docs/assurance-map.md` A11. Each says finality is the node's word and records are archived, not deleted. `operations.md` names the kept files (`setup-<tag>.json`, `abandoned-<nonce>.json`) and how to recover a salt from them.
2. Integration: in `packages/integration/test/deposits.test.ts`, wait until the real finalized block reaches the landed deposit's block, then read it through a reader that withholds its logs and its receipt and reports that block's timestamp past the deadline. Assert the real `nonceBitmap` bit is set at that block (read directly), that the reader's `readContract` resolved during reconciliation, and that the verdict is `pending`.
3. E2E: `recordRpc` gains a response rewrite; a resilience spec holds the deposit's send, reloads under it, aborts it, makes the L1 reader report the finalized block past the deadline, then checks: a claim says the deposit is not on Ethereum, the archived row shows, survives a reload, and "Check again" keeps it archived.

**Validation gate**

- Commands: `bun run lint && bun run typecheck && bun run test && bun run --cwd apps/showcase test:components`, then `RUN_ID=claims bun run test:integration`, then `bun run test:e2e -- resilience.spec.ts`, then once before the PR `bun run test:e2e` and `bun run lint:actions`. (The browser runner draws its own run id from `RUN_PREFIX`; it owns its network either way.)
- Pass: exit 0 on each; the new integration case and the archived-row spec green.
- Layers: lint, typecheck, unit, component, integration, e2e.

## Post-implementation

Run in order, from this worktree (`.claude/worktrees/audit-fixes-claims`, branch `worktree-audit-fixes-claims`):

1. **Codex audit**: `/codex high` on `gpt-6.1-sol` (pass `gpt-6.1-sol` as `run-codex.sh`'s fifth argument). Send the net diff from `origin/dev`, this plan, and this ask: "What could go wrong? What would an attacker target? What are we trusting that we shouldn't? Where are the supply-chain / crypto / least-privilege weaknesses?" Send both rules below verbatim.
2. **Fix loop**: verify each finding against the code first. Apply the accepted fixes, commit, and log the round in `lessons/phase-4.md`. Resume the same Codex session with the fix diff. Stop when a round has no new material finding. If round 3 still has material findings, stop and send `BLOCKED claims: …` to the director.
3. **Delivery**: `git fetch origin dev && git rebase origin/dev`, rerun the Phase 4 fast gate, push the branch, then `gh pr create --base dev` (the first PR of this work). Body: what changed per finding, the tests, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
4. **Close-out** (the PR's final commits): write the `## Outcome` block after the front matter (date, status, PR number, dispositions, `Open items:`, the line retiring the seeds); promote any general gotcha into `implementations-plan/lessons.md` within its 8 KiB budget; file open items per the table below (this project also keeps `implementations-plan/follow-ups.md` as its curated list, per `AGENTS.md`); `git mv implementations-plan/audit-fixes-claims implementations-plan/archive/audit-fixes-claims` in its own commit, fix links, and move the index line into `archive/index.md`. Push, then `gh pr checks --watch`. Send `DONE claims: <PR url>; CI <state>` and wait. Merging is the owner's call.
5. **Teardown after the merge**: once `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/audit-fixes-claims/plan.md` succeeds, run `ExitWorktree` with `keep`, then `agent-worktree done audit-fixes-claims --merged --trunk dev`. Never force past a refusal; relay it. This session stays alive after DONE (the director may ask for a rebase), so it notices the merge when the director says so or at its next turn.

| Situation | Home |
|---|---|
| Work inside this implementation | this plan and the PR |
| Actionable work that outlives the plan | a GitHub issue with a domain label and a `Record` link |
| Needs a product call, or waits outside the repo | an issue labelled `owner-decision` or `blocked:external` |
| A suspected exploitable weakness | a private draft security advisory |
| Rejected, superseded or done | a disposition line in the Outcome |
| Knowledge that prevents a repeat | `implementations-plan/lessons.md` |

**The no-over-engineering rule**: *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*

**The comment-quality rule**: *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*

## Delivery

Single arc, one PR to `dev`: Phases 1–4, then the close-out commits. `code_review: off`. No stack.

## Plan audit

**Codex (`gpt-6.1-sol`, high), round 1**: `conditional approve (with conditions: prove archive failure stops replacement, and make the real nonce-read test non-vacuous)`. Every finding checked against the code; all adopted.

| # | Finding | Disposition |
|---|---|---|
| 1 | [Medium] `abandon` needs a durability contract and a failure test (the overwrite sits at `demo.ts:97`, `smoke.ts:179`) | Adopted: the contract in Architecture; Phase 2 tests a throwing `abandon` |
| 2 | [Medium] the real Permit2 test is vacuous: any read error also answers `pending`, and a rewritten timestamp does not put a fresh deposit into the finalized block's state | Adopted: Phase 4 waits for finality to reach the deposit, asserts the real bit and the completed read |
| 3 | [Medium] only the bare-address JSON-RPC branch is covered; the bit math needs a nonzero word and bit 255 | Adopted: Phase 1 tests |
| 4 | [Low] recheck omits the `pending` transition; read the record inside the lock; no-op on missing or final | Adopted: Architecture and Phase 3 |
| 5 | [Low] duplicate gate commands, missing `lint:actions`, `RUN_ID` ignored by the browser runner | Adopted: the EVM build dropped (bridge-core's `test` runs it), `lint:actions` added, e2e commands corrected. Kept `test:components` on every gate although root `test` runs it, because the director's brief names it. |

Facts qualified: Fact 3 (the catch covers the reader body only). Inferences sharpened: a set bit proves consumption or owner invalidation, the state window is not a guarantee, the e2e models a wrong reader. Asks: manual recovery documented in Phase 4; the JSON-RPC rejection residual stated in Security.

## Seeds

Draft until approval.

```
/goal All phases marked ✓ in implementations-plan/audit-fixes-claims/plan.md, each backed by its validation gate reported passing in the transcript; LESSONS_FILE=implementations-plan/audit-fixes-claims/lessons/phase-N.md printed per phase; /code-review NOT run (code_review: off); the Codex fix loop on gpt-6.1-sol converged, a resumed pass reporting no new material findings quoted in the transcript; one PR to dev exists (gh pr view output in the transcript), created only after the loop converged, with the close-out archive-move commit (git show --stat in the transcript); bun run test and bun run lint both exit 0 in the transcript.
```

```
/loop 15m Drive implementations-plan/audit-fixes-claims forward per its plan.md (Outcome & Quality Bar first). Never idle; decide with /codex high (gpt-6.1-sol) when stuck and log it in lessons/. Run each phase's gate as written; mark ✓ only when it passes. After Phase 4: the Codex fix loop until clean (stop at 3 rounds), then rebase on origin/dev, gh pr create --base dev, close-out commits, gh pr checks --watch, DONE to the director. Never merge, never deploy, never touch toolchain.json.
```
