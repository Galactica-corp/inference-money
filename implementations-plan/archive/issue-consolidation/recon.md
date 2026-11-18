# Recon: issue-consolidation

Base: `origin/dev` at 6f7f1a1. Read by the driver directly (no explorer agents: every target is a named line).

## Reuse map

| Need | Found | Verdict |
|---|---|---|
| A secret-drawing helper to name for the authwit nonce (#55) | `randomSecret()` in `packages/bridge-core/src/random.ts`, already used by `exitToL1` (`exit.ts:204`) | reuse-as-is (name it in the docs) |
| A command that shows the guardian in office (#85, Emergency step 4) | `verify <manifest> --guardian <address>` (`verify.ts:228-236`: passes only when current and scheduled equal the named one); `merchants list` prints no guardian | reuse-as-is |
| A test name for A28's disposable cell (#85) | `disposable.test.ts:192` "destroy removes the keys only on finalized proof that the manifest's admin, not a disposable one, holds both roles alone" | reuse-as-is |
| The scrubbed environment for a spawning Worker (#80) | `scrubbedEnv()` (`packages/deployer/src/secrets.ts:58`) | reuse-as-is |
| A payment-refusal vocabulary (#85) | `PaymentRefusal` (`payments.ts:93`): `paid`, `in-flight`, `completed-on-chain`, `stale`, `replaced` | reuse-as-is |
| A delay validator to warn from (#64) | `parseDelay` (`packages/deployer/src/cli-args.ts:109`), its test in `cli-args.test.ts:47`; callers `commands.ts:56` (deploy) and `:110` (`merchants delay`) | adapt (warning on stderr) |
| A Presto-connected hint and its test (#67) | `readyHint` (`apps/showcase/src/live/LiveMode.tsx:110`); `LiveMode.test.tsx`; vitest sets `__SHOWCASE_PROOFS__ = "fake"`, so `PROVES` is false in tests; `consent.test.tsx:11` has a `PrestoStatus` fixture | adapt |
| The standard expiry constant (#64) | `STANDARD_TX_LIFETIME = 82800` (`contracts/aztec/token/src/hints.nr`); no TS export of 82 800 in deployer | build new (one local constant) |

## Facts that moved since the issues were filed

- `docs/integration.md` lines shifted by about two: "Visible" is line 121, the refusal sentence line 71, the OZ signature bullet line 96, the secret-hash sentence line 89.
- `TokenPortal.sol` "254 bits" comments are at lines 161 and 189-190; "so it always reverts" at 351. The Inbox (`l1-artifacts` `Inbox.sol:95`) refuses a secret hash above `Constants.MAX_FIELD_VALUE`.
- `docs/assurance-map.md` A24 (line 32) already says "zero and the portal"; A5 (line 13) still says "anywhere but the portal". `docs/architecture.md:5` still says "except the portal's".
- `docs/integration.md` has no x402 section: the only x402 mention is line 3.
- No open PR touches these files.

## Collision risks

- `apps/showcase/e2e/specs/presto.spec.ts:74,85` asserts substrings of `readyHint` ("proven in this browser.", "proven by Presto when it can, else in this browser."): the #67 sentence must be appended, never reword these.
- `bytecode_hash = "none"`: Solidity comment edits leave the deployed bytecode unchanged, so `verify` against `deployments/testnet.json` keeps passing; check with the pinned forge (`~/.cache/inference-money/foundry-1.7.1`), since the PATH forge is 1.4.1.
