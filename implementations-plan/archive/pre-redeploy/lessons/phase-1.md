# Phase 1: #52, a private self-send proves no side

- The worktree has no aztec-up install of `6.0.0-rc.3`; `toolchain.sh` takes `NARGO`. Installed CI's way: the
  noir-lang `v1.0.0-rc.3` release, checked against `.github/actions/setup-toolchains/nargo-1.0.0-rc.3.sha256`, into
  `~/.cache/inference-money/nargo-1.0.0-rc.3/`.
- Negative control without a rebuild: TXE deploys the committed artifact, so the new test, run filtered before
  `compile.sh`, exercised the unfixed contract and failed with `Trying to read from uninitialized PublicImmutable`
  (alice's entry read through the capsule's FIRST).
- `compile.sh` changed only `merchant_token-Token.json`; class id `0x11db2d2d…` → `0x10382a04…`, pinned only in
  `packages/bridge-core/src/artifacts.test.ts`.
- `txe-manifest.txt` is not globally sorted (upstream block, then the merchant block with appended runs); the name
  went in beside its neighbour.
- commitlint caps body lines at 100 characters.
- Gate: TXE token 190 passed (189 named), token_bridge 85, keystone 20; `compile.sh --check` matches; both static
  guards and their self-tests exit 0; `contracts/aztec` tests 6/6; bridge-core 197/197.

LESSONS_FILE=implementations-plan/pre-redeploy/lessons/phase-1.md
