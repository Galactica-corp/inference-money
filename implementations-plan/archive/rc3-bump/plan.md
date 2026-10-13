---
plan: rc3-bump
tier: mid
driver: claude-code
eli5_mode: file
code_review: off
claude_model: opus
codex_model: sol
explainer: off
base: dev @ 606fdb5
trunk: dev
budget: "recon: 1 Sonnet sweep; code-review: off; lanes: 2 (this session + one director-spawned helper)"
---

## Outcome

- **Date**: 2026-10-13. **Status**: delivered in PR #91 to `dev`; merging is the owner's call.
- **Shipped**: every Aztec pin at rc.3 (`@aztec-foundation/*` and protocol_types at rc.6, aztec-standards rc.3) with
  locks, Noir deps and artifacts; the refund commitment the sender's and never stamped, with its guard, mutants and TXE
  tests; rc.6's unmarked cancel followed in the token docs, bridge-core, verify, operations and `[A20]`; the V3
  addresses and class ids; testnet L1 pins from keyless reads; the Presto real-proof build guard and CI's bounded
  Presto skip; the version rule and the bump procedure.
- **Validation**: every Phase 2–4 gate green locally (integration 53 + 6 clock, e2e 9/9, fork 12/12, probe 19/19);
  I1 to I7 settled (`lessons/phase-3.md`, `lessons/phase-4.md`); the Codex fix loop converged in two rounds.
- **Dropped**: the integration refund spec (D10: a direct client never learns the commitment; `[A22]` and the TXE
  refund tests cover it).
- **Known limits**: real-proof paths (`test:e2e:presto`, `test:proving`, in-browser proving of a testnet bundle) wait
  for a Presto release built on rc.3; the CI Presto job skips for exactly the approved pair until then.
