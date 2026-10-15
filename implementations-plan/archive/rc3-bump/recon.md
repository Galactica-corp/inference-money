# Recon: Aztec 6.0.0-rc.1 → 6.0.0-rc.3

Base: `dev` at `606fdb5`. One batched reuse sweep (Sonnet, read-only) plus direct reads: npm metadata, the upstream tags
(aztec-nr, aztec-standards, aztec-packages `protocol_types`, l1-artifacts), rc.3's installer `versions` file, and a
keyless `probe:testnet`.

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| One source of truth for versions | `toolchain.json`; readers: `contracts/aztec/scripts/toolchain.sh:6-7` (noir, nargo), `packages/local-network/scripts/install-node.sh:12-13` and `src/network.ts:38` (aztecNode, aztecNodeFoundry), `setup-toolchains/action.yml:35-41` (nargo, foundry, bun, …). `aztecJs` has no reader. | adapt (values only) |
| nargo / Foundry digests | `setup-toolchains/nargo-1.0.0-rc.3.sha256`, `local-network/toolchain/foundry-1.4.1.sha256` | reuse-as-is: rc.3's installer pins the same nargo 1.0.0-rc.3, Foundry 1.4.1, node 24.12.0; only their header comments name rc.1 |
| npm pins + lockfiles | 8 `package.json` files with `@aztec-labs/*` / `@aztec-foundation/*` exact pins; root `bun.lock`; `contracts/aztec/toolchain` and `packages/local-network/toolchain` frozen locks (own `bunfig.toml`, 7-day gate) | adapt |
| Release-age gate | `bunfig.toml` `minimumReleaseAge`; lessons.md: exact names only, gate applies at resolution only, never commit an exclude | reuse the lessons procedure |
| Noir git deps | 7 `Nargo.toml` files; `noir-deps.sh` DEPS table (re-derive from a clean-cache `nargo check`, header :14-15) | adapt |
| Artifacts | `compile.sh` (+ `--check` = class id + ABI vs HEAD, `artifact-identity.ts`) | reuse-as-is (commit the rebuild, then check) |
| ABI superset | `contracts/aztec/scripts/abi-superset.test.ts` reads `@aztec-foundation/aztec-standards`'s Token artifact | reuse-as-is after the package bump |
| Class-id / address pins | `bridge-core/src/artifacts.test.ts:9-20` (3 class ids + SponsoredFPC class and address), `bridge-core/src/claim.test.ts:39`, `deployer/src/networks.ts:43` (sponsor), `integration/test/discovery.test.ts:15-17` (handshake registry) | adapt by hand: no generator exists |
| TS mirror of aztec's time horizon | `bridge-core/src/merchants.ts:148-152` `timeHorizon`; its literal offsets in `merchants.test.ts:52-75` and the token's TXE suite | adapt (port the upstream rule) |
| Separator registry | `keystone/src/main.nr:190-275` lists every known separator | adapt (V2 → V3 rename, add aztec-nr's new note-randomness separator) |
| Testnet pins | `deployer/src/networks.ts:25-46`; `probeNetwork` (`deployer/src/preflight.ts`) | adapt from keyless reads |
| Real-proof build guard | `apps/showcase/build/target.ts` (`proofsFor`), `build/target.test.ts` | build new (≈12 lines, owner-directed) |
| Local network on rc.3 | `install-node.sh <dir>` + `AZTEC_NODE_HOME`; `RUN_ID` isolation | reuse-as-is |
| Run integration / e2e | `test:integration`, `test:e2e` | reuse-as-is |

Absence trails (sweep): `grep -rIn "toolchain.json|aztecJs|aztecNodeFoundry"`; `0x` + 64 hex across the tree minus
`node_modules`, `target`, `bun.lock`; `--record|writeFileSync|regenerat|UPDATE_|--update` for generators; `ContractDeployment|deploy_with_public_initializer|create_contract_instance` in `.nr`; `aztec::facts|OriginBlock|Writer|advance_offset|Serialize for Option|ecdsa|contract_instance_registry|fee_juice` in `.nr`; `getBlockHashMembershipWitness` in TS. No CI job reads the live testnet (`grep probe|bridge verify|test:testnet|nodeUrl` over `.github`, `docs/ci-pipeline.md`).

## Upstream facts (verified 2026-10-13)

- **npm.** `@aztec-labs/*@6.0.0-rc.3` (published 2026-10-08T12:17Z) pins `@aztec-foundation/{bb.js,l1-artifacts,noir-*,cdb,ipc-runtime,bb-avm-sim}@6.0.0-rc.6` (published 2026-10-08T11:4xZ) and `viem` as `npm:@aztec/viem@2.38.3`. `@aztec-foundation/aztec-standards@6.0.0-rc.3` was published 2026-10-13T19:04Z (SLSA v1 provenance, no install scripts, 59 files). Age gate clears: rc.6 foundation ≈2026-10-15T11:43Z, `@aztec-labs` 2026-10-15T12:17Z, aztec-standards 2026-10-20T19:04Z.
- **Presto.** `@alejoamiras/presto@6.0.0-rc.1.1` (npm `testnet` tag, newest) pins `@aztec-labs/{stdlib,bb-prover,foundation}@6.0.0-rc.1`; no rc.3 build, no branch. presto-server newest is `1.2.0-rc.1` (2026-10-02). The showcase proves every real-proof route through `PrestoProver` (`apps/showcase/src/presto/prover.ts`); fake-proof builds never import it (`src/presto/index.ts:1`).
- **Tags.** aztec-nr `v6.0.0-rc.3` = tag object `200f5fcc…`, commit `694af4de4b196733819811c896867d5a9572a1b5`; its `aztec/Nargo.toml` pins aztec-packages `v6.0.0-rc.6` (commit `0df91ba1799012435c62c6108a0926b357fef88c`) for `protocol_types`. aztec-standards `v6.0.0-rc.3` = commit `f7bf63d5041a8f0a082ac905e452befebbc10a21` (2026-10-13T18:53Z, "bump Aztec to 6.0.0-rc.3"), pinning aztec-nr `v6.0.0-rc.3`, so the token and the bridge still share one `aztec`.
- **Installer.** `install.aztec-labs.com/6.0.0-rc.3/versions`: `noir: 1.0.0-rc.3`, `foundry: 1.4.1`, `node: 24.12.0`, identical to rc.1's.
- **aztec-nr rc.1→rc.3** (crates used: `aztec`, `uint-note`, `balance-set`, `compressed-string`; only `aztec` changed):
  - `oracle/version.nr`: oracle interface 31.0 → 32.2; TXE oracle 9 → 10. Contracts must be recompiled.
  - `standard_addresses.nr`: all four standard contract addresses change (handshake registry `0x1d6cc365…a0c4` → `0x198aa5f21f7a13761f4729c544fb6edcae73a484d57b248b6390eb0dc5c06040`).
  - `note/lifecycle.nr`: note randomness = `poseidon2([random, note_hash_counter], DOM_SEP__NOTE_RANDOMNESS = 2943528854)`.
  - `oracle/nullifiers.nr`: `check_nullifier_exists` now calls `get_nullifier_statuses` (oracle `aztec_utl_getNullifierStatuses`); same signature.
  - TXE: `DeployOptions.with_immutables_hash`, `ContractDeployment.immutables_hash` (defaults to 0 through `env.deploy`).
  - `facts`: `OriginBlock` → `oracle::block_reference::BlockReference` (no `FactScope` yet). `WithHash` constrains the packed hint; `PublicImmutable` drops its `Eq` bound. New `try_get_l1_to_l2_membership_witness`, `get_settled_note_origin`, `compute_tx_nullifier`.
  - Not in rc.3 despite the release notes: `FactScope`, the ECDSA-note and protocol-interface crates, the `Writer::advance_offset` removal.
- **protocol_types rc.1 → rc.6** (6 files): `DOM_SEP__CONTRACT_ADDRESS_V2 (4099338721)` → `DOM_SEP__CONTRACT_ADDRESS_V3 (993442748)`; genesis roots; `poseidon2_hash_bytes` docs; **`ScheduledValueChange::get_time_horizon` now treats `pre == post` like a passed change** (`anchor + minimum_delay`).
- **aztec-standards rc.1→rc.3 Token**: one behaviour change, `transfer_private_to_public_with_commitment` initializes the commitment for `from` (a refund commitment), not `to`; doc comments; `generic_proxy` gains `forward_public_4`; upstream's test `…_refunds_from` replaces `…_and_finalize`. ABI (names, params, attributes) unchanged.
- **l1-artifacts rc.1→rc.6**: of the portal's imports only `IRollup.sol` (reward functions) and `ConstantsGen.sol` (`GENESIS_ARCHIVE_ROOT`) change; the portal uses neither, so its bytecode should not move.
- **aztec-node rc.1→rc.3** (121 commits): v3 address separator and re-pinned standard contracts, PXE storage snapshots for v3, `immutables_hash` in TXE, exact-archive block-hash witnesses, next-block fee admission, teardown gas in kernelless simulation.

## Repo facts the design rests on

- Fork side proof: `_prove_merchant_side(owner, opener, keep_first)`; FIRST → `stamp(c, hour)`, else `pad(c)` (`token/src/main.nr:1140-1215`). `transfer_private_to_public_with_commitment` calls it as `(to, from, true)` and initializes for `to` (:264-276). No TS caller (bridge-core, showcase).
- The token hint calls upstream `get_time_horizon` directly (`token/src/hints.nr:169`), so Noir follows rc.3 by itself; the TS mirror does not.
- `keystone/src/main.nr:235` names `protocol::DOM_SEP__CONTRACT_ADDRESS_V2`, which rc.6 removed: keystone stops compiling until renamed.
- TXE floors: token 181, token_bridge 85, keystone 20 (`run-txe-tests.sh:22-25`).
- The showcase's testnet build always proves for real (`build/target.ts` `proofsFor`); `showcase.yml:69` runs `build:testnet`; Workers Builds runs it for production and every preview (`apps/showcase/wrangler.jsonc`).
- `instanceFromRecord` throws when a manifest record does not re-derive from the committed artifact (`bridge-core/src/instances.ts:35`); the page runs `assertNetworkIdentity` first (`src/demo/start.ts:18`).
- `deployments/local/` is untracked; the e2e fixture tour (`apps/showcase/e2e/fixtures/tour.json`) names no live contract.

## Live testnet (keyless `bun run probe:testnet`, 2026-10-13T20:3xZ)

The node reports `6.0.0-rc.3`, rollup version `3409706519` (pinned `2914217885`), Inbox `0xb3b95295823ad313edc9e498eff7b672b3c6b209`, Outbox `0x25519d3c79e39143accf358ba07d200b534fa400`, fee-juice portal `0x6974bde62c47a0041f5b4a2e61c5506c2b59ce59`. Registry, USDC, Permit2 and the fee asset handler match the pins. No SponsoredFPC instance at the rc.1 canonical address. So `deployments/testnet.json` describes a deployment on a superseded rollup, and the served page's live mode refuses at `assertNetworkIdentity` (inferred from the code path, not observed).

## Open work touched

- #49 (redeploy records creation txs and the merchant delay): closes with the keyed redeploy after this PR; this PR comments the redeploy order on it.
- `implementations-plan/follow-ups.md` exists although issues are enabled; migrating it is outside this bump (parallel batches edit the plan folder) and stays the owner's call.
