---
plan: presto-restore
tier: light
driver: claude-code
eli5_mode: skipped (owner's call)
code_review: off
codex_model: sol
explainer: off
trunk: dev
issue: 92
---

## Outcome

- **Date / status**: 2026-10-14, completed (delivered in PR #98 to `dev`; the merge is the owner's call).
- **Shipped** (#98): `@alejoamiras/presto` pinned to 6.0.0-rc.3 (one new lock entry, signature and SLSA provenance verified, integrity bound to `bun.lock`); the prover cast gone; CI's Presto job runs on every `e2e` run with no version-pair exception, `presto-compat.ts` deleted (D1); `prestoServer` stays 1.1.3 (D2), proven by bb `v6.0.0-rc.6` proving natively in `test:e2e:presto`.
- **Gates**: lint, typecheck, unit, components, `lint:actions`, `build:testnet` 7/7, `test:e2e:presto` 4/4, `test:proving` (live proving), `test:e2e` 9/9. Two local Presto runs failed on the host's spent anonymous GitHub quota first, not the code (lessons/phase-4.md).
- **Dispositions**: the build guard is unchanged beyond losing an export, as the brief required. Testnet in-browser proving waits for the keyed redeploy (manifest on node rc.1), which is outside this plan. The temporary age-gate exclude named 15 already-locked Aztec packages besides Presto (lessons/phase-1.md), never committed. `lessons.md` ends at 8.5 KiB: it was 8.1 KiB before, and pruning other plans' entries needs evidence this run did not gather.
- **Known limits**: #96.
- **Open items**: #97.
- **Seeds**: none were issued; nothing here is a live instruction.

# Restore real proofs through Presto 6.0.0-rc.3

Presto's SDK 6.0.0-rc.1 pins `@aztec-labs/stdlib` 6.0.0-rc.1, the toolchain is 6.0.0-rc.3, so every real-proof path is parked behind three temporary measures (#92). Presto 6.0.0-rc.3 pins rc.3. This plan moves the pin and removes the measures.

## Outcome & Quality Bar

- **For whom**: a maintainer reading CI on an `e2e`-labelled PR, and a visitor whose browser proves a send through Presto.
- **Excellent**: the `presto` job proves for real on every `e2e` run, with no version-pair exception left anywhere; the SDK's prover reaches the PXE with no cast; the pin is exact and its lock resolves without an age-gate exclude.
- **Good enough**: testnet in-browser proving waits for the redeploy (the manifest records node rc.1); this PR only removes what blocks it.

## Architecture & Implementation

- **Reuse** (`recon.md`): the build guard (`build/target.ts`) and its fixture tests stay as they are. `showcase-status` already turns red on a failing `presto` job.
- **Touched files**: `apps/showcase/package.json`, `bun.lock`, `apps/showcase/src/demo/wallet.ts`, `.github/workflows/_e2e.yml`, `apps/showcase/e2e/run/presto-compat.ts` (deleted), `apps/showcase/build/target.ts` (`prestoPins` loses `export`), `docs/ci-pipeline.md`.
- **Critical flow**: `PrestoProver` (SDK, stdlib rc.3) → `proverOrOptions` of the rc.3 PXE → kernel proof through presto-server 1.1.3, which fetches bb `v6.0.0-rc.6` from the SDK's `x-aztec-version` header (bb.js pin).
- **D1, the compat check goes.** With no skip pair set, `presto-compat.ts` either prints `run=true` or throws on a mismatch. The build guard inside `test:e2e:presto` (`build_showcase real`, on a local manifest whose node is the toolchain's) throws the same mismatch. So the script only fails some minutes earlier, at the cost of a script and a CI step. Alternative kept in reserve: leave it as an early fail-fast. Rejected: duplicate logic that drifts.
- **D2, `toolchain.json` stays put.** `prestoServer` stays 1.1.3 unless `test:e2e:presto` shows a fallback; the Aztec pins are not touched.
- **D3, commit order.** The pin first, with the cast still in place (it compiles under rc.3); then the cast removal; then the CI cleanup, prepared in the working tree before the package exists. A CI cleanup committed before the pin would leave a commit whose real-proof build fails.
- **D4, the guard checks stdlib only.** bb.js parity between the SDK and the PXE is checked once, at pin time (phase 1), and upstream by Presto's own test that its bb.js pin equals bb-prover's. A later mismatch needs a Presto release that breaks that test: a closed `known-limit` issue at close-out, reopened by any SDK bump whose bb.js pin differs from `@aztec-labs/stdlib`'s.

## Security & Adversarial Considerations

- **Supply chain (the new pin)**: exact `6.0.0-rc.3`; `bun.lock` carries its sha512. Checks, in order, before anything from the new lock runs:
  - `npm view @alejoamiras/presto@6.0.0-rc.3 dependencies --json`: `@aztec-labs/{stdlib,bb-prover,foundation}` exactly `6.0.0-rc.3`, `@aztec-foundation/{bb.js,noir-acvm_js,noir-noirc_abi}` exactly `6.0.0-rc.6`, `@alejoamiras/presto-core` `1.2.1`. Stop on any difference.
  - Resolve with `bun install --ignore-scripts`. The young set is the new `bun.lock` entries; it may hold only Presto's own packages, and no package name may appear or disappear outside them.
  - In an empty scratch dir, install the young set's exact specs with npm (scripts off), then `npm audit signatures --json --include-attestations`: every registry signature verifies; Presto's entry carries an SLSA provenance bundle whose repository is `github.com/alejoamiras/presto`, workflow `.github/workflows/release-sdk.yml`, with its ref and commit recorded; the attested sha512 equals `bun.lock`'s integrity and the registry's `dist.integrity`.
  - Residual trust: the Presto publisher (the owner's repository and its release workflow), unchanged from rc.1.
- **Age gate**: an intentional, owner-approved bypass for this one package: the lock resolves under a temporary `minimumReleaseAgeExcludes = ["@alejoamiras/presto"]` that is never committed. The frozen install passes without it, but the version is still adopted under 7 days old; the checks above stand in for the observation window.
- **Build guard**: stays fail-closed on any non-exact or differing stdlib pin for a manifest on the toolchain's node; its tests stay green. It does not check bb.js (D4).
- **CI job**: the `presto` job keeps `contents: read`; `PRESTO_GITHUB_TOKEN` still reaches presto-server only (`presto.sh`); removing the `if:` conditions changes no trigger: the job still runs only on the `e2e` label or a dispatch.
- **Frontend**: the CSP and the CRS hosts do not change; the bundle loses rc.1's duplicate bb.js and stdlib.

## Assumptions

**Facts**
1. `apps/showcase/package.json` pins `@alejoamiras/presto` `6.0.0-rc.1`; nothing declares `presto-noir` (recon).
2. The PXE stack already resolves `@aztec-foundation/bb.js` 6.0.0-rc.6 (`bun.lock`, `@aztec-labs/pxe/@aztec-labs/bb-prover`); the SDK's rc.1 tree carries its own rc.1 bb.js and stdlib.
3. Presto PR #105 states rc.3 pins `@aztec-labs/*` at 6.0.0-rc.3 and `@aztec-foundation/{bb.js,noir-acvm_js,noir-noirc_abi}` at 6.0.0-rc.6, and that released presto-server 1.1.3 proved rc.3 against a verifying rc.3 node.
4. `prestoPins` has two callers, `assertPrestoProves` and `presto-compat.ts`; `target.test.ts` builds a fixture root and does not read the installed SDK.
5. `showcase-status` reads `needs.e2e.result`, the aggregate of `_e2e.yml`'s jobs.
6. Our local network does not force proof verification by default (no `DEBUG_FORCE_TX_PROOF_VERIFICATION` in the tree): `test:e2e:presto` proves that real proofs are built through Presto and accepted, not that they verify. Presto PR #105 holds the verifying-node evidence.
9. A passing e2e run deletes its state dir, `presto-server.log` included (`apps/showcase/e2e/run/common.sh`, `reap_run`).
7. `deployments/testnet.json` records node 6.0.0-rc.1, so `build:testnet` skips the guard.
8. `bunfig.toml` sets the 7-day age gate with no excludes; bun applies it only at resolution (lessons.md).

**Inferences** (each has a gate that proves it)
- I1: the rc.3 `PrestoProver` fits the rc.3 PXE's `PrivateKernelProver` (typecheck, phase 3).
- I2: `PrestoPhase`, `PrestoStatus`, `LoopbackPermissionState` and the `PrestoProver` options are unchanged, as presto-core stays 1.2.1 (typecheck, component tests).
- I3: presto-server 1.1.3 proves natively with bb `v6.0.0-rc.6`, never its WASM fallback (phase 4 server log).
- I4: the bundle checks still pass (`build:testnet`).

**Asks**: none open. The brief fixed every decision, the age-gate bypass for this one package included. A server-side fallback in phase 4 would make a `prestoServer` re-pin an Ask.

## Phases

### Phase 1: pin Presto 6.0.0-rc.3 (after it is published) ✓
Warning: never commit `minimumReleaseAgeExcludes`. Run nothing from the new lock before step 5 passes.
1. Poll `npm view @alejoamiras/presto@6.0.0-rc.3 version` every 10 minutes, at most 4 hours, then report BLOCKED.
2. Run the dependency check (Security). Stop on any difference.
3. Set the exact pin. Add the temporary exclude. Run `bun install --ignore-scripts`. Restore `bunfig.toml`.
4. List the young set from the `bun.lock` diff. Check that it holds only Presto's packages, and that no other name appears or disappears.
5. Run the scratch-dir `npm audit signatures --json --include-attestations` check (Security). Record the provenance repository, workflow, ref and commit in `lessons/phase-1.md`.
6. Delete every `node_modules`. Run `bun install --frozen-lockfile`.

**Validation gate**: steps 2, 4 and 5 match; the frozen install exits 0 and `git diff --exit-code bunfig.toml` exits 0; `grep -c '@aztec-foundation/bb.js@6.0.0-rc.1\|@aztec-labs/stdlib@6.0.0-rc.1' bun.lock` prints 0; `bun run typecheck && bun run test && bun run --cwd apps/showcase test:components` exit 0. Layers: supply chain, typecheck, unit, component.

### Phase 2: drop the prover cast ✓
1. Pass `proofs?.prover` to `proverOrOptions` directly. Delete the reason comment and the unused `PrivateKernelProver` import.

**Validation gate**: `bun run typecheck && bun run lint`, exit 0. Layers: typecheck, lint.

### Phase 3: remove the CI self-skip (prepared in the working tree before the package exists, committed after phase 2) ✓
1. Delete `apps/showcase/e2e/run/presto-compat.ts`.
2. In `_e2e.yml`'s `presto` job, delete the `compat` step and the `steps.compat.outputs.run` conditions. Keep `if: failure()` on the upload.
3. Remove `export` from `prestoPins`.
4. Rewrite `docs/ci-pipeline.md`'s `presto` sentence without the compat step.

**Validation gate**: `bun run lint && bun run typecheck && bun run test && bun run --cwd apps/showcase test:components && bun run lint:actions`, each exit 0; `git grep -n 'PRESTO_SKIP\|presto-compat' -- ':!implementations-plan'` exits 1. Layers: lint, typecheck, unit, component.

### Phase 4: real-proof gates (`AZTEC_NODE_HOME=~/.cache/inference-money/aztec-node-presto-restore`; each script names its own run) ✓
Warning: a passing run deletes `presto-server.log`. Copy it while the run is live.
1. `bun run --cwd apps/showcase build:testnet`.
2. Start a watcher in the scratchpad. It reads the run id from this run's own output, then `tail -F`s that run's `presto-server.log` into the scratchpad.
3. `bun run test:e2e:presto`. In the copied log, find the completed download of bb `v6.0.0-rc.6` and a native proof success. Find no `download_failed` and no WASM fallback. Record the exact lines in `lessons/phase-4.md`.
4. `bun run --cwd apps/showcase test:proving`. Copy each flow's proving time into the PR body.
5. `bun run test:e2e`.

A spec that fails only on a timeout gets one rerun, then a MILESTONE message names it.

**Validation gate**: the build and its 7 checks pass; `test:e2e:presto` (its "Prove · Presto" send with one `/prove` 200), `test:proving` and `test:e2e` exit 0; `test-results/proving.json` exists; the copied server log shows bb rc.6 proving natively. Layers: build, e2e, real proofs.

## Plan audit

**Codex (gpt-6.1-sol, high; session `01a13b20…`): conditional approve** (conditions: package-specific provenance, bb.js parity, native-proof evidence kept before cleanup). All five findings adopted:
1. High, provenance underspecified: adopted as the scratch-dir `--include-attestations` check bound to the lock's integrity, after an `--ignore-scripts` resolution (Security, phase 1).
2. Medium, the guard checks stdlib only: adopted as the pin-time parity check and D4's known limit; the guard itself stays, as the brief requires.
3. Medium, a passing run deletes the server log: adopted as the phase 4 watcher; "no fallback" narrowed to the server's native-proof lines.
4. Low, a CI cleanup before the pin leaves a commit whose real-proof build fails: adopted as D3's new order.
5. Low, wording: Fact 6 narrowed; the age-gate bypass stated as intentional.

## Approval

Approved by the director for the owner, 2026-10-14: phases 1–4 and D1–D4 as written. Additions: the PR body says plainly that testnet in-browser proving still waits for the redeploy (the committed manifest records node rc.1, so `build:testnet` skips the guard); D4's known limit is filed closed at close-out with its reopening condition.

## Delivery

Single arc: one branch `worktree-presto-restore`, one PR to `dev` (`gh pr create --base dev`), body with `Closes #92`, the proving times, the e2e wall-clock before and after, and the supply-chain evidence. The director adds the `e2e` label. The close-out lands as the PR's final commits. No parallel lanes: the phases are serial and small.

## Post-implementation

While implementing: comments say only what the code cannot; log attempts in `lessons/phase-N.md`; stop after 3 failures on one step; update `agent-worktree status presto-restore "<phase>"` and the crew status file at each gate.

1. **Codex fix loop** (`/codex high` on `gpt-6.1-sol`): send the net diff from 437ae93, this plan, and the adversarial ask (the new pin's supply chain, the build guard, the `presto` job's gating), plus verbatim: *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."* and *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."* Verify each claim, fix, commit, log, resume the session. A fix that adds state, a lifecycle, a protocol, a recovery policy or a public contract is a plan change: stop and ask. Hard stop after 3 rounds.
2. **Delivery**: `gh pr create --base dev`, then `gh pr checks --watch`.
3. **Close-out**, as the PR's final commits: an `## Outcome` block after the front matter (date, status, PR, dispositions, `Known limits:`, `Open items:`, one line retiring the seeds); promote general lessons into `implementations-plan/lessons.md` (8 KiB budget, dedupe, retire); file open items per the table below; `git mv implementations-plan/presto-restore implementations-plan/archive/presto-restore` in its own commit, links repaired; move the index line to `archive/index.md`.

| Situation | Home |
|---|---|
| Work outliving the plan | a GitHub issue with a domain label and a `Record` link |
| Waits on a product call or an outside release | an issue labelled `owner-decision` or `blocked:external` |
| A suspected exploitable weakness | a private draft security advisory |
| A finding needing unsupported conditions | a `known-limit` issue, closed as not planned |
| Rejected or done | a disposition line in the Outcome |

4. **Report** `DONE presto-restore: <PR url>; CI <state>` to the director. Merging is the owner's call.
5. **Teardown after the merge**: once `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/presto-restore/plan.md` succeeds, run `ExitWorktree` (`keep`), then `agent-worktree done presto-restore --merged --trunk dev`, and report its output; never force past a refusal.

## Seeds

Retired. This session executed the plan under the director's protocol; no `/goal` or `/loop` seed was issued (ELI5 skipped).
