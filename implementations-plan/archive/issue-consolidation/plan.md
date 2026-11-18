---
plan: issue-consolidation
tier: light
driver: claude-code
eli5_mode: skipped (director's brief)
code_review: off
claude_model: opus
codex_model: sol
explainer: off
trunk: dev
base: 6f7f1a1
---

## Outcome

- **Date**: 2026-10-15. **Status**: completed.
- **Shipped** in #103: the eight documentation issues (#55, #60, #64, #65, #66, #67, #80, #85), the #64 stderr warning and the #67 Presto hint sentence with a test each, and the retired Permit2-approval follow-up (#75 decided).
- **Dropped, by the director's scope change**: folding the enhancement issues into `follow-ups.md` (they stay open) and any file change for #76 (closed by the director). Not taken, as optional in their issues: the Noir zero-nonce refusal (#55), a stricter `set_merchant_delay` (#64), the `presto-banners` copy (#67). #65's side remark on the commitment unshield was left out: a direct caller never learns that commitment.
- **Known limits**: none. **Open items**: none. **Lessons promoted**: none (nothing generalizable beyond this run; `lessons.md` is at its budget).
- This plan's seeds were never issued; nothing here is a live instruction.

# Fix the eight documentation issues

## Outcome & Quality Bar

**For whom**: an integrator reading `docs/integration.md` before building on bridge-core, and an operator running the `docs/operations.md` runbook during an emergency.

**Excellent**:
1. Each corrected sentence matches the code it describes, checked against the cited line, and says what to do, not only what is wrong.
2. The two code changes (#64, #67) add text only: a stderr warning and a hint sentence, each with one test; no other behaviour moves.

**Good enough**: one or two sentences per item, in the file's existing voice; no restructuring of any section.

## Scope

Closes #55, #60, #64, #65, #66, #67, #80, #85. Also retires the stale Permit2-approval line in `implementations-plan/follow-ups.md` (#75 is decided and closed). Out of scope (director's scope change): folding enhancement issues, any other `follow-ups.md` edit, any change for #76, the ten `bug` issues and #95, the optional Noir zero-nonce refusal (#55), the stricter `set_merchant_delay` (#64), the `presto-banners` copy (#67), the AGENTS.md secrets rule (#80 names no change there).

## Architecture & Implementation

Docs and comments only, except two additive text changes (director's answer (a)):

- **#64** `parseDelay(value)` in `packages/deployer/src/cli-args.ts`, signature unchanged: after the range check, a delay ≤ 82 800 s writes one `console.warn` line (stderr) with the property: such a delay shortens the expiry of every tx that proves a merchant side, which marks those txs. Parsing runs after the redacted-child dispatch (`cli.ts:30-33`) and the line carries no input, so redaction and stdout are untouched. Test in `cli-args.test.ts`: with `console.warn` spied and restored, `"82800"` warns once, `"86400"` does not.
- **#67** `readyHint` in `apps/showcase/src/live/LiveMode.tsx`: when Presto is connected (`typeof view === "object"`), append one sentence: proving through Presto hands it each transaction's full private inputs, the keys that track this account's spends included, and they stay on this machine. The existing sentence stays verbatim (the Presto e2e asserts its substrings). Test in `LiveMode.test.tsx`: a hoisted flag behind a `PROVES` getter in a `vi.mock` of `@/config/network` (actual exports preserved), set for one test and reset in `finally`; the hint names the private inputs and the keys with a `PrestoStatus` view, and not after the view moves to `"ask"`.

Files and the change each gets:

| Issue | File | Change |
|---|---|---|
| #55 | `docs/integration.md`, Using bridge-core | Bullet: a hand-built private exit or delegated private transfer draws `authwit_nonce` fresh from a CSPRNG (`randomSecret()`); its authwit nullifier hashes the sender with public values and that nonce |
| #60 | `docs/architecture.md:11` | Separate sentences: a blocklisted portal or a paused USDC stops deposits and withdrawals (unchanged); a blocklisted router or Permit2 stops every routed (bridge-core) deposit until Circle relists or a redeploy, while withdrawals keep paying and the portal's direct deposits still land; nothing is lost in either case |
| #60 | `docs/operations.md`, Emergency | While the portal is blocklisted, pause on L2 so exits stop burning into withdrawals L1 cannot pay yet |
| #64 | `docs/operations.md:87`, `docs/integration.md` Linkable | Any delay ≤ 82 800 s, not only 1 h, shortens every merchant-proving tx's expiry |
| #65 | `docs/integration.md` Inferable | A commitment's holder can also test which account it names as payer (completer), the commitment unshield's hidden sender included; keep commitments confidential in transport and logs |
| #66 | `docs/integration.md` Visible | An exit's or return's withdraw message names its recipient and amount to anyone who tests it once the tx lands on Aztec, before any payout; it cannot be blinded |
| #67 | `docs/architecture.md:42`; `docs/integration.md` What each action makes public | What a Presto proof receives; a bullet that the prover receives each proof's full witness |
| #80 | `packages/deployer/src/secrets.ts:40-44`; `docs/operations.md:34` | Under Bun a Worker started after the hold sees the original environment: no secret-handling code in a Worker; a spawning Worker passes `env: scrubbedEnv()` |
| #85 | 13 sites listed in the issue | `TokenPortal.sol` `MAX_FIELD_VALUE` bound (×2) and "reverts unless zero"; `budget.ts` FJ-wei; integration.md OZ refusals, refusal names, payer rule, re-derived secret; assurance-map A21, A28, A5; operations.md Emergency step 4 (read the guardian line of `verify <manifest> --guardian <address>`, whose run still exits 1 on "bridge not paused" while paused, never a reason to unpause; never re-run `merchants guardian`, which restarts a pending replacement) and `disposable destroy` reads (operations.md:59 and the `disposableDestroy` doc comment, `disposable.ts:216`); architecture.md:5 zero; both PROPERTIES.md headers say their ids are local |

Alternative not taken: a separate PR for the two code changes. One PR keeps every `Closes` together, and the changes are additive text.

## Security & Adversarial Considerations

- **Threat model**: wrong docs lead integrators to leak privacy (guessable authwit nonces, logged commitments, a prover trusted with keys) or operators to restart a guardian delay mid-emergency. The fixes reduce that surface; none widens it.
- **No narrative**: committed text states the property and the instruction, never an attack walk-through or an audit identifier.
- **Bytecode**: Solidity comment edits must leave `TokenPortal`'s deployed bytecode identical (`bytecode_hash = "none"`), proven with the pinned forge, so `verify` keeps passing on the testnet manifest.
- **Least privilege, crypto, supply chain**: N/A: no dependency, credential, workflow or cryptographic change.

## Assumptions

**Facts**
1. `PaymentRefusal` is `"paid" | "in-flight" | "completed-on-chain" | "stale" | "replaced"` (`packages/bridge-core/src/payments.ts:93`).
2. The Aztec Inbox refuses a secret hash above `Constants.MAX_FIELD_VALUE` (`l1-artifacts` `core/messagebridge/Inbox.sol:95`).
3. `verify --guardian <a>` passes its guardian line only when the current and scheduled guardian both equal `a` (`packages/deployer/src/verify.ts:232-236`).
4. Both exits refuse a zero recipient (`contracts/aztec/token_bridge/src/main.nr`, `Recipient cannot be zero`, in `exit_to_l1_public` and `exit_to_l1_private`).
5. The showcase's tests run with `PROVES` false (`apps/showcase/vitest.config.ts:17`), and the Presto e2e asserts the hint by substring (`apps/showcase/e2e/specs/presto.spec.ts:74,85`).
6. The disposable `destroy` reads at the `finalized` tag through the pinned testnet node (`packages/deployer/src/disposable.ts:197-201`), in separate reads.

**Inferences**
1. USDC's `transferFrom` refuses a blocklisted `msg.sender` or recipient, so a blocklisted Permit2 or router stops every router deposit (FiatToken's `notBlacklisted` modifiers; not re-read here).
2. A re-run `merchants guardian` restarts the guardian slot's delay (stated by #85; the slot is a `DelayedPublicMutable`).

**Asks**: none open: the director answered (a) for the #64/#67 code parts.

## Plan audit (Codex, gpt-6.1-sol, high)

Verdict: **conditional approve** (qualify #60's blocklist effects; explain the paused `verify` result in #85). Every condition adopted:

- Adopted (Medium, demonstrated): while paused, `verify` fails "bridge not paused" (`verify.ts:208`) and exits 1, so step 4 reads the guardian line, says the exit is expected, and never advises unpausing.
- Adopted (Medium): #60 in separate sentences, so "withdrawals keep paying" never reads as covering a blocklisted portal or a paused USDC.
- Adopted (Low, demonstrated): the `disposableDestroy` doc comment (`disposable.ts:216`) says "last finalized block" too; corrected with operations.md:59.
- Adopted (Low): reset the hoisted `PROVES` flag in `finally` (`restoreMocks` does not reset it); one test covers connected and `"ask"`.
- Adopted (simplification): `parseDelay` keeps its signature and warns through `console.warn`; the test spies it.
- Confirmed: Inference 1 (FiatToken's `transferFrom` checks caller, sender and recipient) and Inference 2, narrowed to "restarts a pending replacement" (`main.nr:780`, `delayed_public_mutable.nr:203-208`).

## Phases

### Phase 1: docs, comments and the two text changes ✓

Steps: make each change in the table; add the two tests; delete the Permit2 line in `follow-ups.md`.

**Validation gate**
- Commands: `bun run lint && bun run typecheck && bun run test`; `bun test --preload ../../test-preload.ts src/cli-args.test.ts` in `packages/deployer`; `bun run --cwd apps/showcase test:components`; `forge fmt --check src/TokenPortal.sol` and `forge inspect TokenPortal deployedBytecode` before and after, both with the pinned forge 1.7.1, from `contracts/evm`.
- Pass criteria: every command exits 0; the two bytecode dumps are equal; each relative link touched resolves; `git diff --stat origin/dev` lists only docs, comments, `follow-ups.md`, the plan folder, `cli-args.ts`/`.test.ts` and `LiveMode.tsx`/`.test.tsx`.
- Layers: lint, typecheck, unit (deployer, showcase components), Solidity build.

## Post-implementation

While implementing: comments say only what the code cannot; log attempts in `lessons/phase-1.md`; stop after 3 failures on one step; `agent-worktree status issue-consolidation "<state>"` at each gate.

1. **Codex fix loop** (`/codex high` on `gpt-6.1-sol`, single arc, the net diff from 6f7f1a1): send the diff, this plan, the adversarial ask, and verbatim: *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."* and *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."* Verify each finding against the repo, fix, commit, log the round, resume the same session with the fix diff. Stop when a round has no new material finding; still material after round 3: stop and send BLOCKED.
2. **Delivery**: rebase on `origin/dev`, push the branch, `gh pr create --base dev` with `Closes #55, closes #60, closes #64, closes #65, closes #66, closes #67, closes #80, closes #85` and a line on the retired Permit2 follow-up.
3. **Close-out** (the PR's final commits): `## Outcome` after the front matter (date, status, PR, dropped items, `Known limits: none`, `Open items: none`, seeds retired); promote nothing unless a generalizable lesson appeared; `git mv implementations-plan/issue-consolidation implementations-plan/archive/issue-consolidation` in its own commit, links repaired; move the index line to `archive/index.md`. Open work stays in issues (repository rule: a bug or gap is an issue; a suspected exploitable weakness a private advisory; a done item a disposition line). Then `gh pr checks --watch`, then `DONE`. Merging is the director's call.
4. **Teardown after the merge**: once `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/issue-consolidation/plan.md` succeeds, `ExitWorktree` (`keep`), then `agent-worktree done issue-consolidation --merged --trunk dev`; report its output, never force past a refusal.

## Delivery

One arc, one branch (`worktree-issue-consolidation`), one PR to `dev`; the close-out lands as its final commits. `code_review: off`. No parallel lanes: one phase.

## Seeds

None: a director drives this run; the ELI5 and seeds are skipped by its brief.
