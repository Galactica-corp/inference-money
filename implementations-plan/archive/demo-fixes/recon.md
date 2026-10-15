# demo-fixes: recon

Base: `origin/dev` at 4ed8ad4 (after #103). Recon by the driver, no subagent: every issue names its files.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Rebuild a claim ticket from L1 | `reconcileDeposit` (`bridge-core/src/deposit.ts`): by tx hash, then a log scan from the pre-send finalized block | reuse-as-is |
| Detect a missing Inbox message | `NOT_YET_CLAIMABLE` (`claim.ts`), private; `waitConsumable` throws a plain `Error` on exhaustion | adapt: a typed exhaustion error, one predicate |
| Store a rebuilt ticket | showcase `ctx.tickets.putDeposit`; demo setup `plan.tickets[seed]` + `store.write` (`deployer/src/demo.ts` `seedTicket`) | reuse-as-is |
| Shared claim flow | `castClaim` (`demo/src/flows.ts`), used by the showcase and demo setup | adapt: optional rebuild hook |
| Pre-send simulation error | `SimulationError` (`@aztec-labs/stdlib/errors`): thrown by the PXE's private execution, which `EmbeddedWallet.sendTx` runs before `node.sendTx`; node replies arrive as plain `Error` (foundation `json-rpc/client/fetch.js`) | reuse-as-is |
| Cause-chain walk | `isUserRejection` (`errors.ts`) walks `cause` to depth 6 | pattern to match |
| A tx's final fate | `finalFate(node, hash, expiresAt)` (`payments.ts`) | reuse-as-is |
| CSPRNG field | `randomSecret` (`random.ts`) | reuse-as-is |
| Lint rule on a call shape | Biome 2.5.14 GritQL plugin in an `overrides` entry: probed, flags `Fr.random()` in sources and skips `*.test.ts` | build new (no precedent; one `.grit` file) |
| Egress assertion | `me.rpc.calls` / `me.egress` (`apps/showcase/e2e/fixtures/test.ts`, `rpc.ts`) | reuse-as-is |
| Wallet opening state | `useOpening(promise)` (`showcase/src/demo/useOpening.ts`) | adapt: take a starter and a `needed` flag |

## Collisions and facts

- `random.test.ts` imports `random.ts` under `SEED=7`: it must be rewritten for #73.
- The deployer CLI never imports bridge-core's main entry before its own SEED refusal (`cli.ts`, `secrets.ts` import only `aztec.js/fields`), so `cli.test.ts` keeps exit 2.
- `SentTx.refused` is read only by `fateOf` (`showcase/src/live/actions.ts`) and `sent.test.ts`.
- `HIDDEN.pay` reaches the live feed and `smoke --record`; no e2e spec asserts hidden fields.
- `deployments/testnet-demo.json` is version 2 already, so dropping v1 breaks no committed file.
- `verifyDemoCast` (`deployer/src/verify.ts`) has no unit test; it runs only off the demo networks.
- `Fr.random(` in production code: `showcase/src/live/actions.ts:332`, `deployer/src/deploy-l2.ts:68`, `deployer/src/local-actors.ts:11,26`. The rest are tests.
- Open issues touching these files: only the nine.
