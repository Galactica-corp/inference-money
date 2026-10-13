# Phase 3 — TypeScript lane

Branch `worktree-rc3-ts`, merged with `git merge --no-ff` (8cdd408).

## Assumptions settled

- I4: the rc.3 SponsoredFPC is published on rollup 3409706519 (`probe:testnet`: instance found, Fee Juice funded).
  Address `0x2adfb70e…2130`, class `0x0d6670f2…2437` (salt 0). No external blocker.
- I5: one API break, local to the showcase's prover hand-off (below). No design change.
- I6: Presto's prover reaches the rc.3 PXE through one `as unknown as` cast in `apps/showcase/src/demo/wallet.ts`
  (branded `AztecAddress` across two stdlib copies). Nothing guarantees the two stdlibs agree at runtime; it stays
  contained because a real-proof build on an rc.3 node is refused and a fake-proof build never loads Presto. Removed
  with the Presto bump.
- I7: no drift in the SDK behaviour the repo copies.
  - PXE tx expiry: `@aztec-labs/pxe` `dest/private_kernel/hints/compute_tx_expiration_timestamp.js` is byte-identical
    rc.1 → rc.3, and its inputs (`MAX_TX_LIFETIME = 86400`, `DEFAULT_UPDATE_DELAY = 86400`,
    `MINIMUM_UPDATE_DELAY = 600`) are unchanged, so `committedExpiry` and `STANDARD_TX_LIFETIME = 82_800n` stand.
  - Error texts: `Existing nullifier` and `Duplicate nullifier in tx` (`@aztec-labs/stdlib`
    `dest/tx/validator/error_texts.js`) and `Invalid tx: ` (`@aztec-labs/aztec-node` `dest/aztec-node/server.js`) are
    identical in both. The node is not in the npm closure, so a grep of `node_modules` alone misses it.
    `Balance too low` is the fork's own assert.

## Changes

- Identities: the demo cast's Schnorr account (`packages/demo/src/cast.test.ts`), the handshake registry address, the
  SponsoredFPC address and class; the Token class id moved again with Phase 2's artifact (refreshed after the merge).
- `prestoPins(repoRoot)` (`apps/showcase/build/target.ts`) returns `{ aztecNode, aztecJs, prestoStdlib }` and throws on
  a missing file, invalid JSON or any value that is not an exact version, so callers fail closed. The real-proof build
  guard and CI's Presto compat step both use it.
- `probe:testnet` reads `registry → rollup → fee juice portal` (`getFeeAssetPortal()`) on L1 and compares it with the
  node's: 19/19 on the live testnet.
- `@alejoamiras/presto` stays at `6.0.0-rc.1`.

## Lessons

- The SponsoredFPC address has no literal in the rc.3 SDK (`@aztec-labs/constants` exports only `SPONSORED_FPC_SALT`):
  derive it with `getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, { salt: Fr.ZERO })`; the
  live probe's "SponsoredFPC published" is the independent check.
- After the switch back on, `merchantStatus` returns `pending: false` and the horizon reads as a settled entry's
  (`[A20]`), since rc.6's `get_time_horizon` treats an unchanged value as no change.
