# Recon: testnet-redeploy

Base `origin/dev` at 8606c81. Recon by the driver: the batch runs existing CLI commands and writes no code.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Keyed checkout, pinned to a pushed tip, installed without scripts | `scripts/keyed-worktree.sh` (`sync`, `remove`) | reuse-as-is |
| Keyed request and approval | `env-exec request --template … -- <cmd>` (`~/.local/bin/env-exec`), `op-remote` on the Mac | reuse-as-is |
| Admin address on the current SDK | `bridge admin address` (`packages/deployer/src/commands.ts:67`) | reuse-as-is |
| Deploy, propose the handover, verify, write `deployments/testnet.json` | `deployTestnet` (`packages/deployer/src/testnet.ts:86`); records `l1.portalTx`, `l1.routerTx`, `l2.merchantDelay` (`deploy.ts:80-88`) | reuse-as-is |
| Cast funding | `demo fund` → `demoL1` targets (`packages/demo/src/amounts.ts:17`), sponsor top-up by Fee Juice mint (`demo.ts:298`) | reuse-as-is |
| Demo cast and the v2 demo file | `demo setup` (`packages/demo/src/files.ts:18,48`) | reuse-as-is |
| Acceptance run and tour | `smoke --record` (`packages/demo/src/tour.ts:41`) | reuse-as-is |
| Strict read-back | `bridge verify <manifest> [--tour]` (no `verify:testnet` script exists; only `verify:local`) | reuse-as-is |
| Bundle checks | `bun run --cwd apps/showcase build:testnet` | reuse-as-is |
| Served check | `SHOWCASE_URL=… bun run --cwd apps/showcase test:testnet` | reuse-as-is |
| Secrets scan | `bun run secrets:scan` (`packages/deployer/src/scan.ts`): fails on `skipped > 0` (a link out of its roots) | reuse-as-is |

No new code: searched `packages/deployer/src`, `packages/demo/src`, `scripts/`, root `package.json` scripts for each command above.

## Prior run

`archive/pashov-audit-fizz/lessons/phase-18.md` (2026-10-05): `demo fund` reverted on a short USDC balance; the scan failed on a Python venv in the cache; `env-exec` refuses a dirty keyed tree; two keyed runs never share the keyed worktree; each `demo setup` pass waits about an hour; `build:testnet` needs a real Node 24 on `PATH`.

## Collisions

- `deployments/testnet-deploy.env.example`'s `TESTNET_ADMIN_ADDRESS` is the rc.1 derivation (see plan Fact 1).
- Open issue #49 is this batch's scope (`Closes #49`).
