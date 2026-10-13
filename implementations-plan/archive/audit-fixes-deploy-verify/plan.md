---
plan: audit-fixes-deploy-verify
tier: mid
status: completed 2026-10-13 (PR #48)
base: ad77d10 (origin/dev)
trunk: dev
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: file
budget: recon 1 agent; code-review off; Codex gpt-6.1-sol at high
---

## Outcome

- **Closed** 2026-10-13: completed, delivered in PR #48 (squash into `dev`).
- **Shipped**:
  - *Creation binding.* `deployEvm` signs each create in process, at the address the key and its pending nonce determine, for the configured chain only. The manifest records `l1.portalTx` and `l1.routerTx`, and `verify` checks each creation tx against the fresh build. Bridge builds pin the default Forge profile.
  - *Delay policy.* The manifest records `l2.merchantDelay`. `verify` reads the setting, the guardian slot and every entry at one block and fails on a change in flight unless `--allow-pending` accepts it. `merchants delay` records the delay from a read-back of the chain.
  - *Withdraw-only mode*, built on `worktree-audit-fixes-dv-rollup` and merged (`lessons/phase-3.md`). The identity gate pins the portal's stored registry, inbox, outbox and version and reports `depositsOpen`. `verify` and `smoke` warn. The page shows a notice, refuses deposits and re-checks before signing; an e2e spec covers it.
- **Dispositions**:
  - Two items of the original batch (keyed-run plumbing) moved to a separate batch before planning; nothing of theirs is here.
  - A real registry switch in integration: rejected (ledger row 8). The page's behaviour is covered by the unit, component and e2e tests, the L1 behaviour by the portal's forge test.
  - The Codex fix loop converged in three rounds (`lessons/phase-5.md`). Every finding was adopted.
- **Open items**: #49 (the testnet manifest predates the new pins; the Sepolia signing path first runs at its redeploy). #40, unrelated, stays open.
- This plan's `/goal` and `/loop` seeds are retired; it is a record, not a task list.

# Deploy binds what it signed; verify tells the truth; the page survives a rollup switch

Three changes in the deployer, bridge-core and the showcase. The owner decided each design; the director's panel settled the delay policy.

- **Creation binding**: the deploy binds each L1 contract to the address its own key and nonce determine, and to the tx it signed itself. `verify` proves each contract was created by this commit's init code, sent by the deployer.
- **Rollup switch**: the identity check reads the rollup the portal is bound to, so the page, `verify` and `smoke` keep working after Aztec makes another rollup canonical. The page then refuses only deposits, with a notice.
- **Delay policy**: `verify` pins the merchant-delay setting to the manifest and fails while a merchant entry has a delay or switch change pending, unless the operator allows it. The token-side change ships separately; nothing here depends on it.

## Outcome & Quality Bar

**For whom.**
1. The operator who deploys and later runs `bridge verify`, often from the commit that made the deployment, through their own endpoints.
2. A showcase visitor during the exit window after Aztec makes a new rollup canonical.

**What excellent looks like.**
1. `verify` gives one clear verdict per check. An absent optional manifest field warns and never fails. A present field that is wrong fails, and the detail names what differs.
2. A deploy refuses, before anything binds to the address, an RPC answer that names another tx hash or another contract address than the ones it computed itself.
3. After a rollup switch, the page opens, shows a notice that deposits are closed and why, and still claims, pays, sends, exits and pays out. Only the deposit action is refused, and it is refused before any Ethereum transaction is signed.
4. `verify` attests the merchant-delay policy: the setting equals the manifest's, every entry is scheduled to it, and an entry's pending delay or switch change fails unless the operator passes `--allow-pending`.

**Good enough.** No inspection of the live testnet portal (it redeploys later on a newer toolchain). No escape-hatch or attester-count warnings. No contract change.

## Architecture & Implementation

### Creation binding

- **`packages/deployer/src/l1.ts` `deployEvm`**:
  1. Read the account's `pending` nonce. Derive `address = getContractAddress({ from, nonce })`.
  2. Build the creation request with that nonce (`prepareTransactionRequest`, `data = encodeDeployData(...)`, no `to`), sign it locally (`walletClient.signTransaction`; both networks use local accounts), and compute `hash = keccak256(signed)`.
  3. Broadcast with `sendRawTransaction` and refuse an answer other than `hash`.
  4. Wait for the receipt of `hash`. `mined()` refuses any receipt whose `transactionHash` differs from the hash it waited on (viem resolves a replaced tx with the replacement's receipt); this also covers `writeEvm` (`initialize`). `deployEvm` then refuses `contractAddress != address`.
  5. Return `{ address, block, tx: hash }`.
  The address is a function of the key and nonce alone, so the router, the L2 bridge and `initialize` bind only to a contract this key creates at that nonce. The hash is computed locally, so the broadcast answer cannot substitute another tx. A receipt is still the endpoint's word: the deploy keeps trusting the endpoint for inclusion, and the later `verify` through independent endpoints is what proves it.
- **`deploy.ts` `deployBridge`**: records `l1.portalTx` and `l1.routerTx`.
- **`bridge-core/src/manifest.ts`**: `l1.portalTx` and `l1.routerTx` optional 32-byte hashes (the `field` validator). Old manifests stay readable by the new CLI. A CLI older than this change cannot parse a manifest that carries them; a manifest is always read by the CLI of its `sourceCommit` or newer.
- **`verify.ts`**: a `createdAsBuilt` check per contract. It fetches the tx and its receipt and requires `to == null`, `from == m.l1.deployer`, `input == encodeDeployData({ abi, bytecode, args })` from the fresh build (`args`: none for the portal; `[permit2, portal, usdc]` from the manifest for the router), `status == success` and `contractAddress == the manifest's address`. For the router it also pins `m.l1.deployBlock` to the receipt's block (today that field is unchecked). A missing field warns: "the manifest records no creation tx: the constructor that ran is unverified". A tx the endpoint cannot find fails, and the detail points to `--l1-rpc` (an endpoint that serves old txs). The pure part, `creationCheck(label, tx, receipt, want)`, is exported for unit tests.
- **`verify-cli.ts`**: the closing summary names each warning, so a pass with an unverified constructor says so in its last line.
- **Reproducible init code**: `buildBridgeContracts` (`evm.ts`) drops every inherited `FOUNDRY_*` and `DAPP_*` variable and sets `FOUNDRY_PROFILE=default` for its `forge build`, so the deploy and every later verify compile with `foundry.toml`'s default profile (pinned solc, optimizer settings, `bytecode_hash = "none"`) and the npm-pinned Solidity dependencies. The env builder is a pure helper with a unit test (an ambient `FOUNDRY_PROFILE=fuzz` and a `FOUNDRY_OPTIMIZER_RUNS` are both overridden). Run from the deployment's `sourceCommit`, the fresh build's creation code equals the deployed one's.

### Delay policy

- **Manifest**: `l2.merchantDelay`, an optional zod number, an integer in [3600, 86400] (literal bounds: `manifest.ts` is a leaf module the showcase build config loads under Node).
- **Deploy** (`deploy.ts`, `local.ts`, `deployTestnet` in `testnet.ts`; the director approved the `deployTestnet` edit):
  - `DeployContext.merchantDelay?: bigint`. `deployBridge` sends `set_merchant_delay` once, after `initialize`, when the value differs from the token's 86 400 s default. It pays with `c.fees.tx` when set, as its `ensureStandardContracts` call does.
  - It records `l2.merchantDelay = Number(merchantDelay ?? 86400n)`. The token constructor writes 86 400 (`main.nr:1083`), so recording the default without a tx is exact.
  - `local.ts` and `deployTestnet` delete their own `set_merchant_delay` (a second set would restart the guardian slot's decrease) and pass the option through. Their verify passes no flag.
- **Verify** (`verify.ts`): `verifyDeployment(m, evm, l1, node, handover, opts)`. The old sixth parameter `guardian` moves into `opts: { guardian?, allowPending? }`; `local.ts`, `testnet.ts`, `verify-cli.ts` and the integration helper update.
  - **One block.** The setting, the guardian slot and every entry are read at the merchant list's block. Today the setting alone is read at `latest`.
  - **Setting.** Absent `merchantDelay`: one warning ("unpinned"), and nothing is inferred from the chain. Present: the setting must equal it, with or without the flag.
  - **Scheduled values.** Each entry and the guardian slot must be scheduled to the setting, with or without the flag.
  - **Guardian slot.** A pending change to its delay never fails and needs no flag. It prints as an `ok` line with the value now, the value scheduled and the change time. The slot is read only in public functions (`main.nr:782`, `:840`), so its delay never caps a tx's expiry, and only the constructor and `set_merchant_delay` schedule it, always to the setting.
  - **Entry delay change.** One with `changeAt > at` and `current != scheduled` fails. With `allowPending`, one whose target equals `m.l2.merchantDelay` warns instead and prints its change time; any other target still fails.
  - **Entry switch change.** An entry with `changeAt > at` fails (`merchantStatus().pending`), including one whose scheduled value equals its current one: a cancel or a switch back on leaves it marked until then. With `allowPending` each warns, with its time and whether it switches or is only marked.
  - The verdict logic is a pure exported function (`delayPolicyChecks`) over the setting, the guardian slot's `DelayState` and the `MerchantList`, whose entries already carry each delay and its change time (the per-entry `entryDelay` reads go). A small per-change helper keeps it within cognitive complexity 15. Unit-tested without a node.
- **CLI**: `verify … [--allow-pending]` (`cli-args.ts` `SWITCHES`, `commands.ts`, `verify-cli.ts`). `merchants list` already prints both kinds of pending change; unchanged.
- **`merchants delay`** (`commands.ts`, `admin.ts`): a thrown send does not prove a tx failed (its response can be lost after it lands), so the command decides from the chain, not from the send.
  1. It sends the set and the syncs as today, and catches a failure.
  2. Success or failure, it reads the setting and the merchant list at one block.
  3. If the setting equals the requested delay, it rewrites `merchantDelay` in the manifest file it was given, as `admin accept` records `l2.admin`. Otherwise it prints the setting it read next to the request and leaves the manifest alone.
  4. It names every entry not scheduled to the requested delay. It exits 1 if the send failed, the setting differs from the request (a stale read counts) or any entry is unsynced, and says to rerun.
  The decision is a pure function over the read-back, unit-tested. `sendChunked` and `addMerchants` are unchanged. A process killed mid-run leaves the manifest stale; `verify` then fails the setting pin, and a rerun rewrites it. The docs say to commit the rewritten manifest.

### Rollup switch: withdraw-only mode

- **`bridge-core/src/abi.ts`**: `view("rollup", "address")` in `TOKEN_PORTAL_ABI` (the portal's `IRollup public rollup`; `abi.test.ts` pins it against the forge build).
- **`bridge-core/src/network.ts`**:
  - `assertNetworkIdentity(node, l1, m): Promise<{ depositsOpen: boolean }>`. It pins the portal's stored `registry`, `inbox`, `outbox` and `rollupVersion` (getters already in `TOKEN_PORTAL_ABI`) to the manifest, in place of the canonical rollup's answers. The portal took all four from the registry's canonical rollup at `initialize`, so the pins keep the link to the manifest's registry without trusting the bound rollup's own answers. Every node and chain check stays. It still throws on any mismatch.
  - A new `depositsOpen(l1, m)` compares `registry.getCanonicalRollup()` with `portal.rollup()`, the contract's own deposit test (`TokenPortal.sol:343-345`). `assertNetworkIdentity` uses it for its result.
  - A node that followed the new rollup reports another version and outbox, so the check still fails there. Withdraw-only mode needs a node on the old rollup (documented).
- **`verify.ts`**: the identity check passes; when deposits are closed it adds one warning: "the registry's canonical rollup moved: deposits revert (RollupNotCanonical); exits pay while the bound rollup proves".
- **`smoke.ts`**: logs the same warning and continues. A fresh smoke run then exits 1 at its first step, the deposit, which the portal refuses; a run whose journal is past its deposit continues. The acceptance run needs deposits, so it cannot pass in withdraw-only mode. The docs say so.
- **Showcase**:
  - `demo/wallet.ts`: `DemoWalletOptions.depositsOpen` and `DemoWallet.depositsOpen`, documented as the state when the page opened.
  - `demo/start.ts`: passes the gate's `depositsOpen`.
  - `live/LiveRoot.tsx`: the ready status carries `depositsOpen`.
  - `live/LiveMode.tsx`: when closed, a notice in the `Layout` notice slot (`TESTIDS.depositsClosed`, `role="status"`), and the Try it button is disabled while the draft's action is a deposit. The slot already holds the Presto ribbon, so a small `Notices` component renders both, and a `depositBlocked(draft, wallet)` helper keeps `LiveMode` within its line and complexity budgets.
  - `live/actions.ts`: `deposit()` calls `depositsOpen(l1, m)` before any balance read or signature (a page opened before the switch learns of it here) and returns `failed` with the notice sentence when closed. A short guard, because the `claims` batch edits this file too. A switch that lands while a deposit is already binding, approving or sending is not caught by the page; the portal refuses the deposit itself, and a Permit2 approval made before it stays (it names Permit2, not the portal).
  - Notice copy: "Deposits are closed. Aztec has moved to a new rollup, and this bridge stays on the one it was deployed on. Claims, payments, transfers and withdrawals still work while that rollup runs."
- **Docs**:
  - `operations.md`: a "Rollup upgrade" subsection with the owner's story. Open an exit window before the switch, redeploy on the new rollup, and keep a node on the old rollup running until the last payout. On mainnet Galactica runs it. A hosted node follows the new rollup, so the showcase keeps serving exits only once `l2.nodeUrl` names the old-rollup node and the bundle is rebuilt (one network per bundle). Also what `verify` and `smoke` do after a switch.
  - `architecture.md:32`: balances and unproven exits strand too, and exits pay only while the bound rollup proves.
  - `integration.md:56`: `assertNetworkIdentity` returns `depositsOpen`, and the condition on "withdrawals still pay".
  - `follow-ups.md`: O-11's line points at the decided story.

### Data and control flow (critical paths)

1. **Deploy.**
   1. Nonce → derived address → locally signed create → broadcast answer equals the local hash → receipt for that hash with the derived address.
   2. The router binds the derived portal, then the L2 bridge binds it, then `initialize`.
   3. `set_merchant_delay` if not the default.
   4. Manifest with `portalTx`, `routerTx`, `merchantDelay` → in-pipeline verify (no flag) → write.
2. **Verify.** Identity (the portal's stored registry, inbox, outbox and version; canonical vs bound only for the warning) → L1 code and getters → creation txs → L2 → roles → delay policy (one block) → backing → demo cast → environment.
3. **Page.**
   1. `startDemo` → the gate returns `depositsOpen` → the wallet opens with it → LiveMode shows the notice and blocks deposit drafts.
   2. A deposit re-reads the state before it signs anything.

### File-level change map

| File | Change |
|---|---|
| `packages/deployer/src/l1.ts` | `deployEvm` derives the address, signs locally, refuses foreign answers, returns `tx` |
| `packages/deployer/src/l1.test.ts` (new) | fake-RPC unit tests for `deployEvm` |
| `packages/deployer/src/deploy.ts` | records `portalTx`, `routerTx`, `merchantDelay`; sets a non-default delay once |
| `packages/deployer/src/local.ts`, `testnet.ts` (`deployTestnet` only) | pass `merchantDelay`, delete their own set |
| `packages/bridge-core/src/manifest.ts` (+ test) | three optional fields |
| `packages/deployer/src/verify.ts` (+ new `verify.test.ts`) | creation-tx checks, delay policy, identity warning, options object |
| `packages/deployer/src/cli-args.ts` (+ test), `commands.ts`, `verify-cli.ts` | `--allow-pending` |
| `packages/deployer/src/admin.ts`, `commands.ts` (`merchants delay`) | read back the chain, record the new delay, name unsynced merchants |
| `packages/deployer/src/evm.ts` (+ test) | pin the Forge profile for every bridge build |
| `packages/integration/test/transfers.test.ts` | sync its short-delay merchant back to the setting when it is done |
| `packages/bridge-core/src/abi.ts`, `network.ts` (+ test) | `rollup` view; `depositsOpen`; the gate returns it |
| `packages/deployer/src/smoke.ts` | warning line |
| `packages/integration/test/operator.test.ts`, `deposits.test.ts` | creation-tx cases, pending cases, updated exact lists, the gate's return value |
| `apps/showcase/src/demo/{start,wallet}.ts`, `src/live/{LiveRoot,LiveMode}.tsx`, `src/live/actions.ts`, `src/lib/testids.ts` (+ `LiveMode.test.tsx`) | withdraw-only mode |
| `apps/showcase/e2e/specs/withdraw-only.spec.ts` (new) | the page with a moved registry, end to end |
| `docs/operations.md`, `docs/architecture.md`, `docs/integration.md`, `implementations-plan/follow-ups.md` | as above |

### Trade-offs and alternatives not taken

- **Verify the creation tx only (no deploy-side derivation)**: the router and L2 bridge would bind to an RPC-reported address before verify runs. Rejected: the owner chose both halves.
- **Compare the receipt with `deployContract`'s returned hash**: that hash is the RPC's answer. Replaced by the locally computed hash.
- **Make the creation-tx fields required**: breaks parsing of the committed testnet manifest. Rejected by the owner.
- **A separate `depositsOpen` probe only, with the gate unchanged** (competing outline): callers could forget the second call. The gate returns the flag, and the probe is exported for the deposit's re-check.
- **`depositsOpen` as a separate return from `startDemo`**: would retype `App`, `useOpening` and `ProvingPage`. It rides on `DemoWallet`, labelled as opening-time state.
- **Remove "Deposit" from the action list when closed**: hides why, and the deposit scene chip would preselect an action the select cannot show. A notice plus a disabled button is used.
- **A "recorded-delay" policy that waives, with no flag, a pending change whose target equals the manifest**: rejected by the director's panel. A target equal to the pin says nothing about the caps an entry enforces until the change lands. Only the guardian slot is exempt, because its delay never caps a tx.
- **`--allow-pending` as a name filter in `verify-cli.ts`** (competing outline): brittle, and it would hide failures whose names happen to match.
- **A local integration case with a real registry switch**: rejected. The switch cannot be undone within a run and would break every later spec on the shared deploy. On L1, the portal's refusal of deposits and its payout of proven exits after a switch are covered by `TokenPortal.t.sol` `test_staleRollup_refusesDepositsButStillPays`. The TS change is covered by the unit, component and e2e tests the owner chose.

## Security & Adversarial Considerations

- **Trust boundaries.**
  - The L1 RPC a deploy uses is trusted for inclusion, never for addresses or tx hashes.
  - `verify` trusts the endpoints it reads through, as before.
  - The manifest a page embeds is trusted at build time.
  - Only the admin and deploy keys write the delay setting.
- **Deploy-side binding.** The address depends on the signing key and its nonce alone. The tx hash is computed from the locally signed bytes. So the router, the L2 bridge and `initialize` bind only to a contract this key creates, and the deploy stops on a receipt for any other tx at that nonce.
- **Verify-side binding.** Against its endpoints, `verify` proves the constructor that ran is this commit's, sent by the manifest's deployer. `to == null` plus exact init code rules out factory, proxy and internal creations. A manifest without the fields gets a warning, never a pass, and the docs say a warning there leaves the constructor unverified.
- **Delay policy.**
  - A setting that differs from the manifest fails.
  - Every entry and the guardian slot must be scheduled to the setting.
  - An entry's pending decrease or switch change fails unless the operator opts in, and then each one is printed with its time.
- **Page.** The flag can only make the page refuse deposits; it never enables an action the contracts refuse. The deposit re-reads it before anything is signed, so a page opened before a switch starts no new deposit afterwards. A switch landing during a deposit already under way, or an L1 endpoint that lies "open", leaves the page where it is today: the portal refuses the deposit itself.
- **Least privilege, supply chain, crypto.** No new dependency, key or secret. No network call outside the existing endpoints. `getContractAddress`, `encodeDeployData`, `keccak256` and local signing come from the pinned `viem` 2.56.7. No keyed run: local networks only, `RUN_ID=deploy-verify`.

## Assumptions

### Facts
1. `deployEvm` takes `receipt.contractAddress` and checks only `status` (`packages/deployer/src/l1.ts:48-59`).
2. In viem 2.56.7, `deployContract` returns `sendRawTransaction`'s result, which is the RPC's answer (`actions/wallet/sendTransaction.ts:370-385`). `waitForTransactionReceipt` resolves a replaced tx with the replacement's receipt (`actions/public/waitForTransactionReceipt.ts:310-330`).
3. The manifest schema is strict, and `deployments/testnet.json` lacks every new field (`packages/bridge-core/src/manifest.ts:29-62`).
4. `TokenPortal` exposes `IRollup public rollup` and binds it once at `initialize` (`contracts/evm/src/TokenPortal.sol:98,132-135`). `TOKEN_PORTAL_ABI` lacks the view (`abi.ts:233-256`).
5. The token constructor writes `merchant_delay = 86400` and raises the guardian slot's delay to match (`contracts/aztec/token/src/main.nr:1081-1084`). A later `set_merchant_delay(3600)` leaves a 23 h pending decrease on the guardian slot. The slot is read only in public functions (`main.nr:782`, `:840`).
6. `verify` already warns on a pending entry or guardian-slot delay change, reads the setting at `latest` apart from the list's block, and reads each entry's switch state (through `syncMerchantList`) without judging it (`verify.ts:181-200`).
7. In the integration specs, `merchants.test.ts` leaves an entry marked a day ahead and `transfers.test.ts` leaves one with a switch-off pending; both share one deploy with `operator.test.ts` (`packages/integration/test/merchants.test.ts:20-41`, `transfers.test.ts:59-70`).
8. `operator.test.ts`'s "a manifest naming another L1 deployer" case expects the initializer check alone (`:107-113`). With the `from` check, both creation checks fail there too.
9. The smoke run's first step is a deposit (`packages/deployer/src/smoke.ts:177`).
10. The director approved editing `deployTestnet`; the `keyed-ops` batch stays inside `selfFundedFees`.

### Inferences
1. Anvil returns a creation tx's `input` as the exact `encodeDeployData` bytes. The Phase 1 gate proves it on a live local deploy.
2. `prepareTransactionRequest` followed by `signTransaction` and `sendRawTransaction` produces the same tx `deployContract` would (same nonce, gas estimate, fee fields). `l1.test.ts` and the Phase 1 local deploy prove it.
3. Playwright runs the last-registered `context.route` first, so a spec-level route can answer `getCanonicalRollup` before `recordRpc` passes calls on. The page's viem client does not batch, but the spec handles a JSON-RPC batch array anyway.
4. Bun runs the spec files sequentially in one process; the order is not a documented contract. So no spec may leave an entry off the setting (`transfers.test.ts` restores its merchant), every verify unrelated to pending changes passes `allowPending` (the drift helper and the tour verify), and the strict-mode case asserts only what its own merchant causes (`toContain`). Then each `operator.test.ts` exact list holds whichever specs ran before it.
5. An endpoint serves `eth_getTransactionByHash` for the deployment's creation txs. Geth's default lookup limit is about a year of blocks and providers prune; a missing tx fails with a pointer to `--l1-rpc`.

### Asks
- Resolved: `deployTestnet` ownership (director: approved, option a).
- Resolved: the delay policy (director's panel). Standalone verify is strict for entries. `--allow-pending` waives only entry delay changes whose target equals the manifest, and entry switch changes, each printed with its time. The guardian slot's pending delay is exempt and printed. Neither deploy pipeline passes a flag. `merchants delay` rewrites the pin once its set lands.

## Approval

**Approved 2026-10-13** by the director for the owner (plan `6750ac4`), with three conditions:
1. Ledger row 8 stands: no real registry switch in integration.
2. The locally signed create is proven on anvil only. The PR body says the Sepolia path first runs at the next testnet redeploy. `deployEvm`'s fee and gas fields stay exactly what `deployContract` would send: prepare, sign, send raw, nothing set by hand.
3. Phase 4 runs integration and the full e2e one after the other, never in parallel. Under this host's load, a spec that fails only on a timeout gets one rerun, then a `MILESTONE` message naming it, not a loop.

## Implementation phases

### Phase 1: the deploy binds its creation txs and verify checks them ✓

1. Change `deployEvm`: derive, sign locally, compare the broadcast answer and the receipt, return `tx`. Add `l1.test.ts` with a fake RPC: the honest path returns the derived address and calls `sendRawTransaction` with the locally signed bytes. A broadcast answer naming another hash, a receipt with another hash and a receipt with another address each throw before the function returns.
2. Add `portalTx` and `routerTx` to the manifest schema, with manifest tests: absent is accepted, malformed is refused.
3. Record both in `deployBridge`. Pin the Forge profile in `buildBridgeContracts`, with a unit test of the env helper.
4. Add `creationCheck` and `createdAsBuilt` to `verify.ts`. Add `verify.test.ts`: a call (not a creation), another sender, other init code, a reverted tx, another created address and a router block other than `deployBlock` each fail; an absent field warns; a tx the endpoint cannot find fails. Make the `verify-cli` summary name its warnings.
5. Update `operator.test.ts`:
   - "a manifest naming another L1 deployer": now also fails both creation checks.
   - New: a manifest whose `portalTx` names the router's creation tx fails exactly the portal creation check.
   - New: a portal created from the local deployer key with identical runtime but other init code (the build's creation code plus one trailing byte), with its own router and `initialize`, in a manifest naming both new contracts and their creation txs. It fails exactly the portal creation check, `bridge config.portal` and `L2 supply ≤ portal USDC`.
6. Docs: `operations.md` "Verifying a deployment" names the creation-tx check and what its warning means.

**Validation gate**
- Commands:
  1. `bun run lint && bun run typecheck && bun run test && bun run --cwd apps/showcase test:components`
  2. `RUN_ID=deploy-verify bun run net:up`
  3. `RUN_ID=deploy-verify bun run deploy:local`
  4. `RUN_ID=deploy-verify bun run verify:local`
- Pass criteria: every command exits 0. The local manifest carries `portalTx` and `routerTx`. `verify:local` prints `ok` for both creation checks and no `FAIL`.
- Layers: lint, typecheck, unit, local deploy and verify.

### Phase 2: the delay policy ✓

1. Add `l2.merchantDelay` to the schema, with a manifest test for its bounds.
2. Move the delay set into `deployBridge` and record the value. Delete the sets in `local.ts` and `deployTestnet`, and pass the option.
3. Replace `verifyDeployment`'s `guardian` parameter with `opts: { guardian?, allowPending? }`. Update every caller.
4. Add `delayPolicyChecks` (pure; every read at one block). Unit-test:
   - A setting mismatch fails, with and without the flag.
   - The guardian slot's pending change prints `ok` with its time, with and without the flag.
   - An entry's pending target equal to the manifest fails strict and warns, with its time, under the flag. Another target fails under both.
   - A marked entry with no value change fails strict and warns under the flag.
   - An absent `merchantDelay` warns and never waives an entry's pending delay change. Pending switch changes are waived under the flag whether or not the pin is present.
5. Add `--allow-pending` (cli-args, commands, verify-cli), with a cli-args test.
6. `merchants delay`: decide from a read-back of the setting and the list at one block. Rewrite the manifest's `merchantDelay` when the setting equals the request; name every entry not scheduled to it; exit 1 if the send threw or any entry is unsynced. Unit-test the pure decision: full success, a send that threw after landing, a confirmed failure of the first tx, a partial sync, and a successful send whose read-back still shows the old setting (exit 1, manifest unchanged).
7. Integration:
   - `transfers.test.ts` syncs its short-delay merchant back to the setting when it is done, so no spec leaves an entry off the setting.
   - `operator.test.ts`'s drift helper `failing()` verifies with `allowPending`, and its CLI `verify` of the recorded tour passes `--allow-pending`: other specs leave entries marked for a day.
   - The "delay setting not yet synced" case now also expects the setting pin to fail.
   - New: strict verify through the CLI fails on a pending switch-off of the case's own merchant, and `--allow-pending` passes it. The case asserts only what its merchant causes.
8. Docs: `operations.md` covers the verify row, the policy, `--allow-pending`, the recorded delay and committing the manifest `merchants delay` rewrites.

**Validation gate**
- Commands: the fast layers as in Phase 1. Then:
  1. `RUN_ID=deploy-verify bun run deploy:local --merchant-delay 3600`, then `RUN_ID=deploy-verify bun run verify:local`. Both exit 0. Each prints the guardian slot's pending decrease as an `ok` line with its time.
  2. `RUN_ID=deploy-verify bun run deploy:local`, `RUN_ID=deploy-verify bun run bridge demo setup local`, then `RUN_ID=deploy-verify bun run bridge merchants delay local 7200`. All exit 0, and the manifest records 7200.
  3. `RUN_ID=deploy-verify bun run verify:local` exits 1, naming each merchant entry's pending delay change. `RUN_ID=deploy-verify bun run bridge verify local --allow-pending` exits 0 and prints each as a warning with its time.
  4. `RUN_ID=deploy-verify bun run deploy:local`, then `verify:local`: both exit 0.
- Pass criteria: each exit code as stated. The manifest records `merchantDelay` 3600, then 86400, then 7200, then 86400.
- Layers: lint, typecheck, unit, local deploy and verify.

### Phase 3: withdraw-only mode after a rollup switch ✓

Built on its own branch (`worktree-audit-fixes-dv-rollup`, from the Phase 1 commit) and merged here; its log and gate are in `lessons/phase-3.md`.

1. Add the ABI `rollup` view, `depositsOpen(l1, m)`, and the `{ depositsOpen }` result of `assertNetworkIdentity`.
2. `network.test.ts`:
   - A moved registry gives `depositsOpen: false` without throwing.
   - A portal whose stored registry, outbox or rollup version differs from the manifest still throws.
   - The node checks still throw.
3. `verify.ts` and `smoke.ts` add the warning. `deposits.test.ts` asserts the gate's result.
4. Showcase plumbing, the notice and the deposit re-check. `LiveMode.test.tsx`, with deposits closed:
   - The notice shows.
   - Try it is disabled for a deposit draft.
   - Try it is enabled and runs for a claim draft.
   - Payouts still render.
   `actions.test.ts` (it already mocks bridge-core and the demo flows): a page opened with deposits open whose re-check now reads closed returns `failed` with the notice sentence, and the deposit flow (`castDeposit`) is never called.
5. Add the `withdraw-only.spec.ts` e2e spec. Its route answers `getCanonicalRollup` with another address once switched on.
   1. The page opens with deposits open (no notice). The route switches. A deposit run is refused with the notice sentence, and no `eth_sendRawTransaction` or `eth_sendTransaction` leaves the page.
   2. After a reload, the notice shows and Try it is disabled for a deposit draft.
   3. A live L2 send settles.
6. Docs: the `operations.md` "Rollup upgrade" subsection (with `verify` and `smoke` behaviour), `architecture.md`, `integration.md`, `follow-ups.md` O-11.

**Validation gate**
- Commands:
  1. The fast layers.
  2. `RUN_ID=deploy-verify bun run deploy:local` and `RUN_ID=deploy-verify bun run verify:local`: identity passes, with no warning while deposits are open.
  3. `RUN_ID=deploy-verify bun run net:down`.
  4. `bun run test:e2e -- withdraw-only.spec.ts` (it runs its own network and run id).
- Pass criteria: all exit 0. The e2e spec passes.
- Layers: lint, typecheck, unit, component, local deploy and verify, e2e (one spec).

### Phase 4: full heavy gates ✓

1. `RUN_ID=deploy-verify bun run test:integration`: its own network and deploy, every spec, then the clock specs.
2. `bun run test:e2e`: every spec, including `withdraw-only.spec.ts`.
3. `bun run lint:actions`.

**Validation gate**
- Commands: as listed.
- Pass criteria: every command exits 0. Afterwards `~/.agents/ports.md` holds no row for `deploy-verify` or the e2e run ids this session started, and no process from those runs is alive.
- Layers: integration, e2e.

## Decision ledger

**Outline chosen**: the main outline. The competing outline (smallest surface, no signature changes) lost on each piece. A separate deposit-state call is easy to forget. A name filter for `--allow-pending` is brittle. Setting the delay after verify records a value verify never saw. Dropping "deposit" from the action list breaks the deposit scene chip. Both auditors agreed.

**Audit round 1.** Codex `gpt-6.1-sol` high: reject. Opus 5.5 (`Plan`): conditional approve. The director's panel ruled on the delay policy in parallel.

| # | Finding (source) | Disposition |
|---|---|---|
| 1 | The receipt was compared with the RPC's own answer: `deployContract` returns `sendRawTransaction`'s result (Codex High, Opus High) | Adopted. Sign locally, compute the hash, require the broadcast answer and the receipt to match it. `mined()` checks the receipt's hash for every write. The plan now keeps endpoint trust for inclusion explicit |
| 2 | The identity gate trusted the bound rollup's own answers and lost the link to the manifest's registry (Opus High) | Adopted. Pin the portal's stored registry, inbox, outbox and version; deposit state is the contract's own test (canonical vs bound) |
| 3 | "Recorded-delay" waiver proves no provenance (Codex Medium) | Superseded by the panel. Entries are strict; `--allow-pending` waives entry changes whose target equals the pin and switch changes, each printed. The guardian slot is exempt (public reads only), and neither pipeline passes a flag |
| 4 | `merchants delay` leaves the pin stale (Opus Medium; panel) | Adopted. The pin is rewritten once the set's tx lands; unsynced merchants are named, exit 1 |
| 5 | Exact-list expectations: the foreign-deployer case and the copied portal's backing check (Codex Medium, Opus Medium) | Adopted. Both lists updated in Phase 1 |
| 6 | Deposit state is an opening-time snapshot (Codex Medium) | Adopted. The deposit re-reads it before any balance read or signature. The page notice stays opening-time, labelled so |
| 7 | Smoke's behaviour after a switch was unspecified (Codex Medium) | Adopted. It warns, a fresh run exits 1 at its deposit, a run journaled past its deposit continues; documented |
| 8 | A real registry switch in the local integration suite (Codex Medium) | Rejected. Irreversible within a run on the shared deploy. The L1 behaviour is covered by `test_staleRollup_refusesDepositsButStillPays`, and the TS change by the unit, component and e2e tests the owner chose |
| 9 | A tx the endpoint cannot find; `deployBlock` unchecked (Opus Medium) | Adopted. Missing tx fails with a pointer to `--l1-rpc`; the router's creation receipt pins `deployBlock` |
| 10 | Withdraw-only on testnet needs an old-rollup node in the bundle (Opus Medium) | Adopted as docs. A hosted node follows the new rollup; the runbook says to point `l2.nodeUrl` at the old-rollup node and rebuild. Running that node is the operator's (Galactica's on mainnet) |
| 11 | Reproducibility rests on more than `bytecode_hash` (Codex Low) | Adopted. The default profile and pinned inputs are stated |
| 12 | Older CLIs cannot parse a manifest with the new fields (Codex Low, Opus Low) | Adopted as a stated limit. A manifest is read by its `sourceCommit`'s CLI or newer |
| 13 | Spec-file order; cleanup check on the wrong run id (Codex Low, Opus Low) | Adopted. The drift helper uses `allowPending`, the new case asserts only its own merchant, and the gate checks the run ids this session owns |
| 14 | The notice slot is taken; LiveMode and the delay verdicts near their budgets (Opus Low) | Adopted. `Notices` component, `depositBlocked` helper, a per-change verdict helper over the merchant list |
| 15 | A pass with an unverified constructor reads as a plain pass (Opus Low) | Adopted. The verify summary names its warnings |

**Final fresh-context pass** (Codex `gpt-6.1-sol` high, new session): reject, one High. All findings adopted:

| # | Finding | Disposition |
|---|---|---|
| 16 | Integration exact lists still depend on spec order: `transfers.test.ts` leaves a merchant off the setting, and the tour's strict CLI verify meets entries other specs leave marked (High) | Adopted. `transfers.test.ts` restores its merchant; the tour verify passes `--allow-pending`; the new strict case asserts only its own merchant |
| 17 | No mandatory test executes the deposit re-check (Medium) | Adopted. An `actions.test.ts` case, and an e2e step that switches after the page opened. The claim is narrowed: a switch during a deposit already under way is the portal's to refuse |
| 18 | The default Forge profile was assumed, not enforced (Medium) | Adopted. `buildBridgeContracts` pins it and drops inherited Foundry overrides, with a unit test |
| 19 | A thrown send does not prove the tx failed, so the `merchants delay` pin could go stale (Medium) | Adopted. The command decides from a read-back of the chain, not from the send |
| 20 | Two policy sentences disagreed; recon still recommended the retired switch definition (Low) | Adopted. Wording fixed; recon updated |

**Re-review** (same final session, resumed): conditional approve, with one condition: `merchants delay` exits 1 and leaves the manifest when the read-back setting differs from the request. Adopted (row 21).

| # | Finding | Disposition |
|---|---|---|
| 21 | A stale read-back after a successful send could exit 0 without updating the pin (Medium) | Adopted. A setting that differs from the request exits 1, prints both values and leaves the manifest; tested |

**Final verdict**: conditional approve (Codex `gpt-6.1-sol`, final session); its one condition is folded in.

**Unresolved disagreements**: none open. Codex wanted a real registry switch in integration (row 8). That is rejected with the reason above, and the director may overrule it.

## Post-implementation

Run these steps in this order. `code_review` is `off`, so `/code-review` is not run.

1. **Codex audit.** Run `/codex high` on `gpt-6.1-sol` (`run-codex.sh … gpt-6.1-sol`) over the net diff from the rebased base (`origin/dev`). Send plan.md, the decision ledger, an adversarial ask ("What could go wrong? What would an attacker target? What are we trusting that we shouldn't?") and these two rules verbatim:
   - *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*
   - *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*
2. **Fix loop.**
   1. Verify each finding against the code.
   2. Apply the accepted ones and commit.
   3. Log the round in `lessons/phase-5.md`.
   4. Resume the same Codex session with the fix diff, under the same two rules.
   Stop when a round has no new material finding. If round 3 still has one, stop and send `BLOCKED deploy-verify` to the director.
3. **Delivery.** Run `git fetch origin dev && git rebase origin/dev`, then the Phase 1 fast gates again. Then open one PR with `gh pr create --base dev`, only now. Watch it with `gh pr checks --watch`. Never merge. Commits, the PR body and test names describe changes and the properties they guarantee: no audit ids and no attack narratives.
4. **Close-out**, as the PR's final commits:
   1. Write an `## Outcome` block after the front matter. It holds the date, the status, what shipped with the PR number, a disposition line for each dropped or rejected item, an `Open items:` line, and a line that retires this plan's seeds.
   2. Promote generalizable gotchas into `implementations-plan/lessons.md`, one line each (8 KiB budget: dedupe and retire). The driver does not run `memo` (crew rule).
   3. File every open item in its home (table below). Dedupe with `gh issue list --state all --search "<words>"`. An issue body has five sections: What happens, Where, Impact, Possible fix, Record.
   4. Run `git mv implementations-plan/audit-fixes-deploy-verify implementations-plan/archive/audit-fixes-deploy-verify` in its own commit, and repair links (`git grep -n audit-fixes-deploy-verify`).
   5. Move the index line into `archive/index.md`.
   Then send `DONE deploy-verify: <PR url>; CI <state>` to the director, and stay alive for rebase requests.
5. **Teardown after the merge.** Once `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/audit-fixes-deploy-verify/plan.md` succeeds, run `agent-worktree done audit-fixes-deploy-verify --merged --trunk dev`. This session started inside the worktree, so there is nothing to `ExitWorktree`. Relay a refusal and stop. The director's messages tell this session about the merge; a crew worker runs no `/loop`.

| Situation | Home |
|---|---|
| Work inside the implementation you are on | the active `plan.md` and the PR |
| Actionable work that outlives the plan | a GitHub issue, with a domain label and a `Record` link to the archived plan |
| Needs a product call, or waits on something outside the repo | an issue labelled `owner-decision` or `blocked:external` |
| A suspected exploitable weakness | a private draft security advisory |
| Rejected, superseded or already done | a disposition line in the Outcome block |
| Knowledge that prevents a repeat | `implementations-plan/lessons.md` |

## Delivery

Single arc: Phases 1–4 on branch `worktree-audit-fixes-deploy-verify`, one PR to `dev` (`gh pr create --base dev`), `code_review: off`. The close-out lands as that PR's final commits. No stack.

## Seeds

Final (post-approval). This worker runs under the director's protocol, not a `/loop`, so the `/goal` seed is the one to use.

**Recommended: `/goal`**

```
/goal All phases marked ✓ in implementations-plan/audit-fixes-deploy-verify/plan.md, each backed by its validation gate reported passing in the transcript; for each phase `LESSONS_FILE=implementations-plan/audit-fixes-deploy-verify/lessons/phase-N.md` printed; /code-review NOT run (code_review: off); the Codex fix loop (gpt-6.1-sol, high) converged on the net diff, evidenced by a resumed pass reporting no new material findings quoted in the transcript; one PR to dev exists, created only after the loop converged (`gh pr view` output in the transcript), with the close-out's archive-move commit (`git show --stat`); `bun run test` and `bun run lint` both exit 0 in the transcript.
```

**Alternative: `/loop`**

```
/loop 15m Drive implementations-plan/audit-fixes-deploy-verify forward. Each firing: read plan.md and lessons/ (authoritative); pick the next unchecked step; after each edit run `bun run lint` + the touched workspace's tests; a phase is green only when its gate in plan.md passes — then mark ✓ and print LESSONS_FILE. All phases ✓: run the Post-implementation section exactly as written (Codex loop, rebase, one PR to dev, close-out, DONE to the director). Never merge, never deploy to testnet, never run a keyed command, never touch toolchain.json.
```
