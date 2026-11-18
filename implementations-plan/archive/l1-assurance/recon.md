# Recon: l1-assurance (#89)

Base: `origin/dev` at 8606c81. One reuse-sweep agent plus the driver's reads. `E` = `contracts/evm`.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Signature-verifying Permit2 | `packages/deployer/bytecode/permit2.json`: Permit2's Sepolia **runtime** (9 152 bytes, keccak `0x96d9…3751`, canonical address); `installCanonicalPermit2` (`packages/deployer/src/l1.ts:104-119`) checks the keccak, installs, reads back. No Solidity test loads it (searched `permit2.json`, `etch`, `deployCode` under `E/test`). The runtime bakes chain id 11155111 into its cached separator, so on any other chain `DOMAIN_SEPARATOR()` rebuilds from `block.chainid` and `address(this)` | adapt: embed the runtime in a Solidity constant, etch it at the canonical address |
| Etch inside Medusa | `E/test/fizz/utils/Hevm.sol` declares no `etch`; the pinned Medusa 1.5.1 binary carries the cheatcode (its name table reads `warp roll load etch deal addr sign`). Medusa has no file-read cheatcode and runs with FFI off | adapt: add `etch` to `IHevm` |
| Independent Permit2 digest | `E/test/mocks/Permit2Digest.sol` (Permit2's spec: domain without version, witness type appended to the stub), used by `SepoliaFork.t.sol` and `WitnessHash.t.sol`; cross-pinned with `packages/bridge-core/src/permit2.ts` | reuse as-is |
| Permit2 error selectors | `IPermit2Errors` declared inside `E/test/SepoliaFork.t.sol:20-26` | adapt: move beside the runtime so the fork suite and the fizz harness share it |
| Signing in fizz | `Base._permitSignature` (signs `router.permitDigest`), `Base._authorize`, `actorKey` | adapt: sign the spec digest; add an explicit-deadline variant |
| Mock-coupled fizz code | `Base.permit2` typed `MockPermit2`; `permit2.calls()`/`setReject`/`last*` in `Permit2DepositRouterHandler.sol:104,119-134`, `TokenPortalHandler.sol` (`tokenPortal_foreignSignature`), `Properties.sol:429-455` (SP-03) | adapt: replace with nonce-bitmap reads and Permit2's own refusals |
| Router nonces | every router leg signs nonce 0 (`_attemptDeposit`, `_maxAmount`, `_rejectedPermit`), the clamped handler a fuzzed nonce; the mock ignores both | build new: a per-signer fresh-nonce helper |
| Fee modes | `ModalUsdc` (`Normal`, `FeeOnTransfer` recipient fee, `SenderSurcharge` sender surcharge, 1 %, sink `0xdead`; blacklist targets actors only); `_withdrawHealthy` (`TokenPortalHandler.sol:400-403`), `adv_depositLiveness` (`RoundTripHandler.sol:122-131`) | adapt |
| Refund address | `tokenPortal_depositToAztecPublic` always passes `actor` as `_depositor`; GL-23 already checks the content hash names the recorded depositor | adapt: seed it from the three actors |
| Field-max, deadline and rollback probes | `tokenPortal_depositToAztecPublic_fieldBoundary` (direct only); `permit2DepositRouter_deposit_malformed` kinds 0-3 (refused before Permit2); no deadline-edge probe; `TokenPortal._consumeAuthorization` documents the rollback, no fizz probe checks it (searched `rollback`, `authorizationUsed` in `E/test/fizz`) | adapt (kind 4), build new (deadline edge, rollback) |
| Property bookkeeping | `PROPERTIES.md` (GL-01..34, SP-01..22, stable IDs, SHOULD-HOLD/EXPLORATORY tags); `fuzz.sh` counts public zero-arg `property_*` in `Properties.sol` and fails when Medusa registered fewer | reuse |
| Coverage record | `E/fizz_data/`: seven tracked files from the suite's one-time generation (ABI inventory, entry points, notes, cost, coverage targets, property plan, report), all stale (old five-argument ABI missing, mock-only Permit2, an open GL-26 that is closed). Medusa writes its report to `fizz_data/corpus_medusa/coverage/` (ignored) | build new: delete the snapshot, upload the nightly's coverage |
| Slither IR failures | `E/scripts/slither.sh` lets stderr through and fails on exit status only. Slither 0.11.6 (`solc_parsing/slither_compilation_unit_solc.py:810-830`) logs `Impossible to generate IR for <Contract>.<function> (<source>)` on an `AttributeError`, marks the contract incorrectly constructed (which also skips SSA for all its functions, `core/declarations/function_contract.py:138`), skips the body and exits 0; other exceptions abort the run (non-zero). A Slither run on this tree's sources logs this for `TokenPortal.constructor`, `_EIP712Name`, `_EIP712Version`, all mapped to OpenZeppelin's `EIP712.sol`, plus about 40 Aztec library functions. The hidden `--disallow-partial` flag would abort on those three too | adapt: capture stderr, filter |
| PR-path Medusa | `fuzz-contracts.yml` (nightly, 1 h, main + dev; setup 29-35 s, crytic-compile 47 s, wind-down about 21 s in run 38537455069); `contracts.yml` `changes` job with one `relevant` filter; `_contracts.yml` jobs `evm` (352 s) and `noir` (661 s) in run 38610718066 | adapt: a second filter output and a `medusa` job |
| Nightly fork job | `scripts/fork-gate.sh` refuses to run without `SEPOLIA_RPC_URL`; `SepoliaFork.t.sol` forks the latest block. No workflow writes issues (searched `issues: write`, `gh issue`, `github-script` under `.github`) | build new: `fork-contracts.yml` |

## Conventions

- Fizz: `<contract>_<fn>[_clamped|_malformed|_secondary]`, `adv_*` probes, try/catch with a refusal selector (`_requireRefusal`), `_noopBegin`/`_noopEnd` around refused calls, ghosts that properties require to stay zero, sign before any prank.
- CI: SHA-pinned actions, `permissions: contents: read` by default, `dorny/paths-filter` with every shared root file a suite loads, matrix over `main`/`dev` for scheduled jobs, `*-status` aggregation.
- `forge fmt --check` covers tests; `forge lint` covers `src/` only. Medusa local runs at most 120 s (host rule).

## Collisions

- No open issue overlaps (`gh issue list --state open`); #85 edits docs generally, not these sections.
- The fork suite already pins replay, expiry, tamper-keeps-nonce and stolen signatures against live Permit2; the fizz probes add randomized sequences, not new fixed cases.
- `docs/ci-pipeline.md:3` says every workflow is `contents: read`; the fork workflow's report job is the first exception.
