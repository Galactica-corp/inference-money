# Recon: pre-redeploy

Base: `worktree-rc3-bump` @ dd63688 (the rc.3 bump, not yet on `dev`). One Sonnet reuse sweep plus the driver's reads.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Self-send skips the side proof (#52) | `transfer_private_to_private` (`contracts/aztec/token/src/main.nr:289-309`) proves a side first, then accepts `from == to` with any side; `_prove_merchant_side` (`:1140`) asserts the side the hint or capsule names | adapt: gate the proof on `from != to` |
| A TXE test that a capsule reaches a real call | `store_side_capsule` and the capsule tests in `token/src/test/hints.nr:86-330`; self-send test `rules_private.nr:60-69` | reuse the helpers; one new test in `hints.nr` |
| Observing a tx's expiry in TXE | only entry-level, `horizon_and_cap` (`test/hints.nr:47-62`); `TestEnvironment::call_private` returns the function's value only (aztec-nr v6.0.0-rc.3 `test_environment.nr:1148`) | absence: no whole-call expiry read (searched `expiration_timestamp`, `82800`, `include_by` in `token/src/test`); test "reads no entry" instead |
| Exit recipient refusal (#57) | `assertExitIntent` (`packages/bridge-core/src/exit.ts:49-60`), `it.each` rows in `exit.test.ts:61-70` | adapt: four more rows each |
| Refund refusal + proof | `_requireDepositor` (`TokenPortal.sol:335`), `proveRejectsBadRefund` (`FormalPortal.t.sol:313`, `which % 3`), `PortalWithoutDepositorCheck` (`Mutants.sol:45`), canary (`FormalPortal.t.sol:449`), gate entry (`contracts/evm/scripts/halmos-gate.sh:17`), fuzz handler `tokenPortal_depositToAztecPublic_badRefund` (`fizz/handlers/TokenPortalHandler.sol:205`, `% 3`) and GL-21 (`PROPERTIES.md:53`) | adapt: six sinks everywhere the three are enumerated |
| Rollup version at the binding (#59) | `initialize` (`TokenPortal.sol:121`) reads `rollup.getVersion()`; `FakeRollup.VERSION = 4242` constant (`test/mocks/AztecFakes.sol:48`); `initializePortal` (`packages/deployer/src/deploy-l1.ts:9`); the node's `info.rollupVersion` already feeds the manifest (`deploy.ts:83`); testnet's `probeNetwork` pins node == `TESTNET.rollupVersion` before `deployBridge` (`testnet.ts:91`, `preflight.ts:39`) | adapt; ~30 `initialize(` call sites in `contracts/evm/test` (forge, halmos, fizz, fork) plus `operator.test.ts:143` |
| Rollup-moved fixture | `FakeRegistry.setCanonicalRollup` (`AztecFakes.sol:83`) | reuse; `FakeRollup` needs a second version |
| Demo merchant derivation (salt) | `aztecSecret`/`castMember` (`packages/demo/src/cast.ts:15-35`); demo file schema `packages/demo/src/files.ts` (a leaf, Node-loaded by `apps/showcase/build/target.ts`), not bridge-core | adapt |
| Callers deriving merchants | `merchantAddresses`, `bound`, `prepare` (`packages/deployer/src/demo.ts:155,185,182`), `demoStatus`/`demoReset`/`demoFund` (`demo.ts:244-320`), `enlist` (`demo-flows.ts:38`), `smoke.ts:337,353`, `verifyDemoCast` (`verify.ts:318`), showcase `wallet.ts:172`, `start.ts:21`, `vite.config.ts:74`, `config/network.ts:23`, `e2e/testnet/live.spec.ts:27` | adapt: one `CastKeys` argument |
| CSPRNG draw | `randomSecret` (`packages/bridge-core/src/random.ts:7`) | reuse |
| Setup resume + publish | `runSetup`/`SetupPlan`/`demoSetup` (`demo.ts:71-241`), tests `deployer/src/demo.test.ts:65-180` | adapt; no test covers `demoSetup`'s rotate branch today |
| Sponsor Fee Juice claim | `topUpSponsor` (`fee-juice.ts:67`): any account may send the claim; `demo fund` sends it from galactica (`demo.ts:301`); its keyed env holds only the L1 key (`disposable.ts:88`) | adapt: a claimer derived from the deployment alone |
| Idempotent account deploy | `ensureAccount` (`deploy-l2.ts:29`) skips an initialized instance | reuse |

## Collision / dedup notes

- `check-stamp-constraint.sh` pins the side calls of `transfer_public_to_private`, `transfer_private_to_public(_with_commitment)` only; `transfer_private_to_private` is free to nest its proof.
- The Token class id is pinned in `packages/bridge-core/src/artifacts.test.ts:11`; #52 moves it.
- bridge-core's hand-written `TOKEN_PORTAL_ABI` is a pinned subset and has no `initialize`; a new error needs no entry there.
- `.gas-snapshot` holds only `test_gas_deposit*`; `_requireDepositor` runs in the direct public path, so it may move.
- The committed `deployments/testnet-demo.json` is version 1 and `build:testnet` (CI `showcase` job) parses it.
- Parallel batches may edit `docs/*.md`, `AGENTS.md` and `TokenPortal.sol`: keep edits inside these findings' own lines.
