# Phase 2 — self-deliveries in the token

## TXE cannot observe handshakes

A throwaway TXE test called the handshake registry's `get_non_interactive_handshakes(recipient, 0)` after a constrained delivery to that recipient and read 0. TXE does not record the registry's handshake, so no TXE test can tell a constrained delivery from an unconstrained one. Every delivery assertion lives in `packages/integration/test/discovery.test.ts`, against a real node, which answers `getPrivateLogsByTags` under the recipient's handshake tag.

## Gates (`aztec profile gates`, before → after)

| Function | Before | After |
|---|---:|---:|
| `burn_private` | 36,703 | 15,481 |
| `mint_to_private` | 27,692 | 7,887 |
| `transfer_private_to_commitment` | 44,846 | 22,595 |
| `transfer_private_to_private` | 66,116 | 48,157 |
| `transfer_private_to_public` | 41,646 | 19,776 |
| `transfer_private_to_public_with_commitment` | 46,684 | 24,842 |
| `transfer_public_to_private` | 35,581 | 35,791 |

The other four private functions are unchanged. A constrained delivery costs about 20k gates; `transfer_public_to_private` keeps both branches (its predicate is a runtime value), hence +210.

## Delivery mode is fixed per call site

`deliver` takes the delivery builder by type, so a runtime choice is two calls in an `if`/`else`, each compiled; one builder value cannot be picked at runtime.

## Gate evidence

- `bun run test:noir`: token 185 passed (manifest 184 names), token_bridge 85, keystone 20.
- `compile.sh --check` compares the rebuild with the HEAD-committed artifact, so it fails until the rebuilt artifact is committed; run it after the commit. Running it beside `typecheck` or `bun run test` races its rewrite of `target/` (a missing artifact module).
- `bun run test`: green except the deployer CLI `.env` test, which timed out at 5 s under host load and passes 3/3 with `--timeout 60000`.
