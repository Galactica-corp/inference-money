# Recon: presto-restore

Base: `origin/dev` at 437ae93. One Sonnet reuse sweep plus the driver's own reads.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| The Presto SDK pin | `apps/showcase/package.json` (`@alejoamiras/presto` 6.0.0-rc.1); `bun.lock` lines 22, 177 and the nested `@alejoamiras/presto/*` rc.1 copies | adapt: bump to 6.0.0-rc.3, re-lock |
| `@alejoamiras/presto-noir` | not declared anywhere (searched `presto-noir` over the tree, `node_modules`, `.git` and `archive/` excluded) | none to bump |
| The prover cast | `apps/showcase/src/demo/wallet.ts:166-167` and its `PrivateKernelProver` import at line 5 | remove once typecheck passes without it |
| The CI self-skip | `.github/workflows/_e2e.yml` `presto` job: the `compat` step, `PRESTO_SKIP_*`, three `if: steps.compat.outputs.run == 'true'` | remove the step and the conditions |
| The compat check | `apps/showcase/e2e/run/presto-compat.ts`; no test, no importer besides `_e2e.yml:51` | remove (see plan D1) |
| The real-proof build guard | `apps/showcase/build/target.ts` `prestoPins`, `assertPrestoProves`; `target.test.ts` "Presto's stdlib" (fixture root, writes its own presto `package.json`) | reuse as is; `prestoPins` loses its `export` (its other caller goes) |
| CI gating | `showcase.yml`: `e2e` runs on the `e2e` label or a dispatch; `showcase-status` reads `needs.e2e.result`, the aggregate of `_e2e.yml`'s jobs | reuse as is: a failing `presto` job turns it red |
| Frozen installs | `.github/actions/setup-toolchains/action.yml:54` (root `bun install --frozen-lockfile`) | reuse as is |
| Age gate | root `bunfig.toml`: `minimumReleaseAge = 604800`, no excludes; nested toolchain bunfigs unaffected | temporary exclude while locking, never committed |
| Docs | `docs/ci-pipeline.md:14` describes the compat step and the skipped pair as current | adapt |
| SDK surface used | `PrestoProver` (`src/presto/prover.ts`), `loopbackPermission`, `watchLoopbackPermission`, `LoopbackPermissionState`, `PrestoStatus` (`src/presto/consent.ts`), `PrestoPhase` (`src/presto/proofs.ts`) | typecheck and component tests prove the rc.3 surface |
| presto-server pin | `toolchain.json` `prestoServer` 1.1.3, `apps/showcase/e2e/run/presto-server-1.1.3.sha256` | reuse as is |

## Collision and dedup risks

- `gh issue list --state open --search presto` also lists #67 (page copy about the witness) and #49 (testnet manifest fields): neither touches these files.
- `implementations-plan/follow-ups.md` and `lessons.md` carry no line about the skip.
- `deployments/testnet.json` records node 6.0.0-rc.1, so the guard skips the testnet build until the redeploy.
