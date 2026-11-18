---
plan: pre-redeploy
tier: light
driver: claude-code
eli5_mode: file
code_review: off
claude_model: opus
codex_model: sol
explainer: off
base: worktree-rc3-bump @ dd63688
trunk: dev
budget: "recon: 1 Sonnet sweep; code-review: off; lanes: none"
---

## Outcome

- **Date**: 2026-10-14. **Status**: delivered in PR #94 to `dev`; merging is the owner's call.
- **Shipped**: #52, a send to oneself proves no merchant side (TXE test, Token class id); #57, refund and exit sinks
  refused (the portal: USDC, the Inbox, the Outbox and the registry; bridge-core: Permit2, the Inbox, the Outbox, the
  registry and USDC; the refund proof over seven addresses); #59, `initialize` checks the expected rollup version
  (halmos proof, mutant, canary, forge test, the deployer passing the node's version); the demo merchants' salt (demo
  file v2, `--rotate` keeps the salt and refuses v1, the sponsor claimer, verify over both casts).
- **Validation**: every phase gate green locally (integration 53 + 6 clock, e2e 9/9, test:evm 132, halmos exactly 16,
  Medusa 73, TXE 190/85/20); negative controls for #52, #59 and the registry rule; the Codex fix loop converged in two
  rounds (`lessons/phase-5.md`).
- **Plan-text corrections**: on a non-demo network, verify refuses the unsalted cast and a published salted one,
  rather than passing when no demo is published (stricter; the director accepted it). The registry joined both
  refusal lists (Codex round 1, medium).
- **Known limits**: the portal's bound rollup cannot release USDC either, but the manifest does not record it, so
  neither list refuses it. A raw bridge call can still name every exit sink but zero and the portal.
- **Open items**: #95, drop version-1 demo-file support once the testnet demo is republished as version 2.
- **Seeds retired**: the `/goal` seed at the end is a historical record; never run it.

# Pre-redeploy: #52, #57, #59 and the demo merchants' salt

Four changes that the next testnet redeploy freezes into the token, the portal and the demo cast. One PR to `dev`,
opened after the rc.3 bump merges. Evidence: `recon.md`. Over the 150-line target by the post-implementation steps
(this repo has no shared standard for them) and the audit's adopted specifics.

## Outcome & Quality Bar

**For whom.** The operator who redeploys testnet right after this merges; the integrator reading the recipient rules.

**Excellent.** (1) Each item is one focused commit with the test that fails without it. (2) Every portal guard keeps a
halmos proof whose canary trips on its one-rule mutant. (3) Committed text states the rule and its property only.

**Good enough.** No L2 bridge guard for the new sinks (#57's optional item); no change to unrelated demo flows.

## Scope and director rulings (2026-10-13)

- #52: a send to oneself proves no side. `transfer_public_to_private` is unchanged.
- #57: bridge-core refuses Permit2, the Inbox, the Outbox and USDC as exit recipients; the portal refuses USDC, the
  Inbox and the Outbox as refund addresses. Permit2 stays SDK-side (the portal stores no Permit2 address).
- #59: `initialize(..., uint256 _expectedRollupVersion)` reverts `RollupVersionMismatch(expected, actual)`.
- Salt, option A: demo file v2 `{version: 2, bridge, usersTag, merchantsSalt}`; v1 still parses and its merchants
  derive unsalted; the cast API takes `merchantsSalt: string | null`, null only from a v1 file; `demo setup` always
  publishes v2; `--rotate` of a v1 demo is refused ("redeploy"); `SetupPlan.merchantsSalt` is never null.
- `demo fund`, option B: its keyed env holds only the L1 key (`disposable.ts:88`), so the sponsor's Fee Juice claim is
  sent by a claimer account derived from the deployment alone: never a cast member, never holds USDC, deployed if
  absent. No demo key is derived before `demo setup`. `demo status` without a published demo prints the merchants as
  not set up.

## Architecture & Implementation

- **#52** `main.nr`: `if from != to { let side = _prove_merchant_side(to, from, false); assert(side != NEITHER, …) }`.
  Test `a_self_send_reads_no_merchant_entry_whatever_its_capsule_names` (`test/hints.nr`): a capsule naming FIRST,
  then alice (unlisted) and m1 (switched off at the anchor) each send to themselves and keep their balances. Before
  the fix each call fails reading the entry, so a pass proves no entry is read, hence no expiry cap. Rebuild with
  `compile.sh`; re-pin the Token class id (`artifacts.test.ts`).
- **#57** `exit.ts` blocked list plus four `exit.test.ts` rows; `_requireDepositor` adds `address(underlying)`,
  `address(inbox)`, `address(outbox)`; `proveRejectsBadRefund` and the fuzz handler pick `which % 6`; GL-21, the
  `InvalidDepositor` notice and the docs name the refused sets and who enforces each: on chain the L2 bridge refuses
  zero and the portal, bridge-core also the router, Permit2, the Inbox, the Outbox and USDC (architecture.md:9,28;
  integration.md:3,16,100; assurance-map A24, A26).
- **#59** `initialize` checks after reading `rollup.getVersion()`. `FakeRollup` gets `setVersion` (default 4242).
  Every `initialize(` call site passes `FakeRollup.VERSION` (fork: its pinned `ROLLUP_VERSION`); the two init proofs
  take a symbolic version. New proof `check_initialize_rejectsVersionMismatch` (`proveRejectsVersionMismatch`, a
  symbolic expected version ≠ the rollup's), mutant `PortalWithoutVersionCheck`, its canary, and its pair in
  `halmos-gate.sh` (list and self-test log). New forge test (`PortalReinit.t.sol`): the registry's canonical rollup
  moved to one of another version, so `initialize` with the old version reverts with both versions, nothing bound.
  `initializePortal`'s binding gains `rollupVersion: bigint`; `deployBridge` passes the node's `info.rollupVersion`,
  the value the manifest records; on testnet `probeNetwork` has already required it to equal `TESTNET.rollupVersion`
  (`testnet.ts:91`). Docs: operations.md:111.
- **Salt** `packages/demo`: new leaf `merchants-salt.ts` (`MERCHANTS_SALT = /^0x[0-9a-f]{64}$/`); `files.ts` parses
  a v1 | v2 union, exports `castKeysOf(file)` and `writeDemoFile(ref, keys)` (writes v2); `cast.ts` exports
  `CastKeys { usersTag?: string; merchantsSalt: string | null }`, `newMerchantsSalt()` (`randomSecret().toString()`),
  and `aztecSecret(bridge, actor, keys)`: a merchant takes `${bridge}/${salt}/${actor}/aztec`, the legacy
  `${bridge}/${actor}/aztec` when `null`, and throws on any other value. `castMember(m, actor, keys)` and `enlist`
  take `CastKeys`. Deployer: `SetupPlan.merchantsSalt`; `runSetup(store, ops, publish, kept?)` draws the salt for a
  new plan unless a published v2 demo hands one over; `prepare(keys)`; `bound`/`list` use the enlisted players;
  `demoSetup` refuses `--rotate` of a v1 demo; `usersTagOf` becomes `castKeysFor(ref)`; `verifyDeployment` takes
  `demo?: DemoFile` (verify-cli reads it; none published passes). `demoFund` claims through `sponsorClaimer(m)`
  (`demoDigest(${bridge}/sponsor-claimer/aztec)`, `ensureAccount`). Showcase chain: `build/target.ts`
  (`BuildTarget.merchantsSalt`), `vite.config.ts` and `vitest.config.ts` (`__SHOWCASE_MERCHANTS_SALT__`), `env.d.ts`,
  `config/network.ts` (`MERCHANTS_SALT`), `demo/start.ts`, `demo/wallet.ts`, `e2e/testnet/live.spec.ts`. Docs:
  operations.md:53-57 (step 5 takes the addresses from setup's "List the demo merchants first" stop, which keeps
  printing them),123-126; AGENTS.md:70,82; architecture.md:36.
- **Alternatives not taken**: #59 checked only in the deployer (preflight and verify already pin it, but only before
  and after the binding); the salt as 16 bytes like the tag (the brief mandates `randomSecret`).

## Security & Adversarial Considerations

- **Threat model**, as the property each change secures. #52: a merge of one's own notes reads no merchant entry, so
  its expiry is a plain tx's. #57: no path this repository controls pays USDC to an address that cannot release it.
  #59: a portal binds only the rollup version its L2 side was deployed on. Salt: no demo merchant key is derivable
  before `demo setup` publishes it.
- **Least privilege.** No new keyed variable; `demo fund` keeps its single L1 key. The claimer key is public by design
  and controls nothing but its own empty account.
- **Crypto.** `randomSecret` (platform CSPRNG; the CLI refuses `SEED`); sha256 derivation as today.
- **Input validation.** The demo file stays a strict zod union; a malformed salt throws before any derivation.
- **Contracts.** `_requireDepositor` is a pure comparison before any transfer. `initialize` writes its bindings,
  then reverts on a version mismatch, which undoes them; no external call follows the check. Reentrancy unchanged.
- **Trust boundary.** The exit sinks beyond zero and the portal are SDK refusals: a raw bridge call can still name
  them, and the docs say so. A v1 demo file is operator input: setup never writes one and refuses to rotate one.
- **Supply chain.** No new dependency; frozen lockfile.

## Assumptions

**Facts.** (1) TXE `call_private` returns only the call's value (`aztec-nr` rc.3 `test_environment.nr:1148`), so a
whole tx's expiry is not observable in TXE. (2) `check-stamp-constraint.sh` pins no call in
`transfer_private_to_private` (`:98-100`). (3) `FakeRollup.getVersion` is a constant 4242 (`AztecFakes.sol:66`).
(4) CI's `showcase` job parses the committed v1 `deployments/testnet-demo.json` (`showcase.yml:69`).
(5) `demo fund`'s keyed env is the L1 key only (`disposable.ts:88`). (6) `ensureAccount` skips an initialized
account (`deploy-l2.ts:37`). (7) The token's TXE floor is 181 with 188 listed tests (`run-txe-tests.sh:23`).
(8) The Fee Juice claim takes any sender: `demo fund` sends it today from galactica, which is not the sponsor it pays
(`demo.ts:301-311`). (9) The #52 test proves no entry is asserted; the expiry follows from the source, since the cap
comes only from that read (`hints.nr` header).

**Inferences.** (a) The direct public deposit gains < 2 % gas over its 273 607 (one cold `outbox` read; `underlying`
and `inbox` are read later anyway); measured, and the snapshot regenerated if the check fails.

**Asks.** None open: the director answered both design forks.

## Phases (one arc)

1. ✓ **#52.** Edit `main.nr`, add the test and its `txe-manifest.txt` line, `compile.sh`, re-pin the class id.
   Commit the rebuilt artifacts first: `compile.sh --check` compares a fresh build against HEAD.
   **Gate**: `bun run test:noir`; `bash contracts/aztec/scripts/compile.sh --check`; `check-stamp-constraint.sh` and
   `check-sole-consumer.sh`, each plain and `--self-test`; `bun run --cwd contracts/aztec test` (the ABI-superset test,
   with its preload); `bun run --cwd packages/bridge-core test`. Pass: all exit 0; the new test fails on the unfixed
   source.
2. ✓ **#57.** Contracts, bridge-core, fuzz handler, docs. **Gate**: `bun run test:evm`, `test:evm:formal` (halmos
   0.3.3 on PATH), `test:evm:gas`, `test:evm:slither`; `bun run --cwd packages/bridge-core test`;
   `bun run test:evm:fuzz -- 300`. Pass: exit 0; the badRefund canary still trips.
3. ✓ **#59.** Portal, fixtures, deployer, docs. **Gate**: phase 2's EVM commands; `bun run typecheck`;
   `bun run --cwd packages/deployer test`. Pass: exit 0; the new forge test fails on the unfixed portal; the version
   canary trips on its mutant.
4. ✓ **Salt.** demo, deployer, showcase, docs. **Gate**: `bun run lint`, `bun run typecheck`, `bun run test`,
   `bun run --cwd apps/showcase test:components`, `BRIDGE_TARGET=testnet bun run --cwd apps/showcase build:testnet`.
   Pass: exit 0; tests prove the salt moves a merchant's address and the tag does not; a resumed setup keeps its
   salt; nothing publishes while a claim is unfinalized; `--rotate` keeps the salt and the merchant addresses;
   `--rotate` of a v1 demo is refused; `publish` writes both; a v1 and a v2 file each derive their pinned addresses;
   `resolveTarget` carries a v2 file's salt into the build target.
5. ✓ **Heavy gates.** `bun run lint:actions`; `RUN_ID=pre-redeploy AZTEC_NODE_HOME=<rc.3 node> bun run
   test:integration`; `RUN_ID=pre-redeploy … bun run test:e2e`. Pass: exit 0 (a timeout-only failure gets one rerun,
   then a MILESTONE naming it; the director decides whether it blocks).

Lessons go to `lessons/phase-N.md`; after each gate: `agent-worktree status pre-redeploy "phase N green: <next>"`.
Retry: stop and reassess after 3 failures on one step.

## Post-implementation

1. Codex fix loop over the net diff from dd63688 (`~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree>
   high read-only gpt-6.1-sol`): send the diff, this plan, the adversarial ask and these two rules verbatim:
   *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration
   surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear,
   leave it alone."* and *"Audit the comments for value per character. Flag any comment that narrates what the code
   visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where
   a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have.
   Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and
   exact."* Verify each finding, fix, commit, log the round, resume the same session (`resume-codex.sh`). Stop when a
   round has nothing material; a round 3 still material → BLOCKED. A fix that adds state, a lifecycle, a protocol, a
   recovery policy or a public contract stops for the director.
2. Delivery: wait for the rc.3 PR to merge, `git merge origin/dev`, rerun phase 4's gate, `gh pr create --base dev`
   (`Closes #52`, `Closes #57`, `Closes #59`, one line for the salt).
3. Close-out as the PR's final commits: `## Outcome` after the front matter (date, status, PR, dispositions,
   `Known limits:`, `Open items:` — the v1 demo-file removal issue the director files, retire these seeds); promote
   lessons to `implementations-plan/lessons.md` (dedupe, retire, date-stamp; ~8 KiB); `git mv
   implementations-plan/pre-redeploy implementations-plan/archive/pre-redeploy` in its own commit, links repaired;
   the index line to `archive/index.md`. Then `gh pr checks --watch`, `DONE` to the director, stay alive.
