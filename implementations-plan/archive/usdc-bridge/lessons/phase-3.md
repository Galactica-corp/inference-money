# Phase 3 — L2 contracts + V2 QA Aztec.nr port

Status: **green 2026-09-26** (gate evidence below).

## Gate evidence

`bash contracts/aztec/scripts/noir-deps.sh --self-test && bash contracts/aztec/scripts/noir-deps.sh && bash contracts/aztec/scripts/compile.sh --check && bun run test:noir && bash contracts/aztec/scripts/check-sole-consumer.sh --self-test && bash contracts/aztec/scripts/check-sole-consumer.sh` → exit 0 on the committed tree, `git status` clean afterwards.

- **Class ids reproduce V1 exactly**, and so does the SDK-facing ABI (`artifact-identity.ts compare` against V1's artifacts): TokenBridge `0x2cb5c6341bbae9bb0e78b64cfdd724cb493cc35dca46b122280fdf223b3d8713`, TokenMinterProxy `0x07689a539bf0a60a252f9b88406d5a4b129f192f7da37ab181c7a2be6910524a`. Re-checked after the comment scrub.
- **TXE**: token_bridge 47/47 (V1's 33 + the 14 new), keystone 8/8, both through the manifest gate (floors 47 and 8).
- **Keystone literals** equal `ContentHash.t.sol`'s `MINT_TO_PUBLIC`, `MINT_TO_PRIVATE` and `WITHDRAW` byte for byte.
- **Sole-consumer**: the real source passes; 11 regressions are rejected, each for its intended reason (printed by `--self-test`).

## What was built

- The four crates, copied from V1, with only comments and a test-token name changed (finding ids, plan phases and old repo names removed; the `nulo_` domain-separator string is load-bearing and stays).
- `scripts/toolchain.sh` (sourced): resolves the pinned toolchain from `toolchain.json`. Used by `nargo-5.sh`, `compile.sh` and `run-txe-tests.sh`.
- `noir-deps.sh`: pinned table of the 5 git deps (3 transitive) from a clean-cache probe; fetch → verify (HEAD == pin, clean tree). `--verify --exact` also fails on any unpinned cache entry.
- `compile.sh --check`: compares against the **HEAD** artifacts (`git show`), restores the working tree.
- `artifact-identity.ts` + test: the `claim_public` rename keeps the class id equal and fails `compare` (exit 1), the path `--check` takes.
- `run-txe-tests.sh`: `--crate token_bridge|keystone`, a committed `toolchain/` lockfile (was `txe-server/`; see round 2), a per-run port, owned-pid teardown, the manifest gate.
- 14 new TXE tests, plus the relayer's private and public balance asserted 0 in `claim_private_via_relayer_mints_to_recipient`.
- CI `noir` job; `docs/assurance-map.md`.

## Decisions and deviations

1. **`--exact` + an uncached `~/nargo` in CI.** The plan asked for a clean cache. A clean cache alone does not prove the pinned table is complete: nargo fetches a missing transitive dep on demand, unverified. So CI ends with `noir-deps.sh --verify --exact`, which fails if anything outside the table was fetched. Locally `--exact` is not usable: this host's `~/nargo` is shared across projects (it lists other tags).
2. **The rename regression runs at the CLI level, not through a full `compile.sh --check`.** `compare` is the exact function `--check` calls; driving it through a rebuild would add ~1 min to every unit run for no extra coverage.
3. **The private no-authwit error is an oracle error.** `exit_private_without_authwit_rejected` fails with `Unknown auth witness for message hash`: during private execution the token asks the oracle for the witness. The public path fails with `unauthorized`.
4. **Manifest regex.** V2's `Testing [A-Za-z0-9_:]*::name` required a module path; keystone's tests are root-level and print none. It is now `Testing ([A-Za-z0-9_]+::)*name`, still anchored so a longer name ending in `name` cannot satisfy it.
5. **Node pinned in `toolchain.json` (`24.12.0`).** The Aztec 5.0.1 installer exits unless node meets its manifest minimum (`24.12.0`), and ubuntu runners ship older. The action now uses `install.aztec-labs.com`, the host `aztec-up` itself uses; `install.aztec.network` answers with a 301.
6. **Test names follow the plan** (`exit_{public,private}_…`), though V1's own exit tests use `exit_to_l1_…`.

## Attempts that failed

- **`aztec compile` skipped the build** ("No source changes detected"): the copied V1 artifacts were newer than the sources. `compile.sh` now always clears `target/*.json` first.
- **The first sole-consumer self-test passed vacuously.** Every fixture shared one directory, and the crate-wide count scanned all of them, so all nine rejected on "found 20". Each fixture now gets its own directory, and the self-test prints each rejection reason so this cannot recur silently.
- **The first `noir-deps.sh --self-test` failed**: `git tag` wanted a message (the host signs tags), and the EXIT trap referenced a `local`. Then `--exact` missed its own fixture because of the `file://` double slash. All fixed.
- **Perl locale warnings** (this host's `LC_CTYPE=UTF-8`) came from the path scrub and the comment stripper; both now run under `LC_ALL=C`.

## Arc 1 codex loop

### Round 1 — session `01a0df20-a6e6-7443-8b29-87611c5b8420` (GPT-6 Astra, high)

No theft path found (moderate confidence). 10 findings, all verified against the repo before acting:

| # | Sev | Finding | Verdict |
|---|---|---|---|
| F1 | M | `EmbeddedWallet { ephemeral: true }` is not in-memory: `openTmpStore` writes LMDB files under `os.tmpdir()` holding account secret and signing keys, removed only on a clean close. | **Accepted, fixed differently.** Aztec 5 has no in-memory KV store for Node, so a "memory-only store" means writing a new KV layer (over-engineering). `withOwnedTmpDir` points TMPDIR at an owner-only `~/.cache/inference-money/wallet-tmp/<pid>`, removes it after, and reaps dead runs' dirs. The plan's two "in-memory / never written" claims were corrected; this also governs the Phase 5/7 deploy wallets. |
| F2 | M | Sole-consumer check never pinned claim_public's binding (a claim_public consuming `mint_to_private` passed), nor the derive arguments. | **Accepted.** Both paths are now pinned: content hash, `config.portal` as the sender, derive `(claim_salt, recipient)`, mint target. Every self-test fixture is the real source with one mutation, asserted to fail for its own reason (15). New TXE test `claim_public_cannot_redeem_a_private_deposit`; the floor is now 48. |
| F3 | M | `fail_on_revert = false` lets a regression that rejects valid deposits pass the invariants vacuously. | **Accepted.** Set to `true`; 0 handler reverts over 768k calls. |
| F4 | M | The halmos gate matched names globally; both contracts have `check_deposit_rejectsAmountAboveU128`, so one could vanish. | **Accepted.** The gate compares the exact (contract, proof) set, and `--self-test` feeds it a swapped, a missing and a failing proof. |
| F5 | L | The canaries demonstrated forbidden outcomes but never ran the proof bodies (and the header comment claimed they did). | **Accepted.** Each `check_` delegates to a public `prove*` body; each canary runs that body against its mutant and requires the named assertion (`ProofCanary._assertProofFails`). |
| F6 | M | No CI runs deployer TS checks; the plan's `bun audit` is not run anywhere. | **Accepted.** `deployer.yml` (biome, typecheck, unit) and `audit.yml` (advisory: all 22 findings are transitive through the exact-pinned `@aztec/*` 5.2.0 stack, which moves only as a whole). |
| F7 | M | The Aztec installer is piped to bash unverified; the cache key is version-only. | **Accepted.** sha256 pins for the installer (checked before it runs) and for nargo and bb (checked after every install or cache restore), and the pins are in the cache key. nargo matches the noir-lang v1.0.0-beta.22 release; bb matches the npm `@aztec/bb.js@5.0.1` tarball. **Residual:** the installer's `npm install` JS tree has no lockfile, so it is unpinned. |
| F8 | L | TXE readiness could accept another run's listener that won the port race. | **Accepted in part.** Readiness now requires our own server's post-bind `TXE listening on port N` line plus a live pid. **Rejected:** moving TXE onto the `~/.agents/ports.md` registry. The plan scopes the registry to Phase 5's local network, and proof of ownership already closes the failure. |
| F9 | L | `expect_rejected` accepted any failure reason. | **Accepted** (folded into F2's rewrite). |
| F10 | Nit | Narration comments in TokenPortal; a false "relayer-submittable" claim on private exits; `[F-x]`/F-001/Phase labels; history in the contract headers. | **Accepted.** All removed or tightened. Class id + ABI re-verified equal to V1 after the header edits. |

"Any ERC20" reserve inference: agreed it is too strong. Exact deltas protect only the portal's own transfers, not rebases or issuer-side balance changes. No code claims otherwise.

Gate after the fixes (`a970c67`): Phase 3 gate `GATE3_EXIT=0` (class ids == V1, TXE 48/48 + 8/8, 15 mutants), EVM gate, fork 8/8, lint/typecheck/test/actionlint.

### Round 2 — same session, resumed with the `a970c67` diff

Codex: "two new findings in the fixes; no new contract-level flaw identified", plus pushback on the F7 residual. All verified against the code before acting:

| # | Sev | Finding | Verdict |
|---|---|---|---|
| F11 | M | `withOwnedTmpDir` always uses `<root>/<pid>` and wipes it on entry, so a nested or concurrent call in one process deletes the active scope's wallet stores and restores TMPDIR out of order. | **Accepted.** A module-level guard rejects an overlapping scope before touching the dir or TMPDIR (TMPDIR is process-global, so one scope per process is the real constraint). The regression writes a store inside a scope, asserts the nested call throws and the store survives. |
| F12 | L | The TXE readiness log was named by port only, so a stale or concurrent run's `TXE listening` line could satisfy `owned_up`. | **Accepted.** Each spawn logs to a fresh `mktemp` file, removed at teardown; a failed start prints the log's tail instead of a path. **Rejected:** a dedicated regression. The file is created empty for that spawn alone, so there is no remaining association logic left to test. |
| F7 (pushback) | M | The installer's unlocked npm tree still runs in CI. | **Accepted, and wider than claimed.** The installer also runs `noirup` from its `main` branch and `foundryup` via `curl \| bash`. CI no longer runs the installer: `contracts/aztec/toolchain` (renamed from `txe-server/`) locks `@aztec/aztec@5.0.1`, which carries the aztec CLI, `@aztec/bb.js` and `@aztec/txe`. nargo is the noir-lang release tarball, sha256-pinned (equal to GitHub's recorded asset digest) and checked before extraction. `toolchain.sh` also asserts the nargo in use reports `toolchain.json`'s new `nargo` pin, locally as well. |

Found while fixing F7: **bun reads `bunfig.toml` from the cwd only**. A nested standalone project (the old `txe-server/`) ignored the root's 7-day `minimumReleaseAge`. Probe: a subproject installed hoisted despite the root's `linker = "isolated"`, and went isolated once given its own bunfig. So the old TXE lock was resolved without the gate. `toolchain/bunfig.toml` restates it, and the lock was re-resolved under it. The locked `bb` binary hashes to the old pin.

Gate after the fixes: the Phase 3 gate on the local toolchain `GATE3_EXIT=0`; the CI path simulated locally (release tarball checked against the pin, extracted, `NARGO` set, frozen toolchain install) `compile.sh --check` + TXE 48/48 + 8/8, `GATE3_CI_EXIT=0`; a write-mode `compile.sh` leaves both committed artifacts byte-identical; lint, typecheck, actionlint and deployer 11/11 green.

### Round 3 — same session, resumed with the `91d4f78` diff

Codex: "One new Low-severity bug and one comment correction. High confidence." No pushback on the F12 regression rejection; the installer replacement, checksum-before-extraction, cache key and local resolution "look sound".

| # | Sev | Finding | Verdict |
|---|---|---|---|
| F13 | L | If `withOwnedTmpDir`'s cleanup `rmSync` throws, the `active` flag never resets and every later scope in the process throws "already active". | **Accepted.** The flag is cleared before the removal; a regression locks a subdirectory so cleanup fails with EACCES, then asserts the next scope runs. |
| F14 | Nit | `toolchain/bunfig.toml` gave the wrong reason for the hoisted linker. | **Accepted.** The reason is that `run-txe-tests.sh` launches the transitive `@aztec/txe` from the root `node_modules`. |

**Round cap.** The plan stops the loop at 3 rounds only when findings are still material. Severity fell every round (4 M → 1 M + 1 L → 1 L + 1 Nit), and F13 is a fail-closed robustness bug in a helper no value path uses yet, so both were fixed and one short confirmation pass on the fix diff closes the loop.

### Confirmation pass — same session, resumed with the `b73505b` diff

Codex: "**No new material findings.** Both fixes are correct (high confidence)." The Arc 1 loop has converged.

## Moved from lessons.md

- Homelab: git signs tags (fixtures need `git tag -m`), perl warns under the host locale (use `LC_ALL=C`), a shared `~/nargo` fails `noir-deps.sh --exact` (CI's clean cache passes), and `node` is off PATH (vitest's jsdom workers and the showcase's Vite config then fail under Bun: put Node 24 first). [phase-1](../../harden-security-whole-repo/lessons/phase-1.md), [phase-18](../../pashov-audit-fizz/lessons/phase-18.md)
