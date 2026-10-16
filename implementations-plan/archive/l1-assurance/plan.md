---
plan: l1-assurance
tier: light
driver: claude-code
eli5_mode: skipped (director's brief)
code_review: off
codex_model: sol
claude_model: opus
explainer: off
trunk: dev
base: 8606c81
issue: 89
---

## Outcome

- **Date / status**: 2026-10-15, completed: delivered in PR #100 (closes #89), awaiting the owner's merge.
- **Shipped**: all seven items. The fizz harness deposits through the real Permit2 runtime, deployed with `CREATE`, and checks it against an independent digest (SP-23). Also in: the seeded refund address, both fee modes admitted, the three probes, the `fizz_data/` notes replaced by a nightly coverage artifact, the Slither IR gate, the Medusa PR job (120 s, after 150 s measured 276 s) and the nightly fork suite.
- **Changed from the plan**: Permit2 is deployed with `CREATE`, not etched, because Medusa 1.5.1 mis-executes etched code. The fork suite rolls back 8 blocks, the director's call after PublicNode's backend lag failed it at the head. The Slither gate also fails on a stale allow-list entry and on an unparsed marker, and takes the `src/` contract names from the build (Codex rounds 1–2).
- **Rejected**: file names crafted to fool the Slither parser (under `src/` or `node_modules/`). They would need an adversarial file name in reviewed code or a lockfile-pinned package; Codex round 3 found no open instance.
- **Known limits**: #99 (Slither builds no SSA for `TokenPortal`).
- **Open items**: none.
- **Measured on #100**: the Medusa job and the contracts workflow's wall clock, in the PR body.
- **Seeds**: none were issued; nothing below is a live instruction.

# Close the L1 assurance gaps in the fuzz suite, Slither and CI

Issue #89 lists seven classes of L1 regression that ship with CI green today. This plan makes each one fail a check on the contracts PR path, or at least nightly. `contracts/evm/src/`, halmos and `toolchain.json` do not change. Recon: `recon.md`.

## Outcome & Quality Bar

- **For whom**: the maintainer merging a contracts PR, and the owner reading the nightly runs.
- **Excellent**: each of the seven classes has a named check that fails on a deliberate mutant of it (shown once, locally, then restored); a red check names the rule it broke (property ID or the exact Slither function); the PR path stays fast (the Medusa job under 300 s, the workflow's wall clock unchanged because `noir` still dominates).
- **Good enough**: ERC-1271 wallets, signature malleation and a chain-id change stay with the fork suite and forge unit tests (#89 defers them).

## Architecture & Implementation

`E` = `contracts/evm`. Items follow #89's order.

1. **Real Permit2 in the fizz harness.** `E/scripts/permit2-runtime.ts` renders `E/test/mocks/Permit2Runtime.sol` (`KECCAK`, `CODE` as a hex literal; *as built*, no `ADDRESS`) from `packages/deployer/bytecode/permit2.json` after checking its keccak; `permit2-runtime.test.ts` (in `bun test scripts`, CI's first `evm` step) fails when the committed file differs. `IPermit2Errors` moves from `SepoliaFork.t.sol` into that file. `Base.setup` etches the runtime at the canonical address and requires the read-back keccak (*as built*: deployed with `CREATE` behind a 12-byte init stub, since Medusa 1.5.1 mis-executes etched code; off Sepolia's chain id Permit2 rebuilds its separator from its own address, which SP-23 checks); `permit2` becomes `ISignatureTransfer`. Signing changes to the **spec digest**: `Permit2Digest.digest` over the deposit, with the witness typehash and type string written as literals in `Base`, never read from the router. The real Permit2 recomputes its digest from what the router hands it, so an accepted deposit proves owner, spender, token, permitted amount, nonce, deadline and witness all match the signer's intent; the unsigned transfer details (`to`, `requestedAmount`) stay covered by SP-02's exact balance checks. Nonces: `_freshNonce(signer)` walks a per-signer counter past spent bitmap bits; `_nonceUsed(owner, nonce)` reads `nonceBitmap`. Every router leg uses a fresh nonce; the clamped handler keeps its fuzzed nonce unless it is spent. Properties: SP-03 becomes "the nonce was free before and Permit2 spent it"; new SP-23 asserts `router.permitDigest == spec digest` and `permit2.DOMAIN_SEPARATOR() == Permit2Digest.domainSeparator(chainid, permit2)`, from every router deposit and from `permit2DepositRouter_digest` over arbitrary inputs; GL-22's mock rejection becomes Permit2's own refusals: a replayed nonce (`InvalidNonce`) and a public deposit signed by another actor (`InvalidSigner`).
2. **Refund address.** `tokenPortal_depositToAztecPublic_clamped` takes a `_refundSeed` and names one of the three actors (the payer included) as `_depositor`; the model records it, so GL-23 checks the content hash names it and returns pay it. A non-actor refund would break GL-13's supply accounting, so the seed maps onto actors only.
3. **Fee modes.** `_withdrawHealthy` admits `FeeOnTransfer` (the portal's debit stays exactly `amount`). `adv_depositLiveness` admits `SenderSurcharge` for its direct legs (the portal's credit stays exactly `amount`), and only when the actor holds `amount` plus the 1 % surcharge: at the mock supply cap `_ensureFunds` reports success on `amount` alone; router legs stay Normal-only, since the router pays the surcharge on its forward and `ResidualBalance` refuses that by design.
4. **Probes.** (a) `permit2DepositRouter_deposit_malformed` kind 4: a signed public router deposit to a recipient above the field maximum, refused with `RecipientExceedsFieldMax`, its nonce still free afterwards. (b) `adv_deadlineEdge`: a deadline equal to `block.timestamp` deposits on the portal's private path and through the router (GL-29 counts a refusal in a clean deposit environment); one second earlier is refused with `AuthorizationExpired` or Permit2's `SignatureExpired` (GL-21 counts anything else). (c) `tokenPortal_authorizationRollback`: the actor withdraws its portal approval, a signed private deposit then fails at the pull (`ERC20InsufficientAllowance`, after `_consumeAuthorization`); `authorizationUsed(digest)` must stay false and, with the approval back, the same signature must deposit once. New GL-35 (`authorizationRollbackBroken == 0`) also counts a refused router deposit that left its nonce spent (4a, GL-22's foreign-key kind, the expired edge).
5. **Coverage record: delete.** The seven tracked `E/fizz_data/` files are the suite's one-time generation snapshot; every one is stale, and nothing can keep a committed coverage figure fresh. `PROPERTIES.md` stays the spec; `fuzz-contracts.yml` uploads Medusa's coverage report (`fizz_data/corpus_medusa/coverage/`) on every run as `medusa-coverage-<ref>`, 14 days. Refreshing would need the generating skill again and would decay on the next source change.
6. **Slither.** `slither.sh` keeps Slither's exit status, writes its stderr to a file and replays it, strips ANSI codes, and fails when an `Impossible to generate IR for <Contract>.<fn> (<source>#…` line names `TokenPortal`, `Permit2DepositRouter` or a source under `src/`, unless the exact (contract, function, source file) tuple is allow-listed: `TokenPortal` with `constructor`, `_EIP712Name`, `_EIP712Version`, each from `node_modules/@openzeppelin/contracts/utils/cryptography/EIP712.sol`. `--self-test` runs the gate over fixtures: allowed lines pass; a `src/` body, a router function, a portal function from another file, an ANSI-coloured line, a multi-line message and a nonzero Slither exit fail. *As built*, an allow-listed entry Slither no longer reports also fails, so a changed log format cannot leave the filter matching nothing; after the Codex fix loop, the contract names come from the build's `build-info` (every contract in a `src/` source; an inherited body is logged under its inheriting contract and the dependency's file), the line range is the last `#N[-M]`, and an IR failure marker that does not parse fails. The package script runs it first, as `halmos-gate.sh` does. **Known limit kept**: an allowed failure still marks `TokenPortal` incorrectly constructed, so Slither 0.11.6 skips SSA (and the data-dependency analysis built on it) for every portal function (`function_contract.py:138`); phase 3 measures what that hides and files it as an issue.
7. **CI.** `contracts.yml`'s `changes` job adds an `evm` output (`contracts/evm/**`, `packages/deployer/bytecode/permit2.json`, `toolchain.json`, `package.json`, `bun.lock`, `bunfig.toml`, `setup-toolchains/**`, both contracts workflows; true on dispatch), adds `permit2.json` to `relevant` too, and passes `medusa: ${{ needs.changes.outputs.evm == 'true' }}` to `_contracts.yml`, whose new `medusa` job runs `bun run test:evm:fuzz -- 150` beside `evm` and `noir` (`timeout-minutes: 5`, the owner's budget as a hard bound; logs and failing sequences uploaded on failure). **150 s**: the job adds about 40 s of setup, 47 s of crytic-compile (Medusa's timeout starts after it) and 21 s of wind-down (last nightly), so it ends near 260 s. If the PR's measured job exceeds 270 s, the campaign drops to 120 s. *As built:* the job measured 276 s on #100 (49 s of setup, a 221 s fuzz step), so the campaign is 120 s. New `fork-contracts.yml`: nightly over `main` and `dev` (dispatch: a choice of one), `concurrency: fork-contracts`, `contents: read`, `bun run test:evm:fork` with `SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com` and `continue-on-error`; a leg sets `passed_<ref>=true` only when that step's `outcome` is `success`. A `report` job (`if: always()`, `issues: write`, no checkout, no repo code) treats every selected ref without `passed_<ref>` as failed, setup failures included, and comments on the open issue titled "Nightly Sepolia fork suite failed" or opens it. `docs/ci-pipeline.md`, the `AGENTS.md` command notes and the `_contracts.yml` comment follow.

**Alternatives not taken.** A hand-written verifying Permit2 mock (re-implements what the vendored runtime already is). Keeping `MockPermit2` beside the real one (two Permit2s in one harness; SP-03's recorded fields would still check the router against itself). `--disallow-partial` for Slither (aborts on today's three OpenZeppelin functions). Restoring the nightly corpus on PRs (its replay could eat the 150 s). One fork job holding `issues: write` (would give the write token to a job that installs npm packages and runs forge).

## Security & Adversarial Considerations

- **CI privilege**: only the fork workflow's `report` job writes (issues); it checks out nothing and interpolates only fixed refs and the run URL through `env`, never `${{ }}` inside a script. The Medusa job and the fork legs are `contents: read` and hold no secret.
- **Untrusted RPC**: PublicNode can fail the suite (one deduplicated issue thread) or feed it false state (a false pass); the nightly is advisory and adds coverage, it gates nothing.
- **Supply chain**: the deployed runtime is the deployer's vendored, keccak-pinned code, never fetched; no new dependency; actions stay SHA-pinned.
- **Committed text** describes changes and properties, never an attack narrative.

## Assumptions

**Facts**
- F1 `permit2.json` is Permit2's runtime (9 152 bytes) with a keccak pin; the deployer installs it at `0x0000…8BA3` (`packages/deployer/src/l1.ts:104-119`). Its cached separator is Sepolia's, so other chains rebuild the domain from `block.chainid` and the address.
- F2 Medusa 1.5.1 (pinned binary) has `etch`; it has no file-read cheatcode and runs with FFI off (`E/medusa.json:55-57`).
- F3 Slither 0.11.6 logs `Impossible to generate IR for C.f (source)` on an `AttributeError`, skips that body, marks `C` incorrectly constructed (no SSA for any of its functions) and exits 0 (`slither_compilation_unit_solc.py:816-824`, `contract.py:435-439`, `function_contract.py:138`).
- F4 The edge is inclusive on both paths: the portal refuses `block.timestamp > _deadline` (`TokenPortal.sol:371-376`), Permit2 `block.timestamp > deadline`; the router checks no deadline.
- F5 `_consumeAuthorization` (`TokenPortal.sol:205`) runs before `_depositPrivate`'s `_pullExact` (`:311`).
- F6 Under `FeeOnTransfer` a withdraw debits the portal exactly `amount`; under `SenderSurcharge` a direct deposit credits it exactly `amount` (`ModalUsdc._update`).
- F7 Timings: nightly setup 29-35 s, compile 47 s, wind-down about 21 s (run 38537455069); contracts PR jobs `noir` 661 s, `evm` 352 s (run 38610718066).
- F8 `workflow_dispatch` needs the workflow on the default branch, so `fork-contracts.yml` first runs in Actions after the merge.
- F9 Matrix legs that set differently named outputs are combined in `needs.<job>.outputs` (workflow syntax reference, "Using job outputs in a matrix job": "job outputs will be combined from all jobs inside the matrix"; names must be unique).

**Inferences**
- I2 PublicNode serves the fork suite's latest-block reads without archive access (phase 4 proves it, with the runtime). *As built:* at the head it failed (`block not found`), because its load balancer can route a read to a backend a block behind; the director chose to roll the fork back 8 blocks after `createSelectFork` (test code only). Through PublicNode it then passes 12/12, in 9 s, 3 s and 2 s of wall clock over three runs (the suite itself 0.2–1.3 s).
- I3 The Medusa job ends under 300 s (estimate 260 s; the PR's CI measures it, and `timeout-minutes: 5` makes an overrun red, never silent). A failure shrinks far past `--timeout` (locally, 733 s for a 120 s campaign), so a red PR job can end at the bound with the shrinking property named in its log rather than its uploaded sequence.
- I4 The three OpenZeppelin functions are the whole src-contract IR-failure list at 8606c81 (phase 3 confirms by a run; any other line is investigated, never allow-listed unread).

**Asks**: none open. The owner decided the endpoint and the PR gate (#89); the coverage record (item 5) is this plan's call, for the director's review.

## Phases

Tool path for local gates (the host's default `forge` is 1.4.1; the pin is 1.7.1): `T="$HOME/.cache/inference-money-audit-tools"; export PATH="$HOME/.cache/inference-money/foundry-1.7.1/bin:$T/medusa:$T/slither/bin:$PATH"`. Medusa runs locally for 120 s at most. Nothing below starts before the director's `GO build`; on `HOLD`, stop every run within a minute.

### Phase 1: real Permit2, nonces, SP-03, SP-23, GL-22

1. Add `permit2-runtime.ts`, its test and the generated `Permit2Runtime.sol`; move `IPermit2Errors`.
2. Add `etch` to `IHevm`. Etch Permit2 in `Base.setup` and check its keccak. *As built:* deployed with `CREATE` behind a 12-byte init stub instead, with no `etch`: Medusa 1.5.1 hit a stack underflow inside the etched runtime that forge ran cleanly (`lessons/phase-1.md`).
3. Add the spec digest, `_freshNonce` and `_nonceUsed`. Sign the spec digest.
4. Rewrite SP-03 and GL-22. Add SP-23 and `permit2DepositRouter_digest`. Update `FoundryTester` calls.

**Validation gate**: `bun run --cwd contracts/evm test && bun run test:evm && bun run test:evm:fuzz -- 120 && bun run lint && bun run typecheck`. Pass: exit 0 each; Medusa registers every declared `property_*`. Layers: unit, forge (unit, fuzz, invariant, `FoundryTester`), Medusa.

### Phase 2: refund seed, fee modes, probes, GL-35

1. Seed the refund address. Admit the two fee modes.
2. Add malformed kind 4, `adv_deadlineEdge` and `tokenPortal_authorizationRollback`. Add GL-35.
3. Add one `FoundryTester` harness test that drives every new probe. Require each branch's observable effect, not only zero counters: deposits and Inbox messages rise at the deadline edge and after the rollback retry; `authorizationUsed` turns true after the retry; refused calls leave bitmaps, balances and counts unchanged; the fee legs use amounts of at least 100; the refund names an actor other than the payer.
4. Update `PROPERTIES.md` (SP-03, SP-23, GL-21, GL-22, GL-28, GL-29, GL-35) and the suite README.
5. Prove each new check can fail: mutate `src/` locally once per class (refund swap, permit digest, withdraw debit check, direct pull check, deadline `>=`, routed field rule), see the named check fail, restore. Log each in `lessons/phase-2.md`.

**Validation gate**: phase 1's commands, plus `git diff --exit-code contracts/evm/src`. Pass: exit 0; every mutant failed its named check. Layers: as phase 1.

### Phase 3: Slither gate, coverage record

1. Add the stderr filter and `--self-test` to `slither.sh`; run the self-test first in `test:evm:slither`.
2. Run Slither. Confirm that its src-contract lines are the three of item 6. If another line appears, stop and send `QUESTION` with it; do not allow-list it.
3. Measure the known limit: put one pattern that a data-dependency detector reports into the router and into the portal, locally. Record which one Slither reports, then restore `src/`. Write the result into `lessons/phase-3.md`; the close-out files it as an issue.
4. Delete the seven `E/fizz_data/` files. Fix the README's pointer. Add the coverage upload (`if: always()`) to `fuzz-contracts.yml`.

**Validation gate**: `bun run test:evm:slither && bun run lint && git diff --exit-code contracts/evm/src`. Pass: exit 0; the self-test reports its fixture cases. Layers: static analysis, lint.

### Phase 4: CI and docs

1. Add the `evm` filter output, the `medusa` input and job.
2. Add `fork-contracts.yml`.
3. Run the fork suite once through PublicNode. Quote its runtime. If it fails, run it once through `https://1rpc.io/sepolia` as a diagnosis only, then send `QUESTION` with both results; the workflow keeps PublicNode unless the director decides otherwise.
4. Update `docs/ci-pipeline.md`, the `AGENTS.md` command notes and the `_contracts.yml` comment.

**Validation gate**: `bun run lint:actions && SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com bun run test:evm:fork && bun run test:evm && bun run test:evm:gas && bun run test:evm:slither && bun run lint && bun run typecheck`. Pass: exit 0 each; on the PR, `contracts-status` green and the `medusa` job under 300 s. Layers: lint, forge, fork (live Sepolia), CI.

## Plan audit

Codex (`gpt-6.1-sol`, `high`), one round: **conditional approve** (with conditions: fix dependency filtering, prove probe reachability, enforce the five-minute budget, make fork failure reporting complete). All findings verified against the code; all adopted.

| # | Finding | Disposition |
|---|---|---|
| 1 High | A `permit2.json`-only change would skip the contracts gate and the runtime check | adopted: `permit2.json` in `relevant` and `evm`; `medusa` input bound to the `evm` output |
| 2 Med | An allowed IR failure also disables SSA for every portal function | adopted: F3 corrected; phase 3 measures it; filed as an issue at close-out |
| 3 Med | At the supply cap, `_ensureFunds` passes without the surcharge margin, so GL-29 could accuse correct code | adopted: the surcharge leg requires `amount` plus 1 % |
| 4 High | A counters-only harness test passes when a probe never reaches its assertions | adopted: phase 2 step 3 requires each branch's observable effect |
| 5 Med | Nothing enforces the five-minute budget | adopted: `timeout-minutes: 5`; 120 s fallback rule |
| 6 Med | Setup failures, `conclusion` vs `outcome`, and overlapping runs could miss or duplicate the issue | adopted: `passed_<ref>` from `outcome`, missing means failed, `if: always()`, a concurrency group |
| 7 Med | ANSI, multi-line messages or a masked exit status could slip past the Slither filter | adopted: ANSI stripped, exit status kept, exact tuples, those fixtures; extra lines are raised, never allow-listed |
| 8 Low | The phase 4 fallback could silently change the owner's endpoint | adopted: 1rpc is diagnosis only; a PublicNode failure goes to the director |

Also adopted from its "looks fine" notes: SP-02 stays the check on the unsigned transfer details (item 1).

## Approval

Approved as written by the director for the owner, 2026-10-14 (item 5 included).

## Delivery

Single arc: branch `worktree-l1-assurance`, one PR to `dev` with `Closes #89`, a per-item summary and the measured runtimes (Medusa job seconds, fork suite seconds, the contracts workflow's wall clock before, about 11 min on run 38610718066, and after). The close-out lands as the PR's final commits. No lanes: the phases share `Base.sol` and `PROPERTIES.md`.

## Post-implementation

While implementing: comments say only what the code cannot; log attempts in `lessons/phase-N.md`; stop after 3 failures on one step; update `agent-worktree status l1-assurance "<phase>"` and the crew status file at each gate; send `MILESTONE` at each green gate.

1. **Codex fix loop** (`/codex high` on `gpt-6.1-sol`): send the net diff from 8606c81, this plan, and the adversarial ask (vacuous properties, the issue job's privilege, the Slither filter's escape routes, the Medusa budget), plus verbatim: *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."* and *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."* Verify each claim, fix, commit, log, resume the session. A fix that adds state, a lifecycle, a protocol, a recovery policy or a public contract is a plan change: stop and ask. Hard stop after 3 rounds.
2. **Delivery**: rebase onto `origin/dev`, `gh pr create --base dev`, then `gh pr checks --watch`.
3. **Close-out**, as the PR's final commits: an `## Outcome` block after the front matter (date, status, PR, dispositions, `Known limits:`, `Open items:`, one line retiring the seeds); promote general lessons into `implementations-plan/lessons.md` (8 KiB budget, dedupe, retire); file open items per the table below; `git mv implementations-plan/l1-assurance implementations-plan/archive/l1-assurance` in its own commit, links repaired; move the index line to `archive/index.md`.

| Situation | Home |
|---|---|
| Work outliving the plan | a GitHub issue with a domain label and a `Record` link |
| Waits on a product call or an outside release | an issue labelled `owner-decision` or `blocked:external` |
| A suspected exploitable weakness | a private draft security advisory |
| A finding needing unsupported conditions | a `known-limit` issue, closed as not planned |
| Rejected or done | a disposition line in the Outcome |

4. **Report** `DONE l1-assurance: <PR url>; CI <state>` to the director. Merging is the owner's call.
5. **Teardown after the merge**: once `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/l1-assurance/plan.md` succeeds, run `ExitWorktree` (`keep`), then `agent-worktree done l1-assurance --merged --trunk dev`, and report its output; never force past a refusal. The director's next message after the merge starts this check.

## Seeds

None issued: this session executes the plan under the director's protocol (ELI5 skipped).
