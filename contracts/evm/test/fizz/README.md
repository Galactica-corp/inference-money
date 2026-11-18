# Fizz Suite

## What Is Here

- `Base.sol`: shared setup, deployed contract references, actors, helpers, and ghost state
- `Snapshots.sol`: before/after state capture used by properties
- `Properties.sol`: global and function-specific invariants
- `handlers/`: protocol actions exposed to the fuzzers
- `harness/`: (optional) harness contracts that inherit from target contracts to expose private/internal state needed by properties
- `utils/`: shared helper libraries, assertions, clamping logic, math helpers, deploy helpers, logging, and mocks
- `FuzzTester.sol`: the Medusa entry point
- `FoundryTester.sol`: Foundry harness for quick debugging and local repros

## Inheritance Chain

```
Base (is StringUtils, Clamp, Deployer, Math)
        └─► Snapshots (is Base)
              └─► Properties (is PropertiesAsserts, Snapshots)
                    └─► <Contract>Handler (is Properties)   — one per target contract
                          └─► Handlers (is <all handlers>)  — aggregator + actor switching
                                ├─► FuzzTester (is Handlers)       — Medusa entry point
                                └─► FoundryTester (is Test, Handlers) — Foundry quick debug/PoC entry point
```

## Related Paths Outside This Directory

- `../../fizz_data/`: Medusa's corpora, logs and coverage outputs (ignored). The nightly (`fuzz-contracts.yml`) uploads
  each run's coverage report as `medusa-coverage-<ref>`; the suite's original generation notes are in git history
- `../../medusa.json`: Medusa config
- `../../PROPERTIES.md`: every property, with its guarantee and source

## How To Run

From the repo root:

```bash
bun run test:evm:fuzz [-- <seconds>]   # Medusa, default 3600 s; nightly in CI (fuzz-contracts.yml)
forge test --root contracts/evm --match-contract FoundryTester
```

`test:evm:fuzz` sets `FOUNDRY_PROFILE=fuzz` for Medusa alone: that profile restores a metadata hash
(`bytecode_hash = "ipfs"`), without which Medusa attributes no coverage to any contract with immutables, and builds
into `out-fuzz/`, away from the default profile's `out/`.

## This Suite's Model

- Real `TokenPortal` and `Permit2DepositRouter`, deployed and initialized in the project's own order
  (`test/mocks/RouterFixture.sol`); Aztec's real `Outbox` behind the project's `FakeRollup` (`mocks/RealOutboxStack.sol`);
  the project's `CapturingInbox` and `FakeRegistry`.
- The real Permit2: its runtime deployed byte for byte at a fresh address (`test/mocks/Permit2Runtime.sol`, rendered
  from the deployer's keccak-pinned copy by `scripts/permit2-runtime.ts`); Medusa mis-executes etched code. Router legs sign the digest the harness derives from
  Permit2's spec (`Base._specPermitDigest`), each with a nonce its signer has not spent (`_freshNonce`).
- `mocks/ModalUsdc.sol`: the project's `MockUsdc` plus switchable fee-on-transfer, sender surcharge, blacklist and one
  re-entrant transfer hook.
- `handlers/AztecL2Handler.sol`: the Aztec side reduced to accounting (claim, return, exit, epoch proofs into the real
  Outbox), plus environment actions (donations, token modes, re-entry, an exit naming the portal itself).
- Hostile handlers record successes in `ghosts.*` counters that properties require to stay zero.

## How To Read The Suite

Recommended order:

1. `README.md`
2. `Base.sol`
3. `handlers/Handlers.sol`
4. individual handler files under `handlers/`
5. `Snapshots.sol`
6. `Properties.sol`
7. `harness/` (if present) — to understand what private/internal state is exposed and why
8. `utils/` when you need to understand helper behavior or mocks
9. `FuzzTester.sol`
10. `FoundryTester.sol`
