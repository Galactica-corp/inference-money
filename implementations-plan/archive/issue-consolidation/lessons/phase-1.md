# Phase 1: docs, comments and the two text changes

- `TokenPortal.sol` comment edits: deployed bytecode identical before and after with the pinned forge 1.7.1 (`forge inspect TokenPortal deployedBytecode`, sha256 `7336b21c…88d4` both times); `forge fmt --check` passes. The forge on PATH here is 1.4.1, so the check names the pinned binary.
- #67 test: `PROVES` is a module-level build constant (`__SHOWCASE_PROOFS__ = "fake"` under vitest). A hoisted flag behind a `get PROVES()` in `vi.mock("@/config/network")` flips it for one test; vitest rewrites named imports to property reads, so `readyHint` reads the getter at call time, while `PrestoRibbon`, chosen at module load, stays off. The test passing on the Presto sentence proves the getter took effect (with `PROVES` false the hint reads "with proofs off").
- #65: dropped the issue's side remark about the commitment unshield's public recipient: a direct caller never learns that commitment (`docs/integration.md`, the `transfer_private_to_public_with_commitment` paragraph), and the issue's Possible fix names only the payer clause and the confidentiality line.
- Gate: `bun run lint` 0, `bun run typecheck` 0, `bun run test` 0 (bridge-core 203, deployer 91, showcase 100 + 5 skipped, local-network 16, demo 15, contracts 4 + 6).

## Codex fix loop (gpt-6.1-sol, high; session 01a1406c-b34c-7fb0-bdec-c4d3d8255e3e)

- Round 1: 2 material, both verified and fixed. A Permit2 blocklist is not cured by a redeploy: every deployment uses the canonical Permit2 (`networks.ts:38`, `testnet.ts:105`), so only Circle's relisting restores routed deposits. A return's withdraw content is depositor, amount and a zero caller, so equal deposits share it: the docs now say it names depositor and amount, not "the exact deposit".
- Round 2 (resumed): clean. Both fixes verified, no regression. Loop converged.