4. Teardown after the merge (director's call): `ExitWorktree` keep, then `agent-worktree done pre-redeploy --merged
   --trunk dev`; relay a refusal, never force.

Where open work lives: a bug or gap → an issue with a domain label and a `Record` link; a suspected exploitable
weakness → a private draft advisory; a known limit → a closed `known-limit` issue; a lesson → `lessons.md`.

## Delivery

One arc, one branch (`worktree-pre-redeploy`), one PR to `dev`; `code_review: off`; close-out as its final commits.
Parallelism: phases 1–3 touch disjoint files but share the EVM gates; serial is under a day, so no lanes.

## Audit

Codex (gpt-6.1-sol, high), session `01a13781`: **conditional approve** (add the version proof and canary; correct
the enforcement and listing docs; strengthen the salt resume and propagation tests; repair phase 1's gate).
Adopted: F1 version proof, mutant, canary, gate pair; F2 docs name the on-chain vs SDK boundary (integration.md:3,
architecture.md:9 — Codex cited :5); F3 resume, finality and rotation assertions; F4 runbook step 5; F5 commit
before `compile.sh --check`, preload via `bun run --cwd contracts/aztec test`; F6 the full showcase chain and a
`resolveTarget` assertion; Fact 7 (188 tests); the state-write wording; the gas trace (`outbox` is the new cold read).
Resolved, not adopted as work: "verify the claim sender against the protocol" — the current code already claims from
galactica for the sponsor (Fact 8). Rejected: none. Resumed check of the revised plan: **approve** (all six
conditions met, no new defect).

## Seeds

`/goal All phases ✓ in implementations-plan/pre-redeploy/plan.md, each gate reported passing in the transcript with
LESSONS_FILE printed; the codex loop converged (a resumed pass with no material findings quoted); one PR to dev
exists with the close-out's archive move (git show --stat), opened after the rc.3 PR merged; bun run test and bun run
lint exit 0.` Fallback: `/loop 15m Drive implementations-plan/pre-redeploy forward per its plan.md …` (blueprint's
template with trunk `dev`, `<test>` = `bun run test`, `<lint>` = `bun run lint`).