- **Open items** (to the director): withdraw-only mode (#48) assumes a rollup switch on the same node version; restore
  the real-proof paths once Presto ships rc.3 (drop the `wallet.ts` cast and the CI env pair).
- **Seeds retired**: the `/goal` seed at the end is a historical record; never run it.

# Aztec toolchain 6.0.0-rc.1 → 6.0.0-rc.3

Move every Aztec-tracking pin to rc.3 with everything it couples to, port the behaviour rc.3 changes into this repo's
copies of upstream logic, re-pin the testnet to its rc.3 rollup, and prove the bridge end to end on a local rc.3
network. One PR to `dev`. Evidence: `recon.md` (same folder). Over the 350-line target: three director rulings and
two audits' adopted test and guard specifics are inline so the implementing workers need nothing else.

## Outcome & Quality Bar

**For whom.** (1) The operator who redeploys testnet with a keyed run right after this merges. (2) The maintainer who
does the next bump and starts from this PR's change list. (3) Integrators who call the token as upstream's Token.

**What excellent looks like.**
1. Each coupled pin moves in one place, `toolchain.json` stays the single source, and AGENTS.md states the real coupling
   rule (the rc numbers of `@aztec-labs/*`, `@aztec-foundation/*` and aztec-standards differ).
2. The PR body lists every behavioural change rc.3 brings to this repo, each with the file it touched.
3. Integration and browser e2e pass against a local rc.3 network; `probe:testnet` passes against the live rc.3 testnet.
4. No hand-copied identity survives that a script can derive: class ids, the sponsor address and the handshake registry
   are re-derived by the rc.3 SDK or compiler, and tests pin the derived values.

**Good enough.** No new tests for unchanged behaviour; no presto, tour or testnet-manifest work (blocked or out of scope).

## Scope

In: pins, locks, Noir deps, artifacts, TXE manifests, keystone, the token's upstream re-sync, the TS horizon mirror,
`networks.ts` testnet pins, a Presto version guard for real-proof builds, docs and lessons.

Out (director's rulings, 2026-10-13):
- `deployments/testnet.json`, `testnet-tour.json`, `testnet-demo.json`: unchanged (the owner redeploys after the merge).
- `@alejoamiras/presto` stays `6.0.0-rc.1`, `prestoServer` stays `1.1.3`. **Blocked on a presto rc.3 release (SDK +
  server):** `test:e2e:presto`, `test:proving`, and in-browser proving of a `build:testnet` bundle.
- Redeploy order, for the PR body and a comment on #49: presto rc.3 → keyed redeploy → `dev`→`main`.
- No `test:testnet` against production; no keyed run; no deploy.

## Architecture & Implementation

**Shape.** A single arc in four phases. Phase 1 is a shared base commit (every pin, all three lockfiles, the Noir git
deps, the compile repair in keystone, artifacts rebuilt from unchanged sources). Phases 2 (Noir) and 3 (TypeScript)
touch disjoint paths and run in parallel lanes. Phase 4 merges them and runs the heavy gates. Nothing new is built
except the Presto guard (≈12 lines), its CI skip step and one integration spec.

**Version rule (the fact AGENTS.md must state).** `@aztec-labs/*` = `aztecJs` (6.0.0-rc.3). `@aztec-foundation/*`
(bb.js, l1-artifacts, noir-*) = what `@aztec-labs/aztec.js@<aztecJs>` itself depends on (6.0.0-rc.6).
`@aztec-foundation/aztec-standards` = aztec-standards' tag that pins the same aztec-nr tag (6.0.0-rc.3). Noir:
aztec-nr and aztec-standards at `noir`'s tag; `protocol_types` at whatever aztec-nr's `aztec/Nargo.toml` pins (rc.6).
nargo, Foundry and node come from `install.aztec-labs.com/<aztecNode>/versions` (rc.3: unchanged).

**File-level change map.**

| Area | Files | Change |
|---|---|---|
| Pins | `toolchain.json` | `aztecNode`, `aztecJs`, `noir` → `6.0.0-rc.3`; `nargo`, `aztecNodeFoundry`, `node` unchanged |
| npm | `apps/showcase`, `packages/{bridge-core,demo,deployer,integration}`, `contracts/{aztec,evm}` `package.json`; `contracts/aztec/toolchain`, `packages/local-network/toolchain` `package.json`; 3 `bun.lock` | `@aztec-labs/*` → rc.3, `l1-artifacts` → rc.6, `aztec-standards` → rc.3; presto untouched |
| Noir deps | 7 `contracts/aztec/*/Nargo.toml`; `scripts/noir-deps.sh` DEPS | tags → `v6.0.0-rc.3`; table re-derived (aztec-nr `694af4de…`, aztec-packages `v6.0.0-rc.6` `0df91ba1…`, aztec-standards `f7bf63d5…`) |
| Artifacts | `contracts/aztec/{token,token_minter_proxy,token_bridge}/target/*.json` | rebuilt by `compile.sh` only |
| Keystone (Phase 1) | `keystone/src/main.nr:190-275` | `DOM_SEP__CONTRACT_ADDRESS_V2` → `_V3`; add aztec-nr's `DOM_SEP__NOTE_RANDOMNESS` (2943528854) to the "others" list (75 → 76) |
| Token re-sync | `token/src/main.nr:1,248-277`; its tests and `rules_requests.nr`; `scripts/check-stamp-constraint.sh`; `token/README.md:259-275`; `PROPERTIES.md` SP-09 :660, SP-12 :687, SP-13 :699, SP-27 :840; `docs/integration.md:3,24,28`; `docs/architecture.md:52,57`; `docs/assurance-map.md:30` | ruling D3 = C (below) |
| TXE | `{token,token_bridge,keystone}/txe-manifest.txt`; floors in `run-txe-tests.sh` only if counts rise | renamed/added tests |
| TS horizon | `bridge-core/src/merchants.ts:148-152` + `merchants.test.ts` | `at >= changeAt` **or `off === scheduledOff`** → `at + d` |
| "A cancel marks" (false under rc.6) | `bridge-core/src/merchants.ts:136` (`pending`), `deployer/src/verify.ts:275-279`, `deployer/src/admin.ts:172`; `token/src/main.nr:699-700,786-787`, `token/src/test/merchants.nr:136`; `PROPERTIES.md` GL-19 :232-238, :328-335, SP-21 :769,:781-782; `docs/operations.md:73,83`; `integration/test/merchants.test.ts` `[A20]` | a scheduled `pre == post` (cancel, switch back on) no longer caps reads: `pending` and verify's "marked, no switch" drop it; prose and `[A20]` say a switch back on unmarks the entry |
| Sepolia fork pins | `contracts/evm/test/SepoliaFork.t.sol:34-36` (asserted equal to `networks.ts` by `deployer/src/networks.test.ts:16-28`) | rc.3 Inbox/Outbox (EIP-55), `ROLLUP_VERSION = 3_409_706_519` |
| Identities | `bridge-core/src/artifacts.test.ts` (3 class ids + sponsor), `bridge-core/src/claim.test.ts:39`, `integration/test/discovery.test.ts:15-17` | values the rc.3 SDK/compiler derive |
| Testnet pins | `deployer/src/networks.ts:25-46` | Phase 1: `nodeVersion`, `rollupVersion`, `inbox`, `outbox`, `feeJuicePortal` from keyless reads (recon.md); Phase 3: `sponsoredFpc` derived by the rc.3 SDK |
| Presto guard | `apps/showcase/build/target.ts`, `build/target.test.ts`; `.github/workflows/_e2e.yml` (`presto` job) | see below |
| Refund route | `packages/integration/test/` (one new spec) | Phase 4 step 4 |
| API fixes | wherever `bun run typecheck` fails | smallest change each |
| Docs | `AGENTS.md:67`, `docs/ci-pipeline.md` (bump procedure), `docs/operations.md` § Rollup upgrade, `contracts/aztec/README.md:3,20`, `PROPERTIES.md:29`, the nargo/Foundry digest headers, `implementations-plan/lessons.md` | versions and procedure |

**Presto guard (director-approved option A).** In `build/target.ts`, after `proofsFor`: when `proofs === "real"` and
`manifest.l2.nodeVersion === toolchain.aztecNode`, read the `@aztec-labs/stdlib` version that
`@alejoamiras/presto`'s `package.json` pins and throw unless it equals `toolchain.aztecJs`, naming both versions. The
rc.1 `testnet.json` still builds (its live mode already stops at `assertNetworkIdentity`); an rc.3 manifest cannot build
a real-proof bundle until presto moves. Reads stay `node:fs` (the module must remain a leaf). `target.test.ts` covers:
refuses (rc.3 manifest + real + mismatched presto), passes (fake proofs), passes (manifest on another version). The
same exported comparison lets CI's `presto` job skip itself with a warning while the versions differ: without that,
any PR labelled `e2e` turns the required `showcase-status` red (`showcase.yml:99-101` requires a requested e2e to
succeed), the honest result being "not runnable yet", not "failed".

**Commitment owner (D3, director's ruling C).** A refund commitment is not a payment request. In
`transfer_private_to_public_with_commitment`:
- keep `_prove_merchant_side(to, from, true)` and the NEITHER refusal (the published side first: proving the hidden
  payer first lets a pending switch-off's expiry cap identify it, `hints.nr:59-66`);
- initialize the commitment for `from`, completer `msg_sender()` (upstream rc.3), and return it;
- push no stamp, no pad and no request effect (amended ruling): the token never reads a pad (hints look for stamps
  only), this entry point's effect count stays constant (SP-13 holds per entry point), and nothing consumes this
  function's `REQUEST_OPENED` effect (`bridge-core/src/payments.ts:160` reads it after `openRequest`, which calls
  `initialize_transfer_commitment` only).

Why not a verbatim port: keeping `_push_request_stamp(c, FIRST=to)` with owner `from` stamps a commitment a user owns,
and the stamp is the only owner check at payment time, so any user could pay into it: a user→user transfer past the
merchant rule. Completion rules stay: a listed refund source needs no stamp (`main.nr:447-452`); an unlisted one
needs a live stamp, so it cannot refund through this function (documented restriction). Stamped requests stay on
`initialize_transfer_commitment`. `check-stamp-constraint.sh` gains
`keeps_published "$flat" transfer_private_to_public_with_commitment to from recipient` (after :98) and one rule:
the function's body never calls `_push_request_stamp`. Two mutants, each anchored with
`(fn transfer_private_to_public_with_commitment\(.*?)` (an unanchored `_prove_merchant_side(to, from, true)` first
matches `transfer_private_to_public` at :238): the side order swapped, and a `_push_request_stamp(c, side)` re-added.
The header says "the three calls". Owner `from` is pinned there only if it costs one regex, otherwise by the TXE
refund test. A one-line comment at the call states the invariant: a refund commitment is never stamped, because a
stamp is the only owner check a payment makes.

**Horizon port.** `get_time_horizon` (protocol_types rc.6, `scheduled_value_change.nr:64-77`) returns
`anchor + minimum_delay` when `pre == post`. `MerchantEntry.off`/`scheduledOff` are `pre`/`post`, so the mirror adds
`|| e.off === e.scheduledOff`. The Noir hint calls upstream directly (`hints.nr:169`) and needs no change. Consequence:
a cancel or a switch back on schedules `pre == post` and no longer marks the entry's txs. `merchantStatus.pending`
and verify's switch check become `changeAt > at && off !== scheduledOff`; the cancel's refusal when nothing is pending
stays (harmless), its comment loses the "re-mark" reason. No TXE case pins a pre==post cap today: Phase 2 adds one
(a cancelled entry's cap is `anchor + MERCHANT_MAX_DELAY − 1`), the TS twin in Phase 3.

**Trade-offs.**
- *Excludes not committed*: lock under a temporary `minimumReleaseAgeExcludes`, then remove it (lessons.md). A committed,
  dated exclude (the brief's default) is rejected: the gate applies only at resolution, so CI's frozen install needs
  none, and a committed name lets any later re-resolve take a fresh version of it.
- *Presto at rc.1 in the bundle*: two `@aztec-labs` trees in the showcase's real-proof chunk until presto moves; accepted
  (D1). If `tsc` rejects the `PrestoProver` → PXE boundary, one cast with a one-line reason, removed with the presto bump.
- *Lanes*: the helper takes Phase 3 (disjoint paths, shared artifact inputs from Phase 1). ≈30% shorter critical path.

## Security & Adversarial Considerations

- **Supply chain.** The rc.3/rc.6 packages are 5 days old, aztec-standards rc.3 hours old: inside the 7-day gate.
  Mitigations: exact-name temporary excludes, never committed; `--frozen-lockfile` everywhere after; `npm audit
  signatures` verifies every young package's registry signature and provenance attestation, and each attestation's
  source repository and commit are checked against the expected tag; the lockfile's package set is diffed; bun runs no
  dependency lifecycle scripts unless trusted (none added). What remains trusted: valid provenance proves a build by
  the expected repository's workflow at the named commit, not that the repository or workflow was uncompromised; the
  5-day window is the residual exposure, and the recon's upstream diffs are the only review of the source. Native code
  from these packages runs (bb, the TXE, the node); aztec-standards' published GenericProxy and AuthorizationContract
  artifacts execute inside the TXE (`run-txe-tests.sh:48-59`).
- **Wrong circuits.** A real-proof bundle with rc.1 kernel circuits against an rc.3 node fails late and confusingly; the
  Presto guard makes it fail at build.
- **Fund direction.** The commitment-owner port changes who receives a refund (now the payer, as upstream). Attack
  surface: a wrong completer, a stamped refund commitment a user could then pay into, a user/user unshield through this
  function, a second completion. The TXE suite must show each refused (Phase 2 step 4). Privacy: the proof order stays
  published-side first, so a hidden payer's pending switch-off cannot mark the tx.
- **Client/contract divergence.** If the TS horizon disagreed with the token, a client would send txs the kernel
  refuses (a stuck flow, never a bypass: the cap is enforced in the proof). The port plus a pre==post test removes it.
- **Testnet pins from untrusted RPCs.** The probe compares the Aztec node (dRPC) with L1 (publicnode): registry →
  canonical rollup → inbox/outbox/version must agree. That is corroboration by two providers, not authenticated chain
  evidence. The fee-juice portal comes only from node info, so Phase 3 corroborates it on L1 (`getFeeAssetPortal()`).
  The sponsor address is derived locally, then checked keylessly for an instance on the new rollup.
- **Least privilege / secrets.** No keyed run, no new CI permission, no new dependency. Local networks run under
  `RUN_ID=rc3-bump` on owned ports and process groups.

## Assumptions

**Facts** (sources in `recon.md`)
- F1. rc.3's installer pins nargo 1.0.0-rc.3, Foundry 1.4.1, node 24.12.0 (unchanged).
- F2. `@aztec-labs/aztec.js@6.0.0-rc.3` depends on `@aztec-foundation/l1-artifacts@6.0.0-rc.6`; stdlib/pxe on bb.js and noir-* rc.6.
- F3. aztec-nr rc.3 pins `protocol_types` at aztec-packages `v6.0.0-rc.6`; aztec-standards rc.3 pins aztec-nr rc.3.
- F4. The live testnet runs 6.0.0-rc.3 on rollup 3409706519 (probe, 2026-10-13).
- F5. Of the portal's L1 imports only `IRollup.sol` and `ConstantsGen.sol` change, in parts the portal does not use.
- F6. `keystone/src/main.nr:235` names a constant rc.6 removed.
- F7. Upstream Token rc.3 changes behaviour in one function only; its ABI is unchanged.
- F8. `@alejoamiras/presto@6.0.0-rc.1.1` pins `@aztec-labs/*@6.0.0-rc.1`; no rc.3 build exists.
- F9. The V3 address separator moves every derived address: accounts, contracts, the sponsor, standard contracts.
- F10. rc.6's `get_time_horizon` stops capping a read when `pre == post`, so a cancel or a switch back on no longer
  marks an entry (`scheduled_value_change.nr:72-77`); `scheduled_delay_change.nr` is unchanged.

**Inferences** (each settled by the named gate)
- I1. Bun 1.4.0 (CI) and 1.4.2 (here) apply the age gate only at resolution, so a frozen install of a lock made under
  excludes passes without them. Settled by Phase 1's frozen installs and the PR's CI.
- I2. The portal's and router's deployed bytecode is identical under l1-artifacts rc.6 (`bytecode_hash = "none"`).
  Settled in Phase 4 by comparing `forge inspect … deployedBytecode` before and after; if it differs, all four EVM gates
  run and `.gas-snapshot` is regenerated.
- I3. The keystone, claim-secret and stamp vectors do not move (poseidon2 and their separators are unchanged). Settled by
  `test:noir` and bridge-core's tests.
- I4. The rc.3 SponsoredFPC (salt 0) is published on the new rollup. Settled by `probe:testnet` in Phase 3; if not, it
  is a recorded external blocker (PR body, #49: the redeploy's `verify` needs it), and every other check must pass.
- I5. TS API breaks rc.1→rc.3 are few and local (aztec-node changelog: no removed client API we call). Settled by
  `bun run typecheck`; a break that needs a design change stops for the director.
- I6. The `PrestoProver` → rc.3 PXE boundary typechecks, or needs one cast. Settled by the showcase typecheck.
- I7. The PXE's expiry rounding and the node/PXE error texts the code matches are unchanged in rc.3. Settled by
  Phase 3 step 5 (diff and grep) and the clock specs.

**Asks**
- A1 (commitment owner): resolved by the director's ruling C, amended 2026-10-13.
- A2 (for the redeploy, not this PR's merge): does Galactica's deployed x402 integration call
  `transfer_private_to_public_with_commitment` relying on the rc.1 owner? No in-repo caller exists. The director asks
  the owner before the redeploy; the PR body states it.
- A3 (only if I1 fails in CI): CI's bun 1.4.0 refuses the lock made under excludes. Then the choice is the owner's:
  wait until the gate clears (2026-10-20T19:04Z for aztec-standards) or commit a dated exclude. Send a QUESTION;
  never settle it silently.

## Phases

### Phase 1 — Shared base: pins, locks, Noir deps, rebuilt artifacts ✓ (e0dd36b)
1. Set `toolchain.json` per the change map.
2. Move every npm pin per the change map. Leave `@alejoamiras/presto` alone.
3. Add the precomputed exact names (root 42, each toolchain 60: the young closure of the new pins) to a temporary
   `minimumReleaseAgeExcludes` in the root and both toolchain `bunfig.toml` files; `bun install` in each. Never commit them.
4. Verify the young set before any of it executes (step 8 runs bb and the TXE). Enumerate it from all three
   `bun.lock` files (name, version, integrity). In a scratch dir, `npm install --ignore-scripts` the same exact
   versions (all platforms' optional packages included), then `npm audit signatures`: every registry signature and
   provenance attestation must verify, and each Bun-locked integrity must equal npm's for the same package; anything
   locked by Bun but absent from npm's tree is listed and dispositioned. Decode each young
   package's attestation and check its source repository and commit: aztec-node's `v6.0.0-rc.3` commit for
   `@aztec-labs/*`, aztec-packages' `v6.0.0-rc.6` for `@aztec-foundation/*` except aztec-standards, `f7bf63d5` for
   aztec-standards. Diff the lockfiles' package sets against `dev`, and list every new or changed non-Aztec entry with
   its version, publish date and provenance (a dependency an Aztec package declares is not trusted for that alone).
   List any package without provenance in the PR body.
5. Remove the excludes. Run the frozen installs below; they must pass.
6. Set the Nargo.toml tags. Repair what stops compilation: `keystone/src/main.nr:235` V2 → V3, and add
   `DOM_SEP__NOTE_RANDOMNESS` (2943528854) to its "others" list (75 → 76).
7. Re-derive the `noir-deps.sh` table from a clean-cache `HOME=<tmp> nargo check` of token, token_bridge and keystone;
   verify each commit through its tag object.
8. Rebuild with `bash contracts/aztec/scripts/compile.sh` (`NARGO=` a noir-lang 1.0.0-rc.3 nargo); commit, then `--check`.
9. Testnet L1 pins, which two lanes' tests couple: `networks.ts` `nodeVersion`, `rollupVersion`, `inbox`, `outbox`,
   `feeJuicePortal` from recon.md, and `SepoliaFork.t.sol:34-36` to the same values (EIP-55 literals; solc rejects a
   bad checksum). The sponsor waits for Phase 3 (it needs the rc.3 SDK).
10. Commit `chore(toolchain): aztec 6.0.0-rc.3 pins, locks, noir deps and artifacts`. Send
   `HELPER rc3-bump: phase-3 <branch> <sha>`.

**Validation gate.** Commands: `bun install --frozen-lockfile`; the same with `--cwd contracts/aztec/toolchain` and
`--cwd packages/local-network/toolchain`; `npm audit signatures` (step 4's scratch dir);
`NARGO_CACHE=<tmp>/nargo bash contracts/aztec/scripts/noir-deps.sh --verify --exact` (the clean-cache resolve);
`bash contracts/aztec/scripts/noir-deps.sh` (default cache); `bash contracts/aztec/scripts/noir-deps.sh --self-test`;
`bash contracts/aztec/scripts/compile.sh --check`; `bun run --cwd contracts/evm test:evm` (compiles the fork suite);
`bun run --cwd packages/deployer test`; `bun run lint`; `git grep -n '^minimumReleaseAgeExcludes' -- '*.toml'` (anchored: the root bunfig's comment names the key).
Pass: every command exits 0, except the `git grep`, which must print nothing (exit 1). Layers: lint, supply chain,
compile, unit.

### Phase 2 — Noir lane (this session) ✓ (b8d054d)
1. Token header: `Forked from AztecProtocol/aztec-standards v6.0.0-rc.3 (f7bf63d5)`.
2. Commitment owner per D3 (C, amended): `main.nr:273-277` initializes for `from` and returns, no
   `_push_request_stamp`; `main.nr:248-255` and `token/README.md:259-275` take upstream rc.3's doc text plus one line
   (unstamped, so only a merchant can complete it, once). TXE, the smallest set:
   - upstream's `…_refunds_from` replaces `…_and_finalize`, with the proxy (`dex`) listed inside this test only (the
     shared helper leaves it unlisted, and an unlisted source cannot refund an unstamped commitment), and upstream's
     own assertions: owner private = `refund`, dex private 0, dex public = `pulled − refund`, supply unchanged;
   - a valid commitment completed by the wrong completer is refused (the existing invalid/zero-commitment tests do
     not show it);
   - `a_merchant_refunds_a_users_commitment_unstamped` (alice pays m1 x; alice, the completer, runs
     `transfer_public_to_commitment(m1, c, r)` under m1's authwit; alice private = mint−x+r, m1 public = mint+x−r;
     neither `stamp(c, bucket)` nor `pad(c)` exists; no request effect);
   - `a_user_cannot_pay_into_a_users_refund_commitment`, public and private twins (`should_fail_with` "Payment
     refused: users may only pay into requests opened for a merchant" and the private path's refusal); both fail
     against a verbatim port, including a zero-amount opening by a delegate;
   - rename `both_openings_hand_the_commitment_to_the_opener` → `an_opening_hands_the_commitment_to_the_opener`
     (`initialize_transfer_commitment` only); keep `user_to_user_private_to_public_with_commitment_is_refused`;
   - Codex's negatives (wrong completer, repeat completion, unlisted refund source) only where upstream's tests do not
     already cover them. Manifest entries at `txe-manifest.txt:69,138,187`.
3. Extend `check-stamp-constraint.sh` as in Architecture (D3) and run its `--self-test`.
4. Pre==post: add `a_cancelled_entry_reads_unmarked` to `test/hints.nr` (cap `anchor + MERCHANT_MAX_DELAY − 1`);
   fix the comments at `main.nr:699-700,786-787`, `test/merchants.nr:136`.
5. Rebuild through `compile.sh`; run the three TXE suites. Fix what rc.3 moved (`immutables_hash` defaults, anything
   asserting a cancel's mark). Update the manifests; raise a floor only to a new count.
6. Docs: `contracts/aztec/README.md`; `PROPERTIES.md` SP-09 :660, SP-12 :687, SP-13 :699, SP-27 :840 (drop this
   function from the request openers), GL-19 :232-238, :328-335, SP-21 :769,:781-782 (a cancel no longer marks); `docs/integration.md:3` (rc.3), `:24` (its refund commitment is the payer's and
   unstamped: only a merchant completes it, once), `:28` (a fifth lost behaviour: a non-merchant's refund into it);
   `docs/architecture.md:52` (the only request opener is `initialize_transfer_commitment`), `:57` (this function's
   recipient joins the published sides); `docs/assurance-map.md:30`.

**Validation gate.** Commands: `bun run test:noir`; `bash contracts/aztec/scripts/compile.sh --check`;
`bash contracts/aztec/scripts/check-sole-consumer.sh` and `--self-test`; `bash contracts/aztec/scripts/check-stamp-constraint.sh`
and `--self-test`; `bun run --cwd contracts/aztec test` (ABI superset); `bun run --cwd contracts/aztec typecheck`;
`bun run lint`. Pass: all exit 0; every TXE suite meets its manifest and floor. Layers: lint, typecheck, unit (TXE).

### Phase 3 — TypeScript lane (helper, own worktree off Phase 1's commit) ✓ (41d4768, merged in 8cdd408)
Owned paths: `packages/**`, `apps/**`, except `packages/integration/**` beyond step 6. Never `contracts/**`,
lockfiles, `.github/**`, AGENTS.md, `docs/**`, `implementations-plan/**`.
1. `bun run typecheck`; fix each break with the smallest change; list each with its file for the PR body.
2. Port `timeHorizon` and `merchantStatus.pending` (`&& e.off !== e.scheduledOff`); verify's switch check
   (`verify.ts:275-279`) drops "marked, no switch"; add the pre==post cases to `merchants.test.ts` and the verify tests.
3. Derive the rc.3 SponsoredFPC (salt 0) class and address with the rc.3 SDK; set them in `artifacts.test.ts`,
   `claim.test.ts`, `networks.ts`. Set the three Noir class ids from Phase 1's artifacts.
4. Corroborate Phase 1's fee-juice portal on L1 keylessly (`rollup.getFeeAssetPortal()` on the canonical rollup).
   Run `bun run probe:testnet`.
5. Copies of SDK behaviour: diff the PXE's tx-expiry computation rc.1 vs rc.3 (in `node_modules`) against
   `integration/test/expiry.ts:12` and `bridge-core/src/stamp.ts:34-37`; grep the rc.3 packages for each node/PXE
   error text the code matches (`showcase/src/live/actions.ts:77`, `live/outcome.ts:31,36`, `demo/src/sent.ts:35`).
   Fix any drift; quote both results for the PR body.
6. Presto guard: export its comparison from `build/target.ts`, reading presto's `package.json` by file path (its
   `exports` may block `@alejoamiras/presto/package.json`); three `target.test.ts` cases (refuses: rc.3 manifest,
   real proofs, mismatched presto; passes: fake proofs; passes: manifest on another version). It checks the SDK's
   pinned stdlib, not presto-server's circuits; the PR body says so.
7. `discovery.test.ts`: the rc.3 handshake registry address (aztec-nr rc.3 `standard_addresses.nr`), comment retagged.

**Validation gate.** Commands: `bun run typecheck`; `bun run lint`; `bun run test`; `bun run --cwd apps/showcase test:components`;
`bun run probe:testnet`. Pass: all exit 0. One disposition only: if the probe's "SponsoredFPC published" check fails at
the rc.3 address, record it as an external blocker (PR body, #49) and require every other check to pass; the
sponsor-balance line is informational. Layers: lint, typecheck, unit, component, live keyless read.

### Phase 4 — Converge: merge, heavy gates, CI, docs ✓ (8cdd408..bdf3a54)
1. `git merge` the helper's branch (never a rebase). Refresh the Token class id from Phase 2's artifact.
2. EVM: `forge inspect` deployed bytecode of `TokenPortal` and `Permit2DepositRouter` against `dev`'s (I2).
3. Install the rc.3 node: `bash packages/local-network/scripts/install-node.sh ~/.cache/inference-money/aztec-node-rc3-bump`.
4. Dropped (D10). Was: integration: one spec for the refund route (distinct failure mode: the payer's PXE must discover a refund note it
   owns only through a self-delivered partial note completed in public, which TXE cannot show). A user pays a merchant
   x through `transfer_private_to_public_with_commitment`; the user, as completer, runs
   `transfer_public_to_commitment(merchant, c, r)` under the merchant's public authwit. Assert the user's wallet
   reports mint−x+r privately and the merchant's public balance is mint+x−r. TXE covers the refusals. Estimate 2 min.
5. `[A20]` in `integration/test/merchants.test.ts`: a switch back on now unmarks the entry (title and assertion).
   Then `AZTEC_NODE_HOME=… RUN_ID=rc3-bump bun run test:integration`, then `… bun run test:e2e`; record both
   wall-clocks. Optional, keyless: `SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com bun run test:evm:fork`
   (the one check that touches the new Inbox).
6. CI's Presto job (`_e2e.yml`, `presto`): after checkout and `setup-toolchains` (which installs Bun and the frozen
   root tree), a step runs the guard's exported comparison. Equal versions: the job runs as today. Exactly the
   approved pair (toolchain `6.0.0-rc.3`, Presto's stdlib `6.0.0-rc.1`, named in the step's env with a one-line
   reason): a `::warning::` naming both, and the remaining steps skip. Any other mismatch, a missing file or malformed
   metadata: the step fails. The skip ends by itself when presto moves; a later toolchain bump fails it loudly.
   `actionlint` plus a local run of the step's script on both branches (the real pair; a forced-equal pair) prove it.
7. `bun run --cwd apps/showcase build:testnet` (the guard passes on the rc.1 manifest).
8. Docs: AGENTS.md version rule; `docs/ci-pipeline.md` bump procedure (installer `versions`, temporary excludes,
   signature check, noir-deps re-derive) and the Presto skip; `docs/operations.md` § Rollup upgrade: one or two lines
   that a rollup upgrade which also moves the node version and its PXE oracle interface fails the page's identity check
   before withdraw-only mode can help, and an old deployment's private functions cannot run on the new PXE; the digest
   headers; lessons.md.

**Validation gate.** Commands: everything in Phases 2–3; `bun run lint:actions`; `bun run test:evm` and
`bun run test:evm:gas` (plus `test:evm:formal` and `test:evm:slither` if I2 fails); `test:integration` and `test:e2e`
as above; `build:testnet`; `wc -c implementations-plan/lessons.md`. Pass: all exit 0 (one rerun for a timeout-only
spec, then a MILESTONE naming it); lessons.md ≤ 8,192 B. Layers: all except the blocked real-proof e2e.

## Decision ledger

| # | Decision | Chosen | Rejected and why |
|---|---|---|---|
| D1 | Presto SDK | keep rc.1, block real-proof paths (director) | force deps via `overrides` (unsound: kernel circuits must match the node); hold the bump (hostage to another repo) |
| D2 | Presto guard | conditional build check (director) | unconditional (red CI until presto ships); follow-up only |
| D3 | Commitment owner | C (director's panel, amended): owner `from`, published side first, no stamp/pad/effect | A: stamp follows the owner (proves the hidden payer first, so its switch-off cap can mark it; a stamp would then describe the hidden side); verbatim port (stamps a user-owned commitment: user→user past the rule); unconditional pad (writes a nullifier nothing reads); B: keep rc.1 owner (misdirects upstream refunds to the integrating contract); no side proof (allows user/user unshield) |
| D4 | Testnet pins | move in this PR from keyless reads (director) | leave to the redeploy (nothing may be committed during a keyed run) |
| D5 | Age gate | temporary excludes, never committed (lessons.md) | dated committed exclude (brief default; widens every later re-resolve) |
| D6 | Delivery | one PR, two lanes | outline B below |
| D7 | `follow-ups.md` migration | out of scope | parallel batches share the plan folder |
| D8 | Presto CI job | self-skip for exactly the approved pair, fail closed otherwise (audits) | leave it failing (red required `showcase-status` on every `e2e`-labelled PR until presto ships); skip on any mismatch (hides a future downgrade) |
| D9 | "A cancel marks" | follow rc.6 everywhere (TS `pending`, verify, prose, `[A20]`) | keep rc.1 prose (false docs; verify fails a cancel that no longer marks) |
| D10 | Refund integration spec | dropped (director): a direct client never learns the refund commitment (no private return value from a sent tx; randomness drawn at proving), so only a pull-and-refund contract can use it; covered by `[A22]` one-payment (a self-delivered partial note completed in public, same `UintNote::partial` path) and the TXE refund tests | a test-only pull-and-refund contract (new crate, artifact and harness deploy for a mechanism already covered) |

**Competing outline B (rejected): split mechanical and behavioural.** PR 1: pins, locks, artifacts and test literals
with zero behaviour change (fork keeps the rc.1 owner, TS keeps the rc.1 horizon). PR 2: the ports, the guard, the
testnet pins. Cheaper to review per PR; rejected because PR 1 alone ships a TS horizon that disagrees with the rc.3
token and an owner that disagrees with upstream rc.3, and the brief asks for one PR.

**Unresolved:** none.

## Approval

Approved by the director for the owner, 2026-10-13: D5, D8, D9 approved; A2 with the owner, gating the redeploy, not
the merge. Additions: the status file carries an ETA at every phase change; the PR body states how I1, I2 and I4
settled and names the blocked real-proof gates; D8's env entry carries a one-line removal condition and the PR body
lists it under temporary measures; the optional fork test runs only through
`https://ethereum-sepolia-rpc.publicnode.com`. Lane T: worktree `rc3-ts`, brief = Phase 3 + the delivery protocol.

## Audit verdicts

**Codex (gpt-6.1-sol, high; session `01a136f4…`): reject.** Adopted: #2 Phase 1 ordering (keystone repair and the
rebuild move into Phase 1; `NARGO_CACHE` for the clean-cache verify; `git grep` exit 1 is the pass); #3 the Presto CI
job turns `showcase-status` red on `e2e`-labelled PRs (self-skipping step); #4 supply-chain overclaim (`npm audit
signatures`, attestation source and commit, residual trust stated, TXE executes published artifacts); #5 shared lane
inputs (artifacts rebuilt in Phase 1; Phase 3 gate fully green); #6 the refund route needs one integration spec; #7
probe disposition for a missing sponsor, fee-juice portal corroborated on L1. Superseded: #1 (D3 privacy) by ruling C.

**Opus (fable leg, Plan subagent): conditional approve.** Adopted: #1 `SepoliaFork.t.sol` pins coupled to
`networks.ts` (Phase 1); #2 the never-stamped invariant pinned (guard rule, anchored mutants, comment, private and
public TXE negatives); #3 rc.6's pre==post rule falsifies "a cancel marks" (code, prose, `[A20]`, verify policy, a TXE
twin); #4 PXE rounding and error-text copies checked (I7); #5 non-Aztec lock entries listed, A3 raised; #6 guard
limits stated, presto `package.json` read by path. Checked, no change: #7 the fixture tour's sponsor is never compared
(`demo/src/tour.ts:79-89` compares portal, router, token and bridge only).

**Final fresh Codex pass (gpt-6.1-sol, high; new session `01a13702…`): conditional approve (with conditions: make the
CI skip executable and fail closed, repair the delegated-refund test setup, and bind signature verification to the
Bun locks).** All four adopted: the Presto step runs after setup and fails closed; its skip is confined to the
approved pair; `…_refunds_from` lists its proxy locally with upstream's assertions, plus a wrong-completer case on a
valid commitment; the signature check is tied to the three Bun locks by integrity. Codex's "looks fine": ruling C,
the horizon port and its ripple, the lane hand-off, no further coupled literal found.

## Post-implementation

Run in this worktree on branch `worktree-rc3-bump`. Single arc: steps 1–3 run once, over the net diff from `606fdb5`,
after Phase 4 is green. `code_review` is off: no `/code-review` pass.

1. **Codex audit**: `/codex high` on `gpt-6.1-sol` (`run-codex.sh … gpt-6.1-sol`) with the diff, this plan, the
   decision ledger, an adversarial ask (supply chain, fund direction, stamp semantics, client/contract divergence), and
   these two rules verbatim:
   - *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*
   - *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*
2. **Fix loop**: verify each finding against the code; fix, commit, log the round in `lessons/phase-4.md`; resume the same
   Codex session with the fix diff. A round fixes bugs, adds tests and makes local changes; a fix adding persistent
   state, a lifecycle, a protocol, a recovery policy or a public contract stops for the director. Stop when a round has
   no new material finding; round 3 still material → send `BLOCKED rc3-bump: codex loop`.
3. Send `MILESTONE rc3-bump: codex loop converged`.
4. **Delivery**: `git fetch origin dev && git rebase origin/dev` (own branch only), rerun the fast gates, push,
   `gh pr create --base dev` with a body that lists every behavioural change with its file, the version rule, the
   blocked gates, the redeploy order, the preview's behaviour (an rc.3 bundle against the rc.1 manifest: live mode stops
   at the identity check as production already does; the recorded tour plays), the keyless reads quoted, e2e wall-clock,
   and the follow-ups below. Comment the redeploy order (and I4's result) on #49. `gh pr checks --watch`.
5. **Close-out**, as the PR's final commits: an `## Outcome` block after the front matter (date, status, PR, what was
   dropped and why, `Known limits:`, `Open items:`, the seeds retired); promote lessons (dedupe, retire, date-stamp,
   ≤ 8 KiB); `git mv implementations-plan/rc3-bump implementations-plan/archive/rc3-bump` in its own commit with link
   repair; move the index line to `archive/index.md`. Open items go to the director, who files them:
   - Withdraw-only mode (#48) assumes a rollup switch on the same node version (operations.md states the limit).
   - Restore real-proof paths once presto ships rc.3 (remove the cast if any; the guard then passes).

   | Situation | Home |
   |---|---|
   | Work inside this implementation | this plan and the PR |
   | Actionable work that outlives the plan | a GitHub issue (domain label, `Record` link to the archived plan) |
   | Needs a product call or waits outside the repo | an issue labelled `owner-decision` or `blocked:external` |
   | A suspected exploitable weakness | a private draft security advisory; this plan records only its id |
   | Rejected, superseded or done | a disposition line in the Outcome |
   | Needs unsupported conditions, or does not matter | a closed `known-limit` issue |
   | Knowledge that prevents a repeat | `implementations-plan/lessons.md` |
6. Send `DONE rc3-bump: <PR url>; CI <state>`; stay alive for rebases. Never merge.
7. **Teardown after the merge**: once `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/rc3-bump/plan.md`
   succeeds, `ExitWorktree` (`keep`), then `agent-worktree done rc3-bump --merged --trunk dev`; relay a refusal, never
   force. This session arms one background wait for that check after DONE (`until …; do sleep 300; done`).

## Delivery

Single arc, one branch (`worktree-rc3-bump`), one PR to `dev`, opened only after the Codex loop converged; the close-out
lands as its final commits.

**Lanes** (director-approved by the brief): base = Phase 1's commit.

| Lane | Phases | Owned paths | Worker | Branch |
|---|---|---|---|---|
| N | 1, 2, 4 | everything not in T | this session | `worktree-rc3-bump` |
| T | 3 | `packages/**`, `apps/**` (integration: `discovery.test.ts` only) | director-spawned helper (opus) | the helper's own, off Phase 1's sha |

Shared inputs: both lanes read Phase 1's rebuilt artifacts; only the Token's class id moves after Phase 2, and Phase 4
refreshes it. Join: `git merge <lane-T-branch>` into `worktree-rc3-bump` after both gates pass; rerun Phase 3's gate
on the merge. Only this session touches lockfiles, `.github/**`, AGENTS.md, `docs/**` and `implementations-plan/**`.
Estimate: serial ≈4.5 h, with lanes ≈3.2 h.

## Seeds

Recommended: none needed — this session drives the plan to DONE under the delivery protocol. For a fresh session:

```
/goal implementations-plan/rc3-bump/plan.md: Phases 1–4 marked ✓, each gate's output in the transcript; codex loop converged (quoted); PR to dev open with green checks (gh pr view in the transcript) including the close-out archive commit (git show --stat); bun run test and bun run lint exit 0.
```
