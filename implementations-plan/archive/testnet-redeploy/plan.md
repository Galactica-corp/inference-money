---
plan: testnet-redeploy
tier: light
driver: claude-code
eli5_mode: skipped (director's brief)
code_review: off
codex_model: sol
explainer: off
trunk: dev
issue: 49
---

## Outcome

- **Date**: 2026-10-15. **Status**: delivered in PR #101 to `dev` (`Closes #49`); merging is the director's call.
- **Shipped**: the bridge on the rc.3 rollup (`deployments/testnet.json`, `sourceCommit` 8b6cbde, both admin roles
  accepted by the rc.3 admin), the demo cast (`testnet-demo.json` v2, both merchants listed and bound) and the
  recorded tour (`testnet-tour.json`); the rc.3 admin address in `testnet-deploy.env.example`. Every tx hash and
  address is in `lessons/`.
- **Validation**: `verify --tour` 59 `ok` (both creation txs, delay 86 400, both merchants, the tour); smoke passed;
  `probe:testnet` 19/19; lint, typecheck, test, `lint:actions` 0; `build:testnet` 7/7; `test:testnet` on the branch
  preview 2/2. Codex: plan audit (8 adopted), read-back fix 2 rounds, needles fix 2 rounds.
- **Plan-text corrections**: "No code changes" did not hold. Three director-approved changes landed: `readBack` for
  L1 reads after a receipt, the scan-needles exemption for committed public endpoint text, and the owner's endpoint
  rotation (both testnet URLs on one dRPC key, origin-filtered and IP-allowlisted; the owner committed it, 1883c2a).
- **Dispositions**: the #76 amendment (dRPC's keyless node) was reverted before KEYED 1, since dRPC's free plan refuses
  batches over 3 calls (`lessons/phase-2.md`). Withdrawing the pending KEYED 3 request was attempted, blocked by auto
  mode, and cancelled; the owner approved it as filed (`lessons/phase-4.md`).
- **Known limits**: none.
- **Open items**: #76. After the merge, `test:testnet` against the `dev` preview, quoted on #101.
- **Seeds retired**: this plan had none.

# Redeploy the testnet bridge on Aztec 6.0.0-rc.3

`dev` runs Aztec 6.0.0-rc.3 (#91), but `deployments/testnet.json` names a bridge on the retired rc.1 rollup. This batch deploys the bridge on the rc.3 rollup with the runbook (`docs/operations.md`, "Testnet, in order"), hands the admin roles to the owner's admin, sets up the demo cast, records the tour, and ships the three files in one PR to `dev` (`Closes #49`). No code changes.

## Outcome & Quality Bar

- **For whom**: a visitor of the `dev` preview, and a reader who verifies the testnet deployment from its manifest.
- **Excellent**: `bridge verify deployments/testnet.json --tour deployments/testnet-tour.json` passes strict, with `ok` for both creation-tx checks and `merchant delay setting == manifest` (#49); `test:testnet` against the `dev` preview passes live, proving in the browser.
- **Good enough**: lessons record every tx hash and address the runbook prints; no extra checks beyond the runbook's.

## Architecture & Implementation

- **Change map**: `deployments/testnet-deploy.env.example` (the rc.3 admin address), `deployments/testnet.json`, `deployments/testnet-demo.json` (version 2), `deployments/testnet-tour.json`, this plan folder. Three changes beyond the runbook, each a director's amendment:
  - **Read-back** (after two stale L1 reads in KEYED 1, lessons/phase-2.md): `readBack` (`packages/bridge-core/src/l1-receipt.ts`) re-reads a state read that follows a receipt, up to 15 times 2 s apart, and returns the last value; `ensurePermit2Allowance` (`permit2.ts`, used by the demo cast and the showcase) and smoke's final balance-delta check (`packages/deployer/src/smoke.ts`) read back through it, and still fail closed. Simulations and nonce reads after a receipt (the SDK's Fee Juice deposit, `portal.initialize`'s estimate, a deposit's estimate) stay as they are: each fails before anything is sent, and a rerun covers it.
  - **Scan needles** (a false-positive exit scan, lessons/phase-2.md): `urlForms` (`packages/deployer/src/secrets.ts`) drops a standalone URL segment or query value only when a committed public endpoint contains it verbatim; the full URL, its path + query and userinfo stay needles, for the scan and the log redaction alike.
  - **Endpoint rotation** (the owner's, lessons/phase-4.md): `TESTNET.nodeUrl` and `TESTNET.defaultL1RpcUrl` (`networks.ts`) and the manifest's `l2.nodeUrl` move to one dRPC key, origin-filtered for browsers and IP-allowlisted for the operator host; the default L1 RPC leaves PublicNode. Committed by the owner (1883c2a).
- **Keyed cycle** (each keyed run): commit and push the branch → `bash scripts/keyed-worktree.sh sync` → file the request from `~/.cache/inference-money/keyed` with the runbook template, the chain ending in `secrets:scan` → `KEYED <n>` to the director → `env-exec wait <id>`. After a run that writes files: copy them into this worktree, check them byte-identical, commit, push, then `keyed-worktree.sh remove` and `sync` (sync refuses a keyed tree with local changes, and env-exec refuses a dirty tree).
- **Keyless steps** (`demo setup`, `demo status`, `verify`, `smoke --record`) run in this worktree, so their outputs land on the branch directly; their state lives in `~/.cache/inference-money/{demo,smoke}/<bridge>/`, shared by both checkouts.
- **Alternative not taken**: the keyless steps in the keyed worktree, as the brief's step 7 says. Rejected: each output there dirties the keyed tree before the next request.

## Security & Adversarial Considerations

- **Secrets**: the L1 key, deployer secret and admin secret reach only env-exec children; the CLI redacts and scrubs them; every chain ends in the scan. No agent reads, prints or guesses one. No `bridge disposable`.
- **Host**: while a keyed run is live, nothing is installed, built, tested or committed on the host. Same-user processes are trusted (runbook, Keyed runs 3); no script here makes a boundary against them.
- **One owner of the keyed checkout**: this session alone moves `~/.cache/inference-money/keyed`. Before filing and after each run, list every pending or running request with its checkout (`env-exec status <id>` per id under `~/.agents/keyed/`), confirm none but the current one names the keyed checkout, and quote that in the `KEYED` message. The director keeps the owner from approving any other request from filing to the run's end, and through each copy, remove and sync.
- **Code the keys run**: env-exec pins the keyed tree's commit, a pushed branch tip; the keyed install skips scripts.
- **What the scan proves**: no textual form of the run's own secret-named values in the checkout or `~/.cache/inference-money` (dependencies and the disposable dir skipped), and no wallet store left. Not host-wide isolation.
- **Wrong admin**: a deploy proposes both roles to `TESTNET_ADMIN_ADDRESS`; an address no key controls strands the handover (Fact 1). KEYED 0 derives it on rc.3 first.
- **Public data**: addresses, tx hashes and demo keys only. The only RPC URLs written are the committed defaults (`networks.ts`).
- **Chain risks**: a rollup switch mid-run (probe first; the deploy probes again); front-running a cast binding (the merchants' salt stays unpublished until setup ends, #94); a reorg before finality (`demo setup` and `smoke` wait for finalized claims).
- **Trusted endpoints**: the manifest's node (`networks.ts` `nodeUrl`) and the public Sepolia RPC. A lying endpoint can fake finality or a read-back; the runbook already states that `verify` trusts what it reads (Verifying a deployment). Accepted for testnet.
- **Public demo Ethereum keys**: they derive from the bridge address, so anyone can drain the cast's funding once the deploy lands (runbook, Demo: demo funds only). Accepted; a drained account fails setup, and recovery re-reads balances before any refill.
- **Wrong listing**: `merchants add` takes any address and testnet `verify` does not pin the cast set. Compare the raw addresses with the first `demo setup` stop line before KEYED 3, and with `demo status` after.

## Assumptions

**Facts**
1. The rc.3 bump moved every derived address (0d4460e: "the V3 contract-address separator"); `cast.test.ts:15` pins a fixed secret's Schnorr address, `0x0c5460e0…` → `0x19587f1d…`. `admin address` (`getSchnorrAccountContractAddress`, `cast.ts:56`) and `admin accept` (`createSchnorrAccount`, `deploy-l2.ts:36`) derive the same account. KEYED 0 printed `0x17ff77f7…9490`, now in the deploy template (c037a64); the rc.1 derivation was `0x094fe37a…6915`.
2. `probe:testnet`: 19/19 on 2026-10-14 (node 6.0.0-rc.3, rollup 3409706519, SponsoredFPC published, faucet 1000 FJ per mint ≥ 76.64 budget).
3. The cast's Ethereum keys derive from the bridge address (`packages/demo/src/keys.ts`), so they are new accounts, and `demo fund` tops each up to its target: at most 50.02 USDC and 0.04 ETH in all (`amounts.ts:17`, `demo-l1.ts:40-49`); the sponsor top-up is a Fee Juice mint, not USDC (`demo.ts:298`).
4. The L1 deploy key `0xFcc2…F6F5` held 40.657366 USDC. With the director's yes, the retired rc.1 cast moved its USDC there (public demo keys): A_demo 12.71 (`0xc826953c…a2a2`), B_demo 9.20 (`0xea5470d4…c4c7`). Now 62.567366 USDC, 4.2571 ETH.
5. `secrets:scan` failed `skipped=3` on a closed audit's Python venv; with the director's yes, `~/.cache/inference-money/audit-tools` moved to `~/.cache/inference-money-audit-tools`. Now `found=false files=4008 skipped=0 walletDirs=0`. That keyless run walked files because this session's environment holds one secret-named variable (a harness messaging token), not a run key.
6. `deployTestnet` writes the manifest only after the handover is proposed and verify passes (`testnet.ts:113-119`), and records `portalTx`, `routerTx`, `merchantDelay` (`deploy.ts:80-88`).
7. No `verify:testnet` script exists; the gate is `bun run bridge verify deployments/testnet.json`.

**Inferences**
- I1. The 1Password items `InferenceMoney-Testnet` and `InferenceMoney-Testnet-Admin` exist from the last redeploy, so `op-remote <host> <id>` approves without `op-remote create`.
- I2. The deployer secret's L2 account also moves under rc.3; the deploy deploys it with self-funded fees, as on any fresh rollup.

**Asks**: none. rc3-bump's A2 (Galactica relying on the rc.1 commitment owner) was settled by the owner on 2026-10-13: no (0d4460e).

## Phases

### Phase 1: KEYED 0, the rc.3 admin address
1. File `admin address` under `deployments/testnet-admin.env.example`. Send KEYED 0. Wait.
2. Put the printed address into `TESTNET_ADMIN_ADDRESS`. Commit `chore(deploy): the admin address on rc.3`, with this plan. Push. Sync.

**Validation gate**: the run exits 0 with a scan line `found=false … skipped=0 walletDirs=0`; the address is a 32-byte hex value and differs from `0x094fe37a…`; `bun run lint` exits 0.

### Phase 2: KEYED 1, probe, deploy and fund
1. Re-read the deploy key's ETH and USDC; quote them in KEYED 1 (USDC ≥ 50.02).
2. File `bun run bridge probe testnet && bun run bridge deploy testnet && bun run bridge demo fund deployments/testnet.json` under `deployments/testnet-deploy.env.example`. Send KEYED 1. Wait.
3. Copy `deployments/testnet.json` out, commit, push, remove and sync the keyed worktree.

**Validation gate**: exit 0; the log shows "verified with the handover pending" and the funding lines; scan clean; the manifest's `sourceCommit` is the commit KEYED 1 ran, `l2.nodeVersion` is `6.0.0-rc.3`, `rollupVersion` 3409706519, and it carries `portalTx`, `routerTx`, `merchantDelay`.

**Recovery** (any keyed run that exits non-zero; never rerun a whole chain blindly):

| Case | Action |
|---|---|
| Deploy passed (manifest written), then `demo fund` or the scan failed | Copy and byte-compare the manifest, commit, push, remove, sync. Fix a failed scan first. Re-read the cast's balances, then file `demo fund` alone under `testnet-fund.env.example`. |
| Deploy failed before the manifest | Keep the log; record every address it printed in lessons. Never reuse the old manifest. Ask the director before another deploy. |
| `admin accept` failed, or landed but the manifest was not written | Read `l2.admin` and the roles keylessly (`verify --allow-pending`); rerun the accept alone: it is safe once both roles are held. |
| `merchants add` failed | `merchants list` keylessly; rerun only for the accounts not listed. |

### Phase 3: KEYED 2, admin accept; demo setup to the listing
1. File `bun run bridge admin accept deployments/testnet.json` under the admin template. Send KEYED 2. Wait. Copy, commit, push, remove, sync.
2. Keyless: `bun run bridge demo setup deployments/testnet.json`. It stops at the listing.

**Validation gate**: the accept exits 0 with a clean scan, and `l2.admin` equals Phase 1's address; `demo setup` stops on the listing message and prints both merchant addresses.

### Phase 4: KEYED 3, list the merchants; finish the demo
1. File `bun run bridge merchants add deployments/testnet.json <galactica> <supplier>` under the admin template, with the two addresses copied from Phase 3's stop line. Send KEYED 3. Wait.
2. Keyless: `demo setup` again, then `demo status`, then `bridge verify deployments/testnet.json`, then `bridge smoke deployments/testnet.json --record deployments/testnet-tour.json`. Keep the smoke alive through its epoch-proof wait (up to 3 h); rerun it if it stops.

**Validation gate**: `deployments/testnet-demo.json` has `version: 2`, the bridge and a merchants' salt; `verify` exits 0 with `ok` for both creation-tx checks and the delay setting; its merchant lines, `demo status` and Phase 3's stop line name the same two addresses, and no other; `smoke` exits 0.

### Phase 5: ship
1. `bun run lint && bun run typecheck && bun run test && bun run lint:actions`; `bun run --cwd apps/showcase build:testnet` with a real Node 24 first on `PATH`; `bun run bridge verify deployments/testnet.json --tour deployments/testnet-tour.json`.
2. Commit `chore(deploy): redeploy testnet on Aztec 6.0.0-rc.3 and record the tour`. Push. Open the PR. `bash scripts/keyed-worktree.sh remove`.
3. Before the merge: once Workers Builds publishes the branch's preview, run `SHOWCASE_URL=<branch preview> bun run --cwd apps/showcase test:testnet`; quote it in the PR body.
4. After the owner merges and the `dev` preview builds: `SHOWCASE_URL=https://dev-inference-money.alejo-amiras.workers.dev bun run --cwd apps/showcase test:testnet`; quote it in a PR comment.

**Validation gate**: each command exits 0; `build:testnet` passes its 7 bundle checks; PR CI green; the served check passes on the branch preview before the merge, and on `dev` after it.

## Plan audit

**Codex (gpt-6.1-sol, high; session `01a13bf3…`): conditional approve** (conditions: partial-success recovery; exclusive use of the keyed checkout with request-id checks; scan and endpoint trust limits stated; the served check before the merge). Codex ran under this host's `approve-for-me` sandbox mode, told to stay read-only; the tree was unchanged after.
1. Fact 1 holds; offline derivation and `admin accept` agree: adopted as the reworded Fact 1.
2. No recovery path after partial success: adopted as the Phase 2 recovery table.
3. Fact 3 overstated "empty" and the totals; the cast's Ethereum keys are public once the bridge lands: wording fixed; the drain risk is a disposition (Security), already stated in the runbook's Demo section.
4. The scan's scope was overstated, and a keyless run with `files=4008` looked inconsistent: scope stated (Security); the walk came from one secret-named harness variable (Fact 5).
5. `remove` and `sync` race any run that uses the keyed checkout: adopted as "One owner of the keyed checkout". Checked at 2026-10-14: the six pending requests on this host name other projects' checkouts (unleashed, presto), none the keyed checkout. Same-user attackers: disposition, the runbook's own assumption.
6. Lying endpoints can fake finality or a read-back: disposition (Security, "Trusted endpoints"), the runbook's stated trust in `verify`.
7. The browser check ran only after the merge: adopted as Phase 5.3; `lint:actions` and Node 24 added.
8. A1 was already settled: adopted, Asks now none. Also adopted: `sourceCommit` == the KEYED 1 commit (Phase 2 gate) and the exact merchant comparison (Phase 4 gate).
Rejected: none.

## Approval

Pending.

## Delivery

Single arc: branch `worktree-testnet-redeploy`, one PR to `dev` (`gh pr create --base dev`), body with `Closes #49`, the rc.3 admin-address fact, a "Demo float" section (Fact 4), every tx hash and address, and the gates. The close-out lands as the PR's final commits. No lanes: every phase waits on the previous one.

## Post-implementation

While implementing: log every keyed run, tx hash and address in `lessons/phase-N.md`; stop after 3 failures on one step; update `agent-worktree status testnet-redeploy "<phase>"` and the crew status file at each gate.

1. **Codex fix loop**: none, since no code changes. If code does change, run `/codex high` on `gpt-6.1-sol` over the diff with the adversarial ask and the blueprint's no-over-engineering and comment-quality rules verbatim; hard stop after 3 rounds.
2. **Delivery**: `gh pr create --base dev`, then `gh pr checks --watch`.
3. **Close-out**, as the PR's final commits: an `## Outcome` block after the front matter (date, status, PR, dispositions, `Known limits:`, `Open items:`, one line retiring the seeds); promote general lessons into `implementations-plan/lessons.md` (8 KiB budget, dedupe, retire); file open items (issue, `owner-decision`/`blocked:external` issue, private advisory, or closed `known-limit` issue); `git mv implementations-plan/testnet-redeploy implementations-plan/archive/testnet-redeploy` in its own commit, links repaired; index line to `archive/index.md`.
4. **Report** `DONE testnet-redeploy: <PR url>; CI <state>`. Merging is the owner's call.
5. **Teardown after the merge**: once `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/testnet-redeploy/plan.md` succeeds, run the served check (Phase 5.3), then `ExitWorktree` (`keep`), then `agent-worktree done testnet-redeploy --merged --trunk dev`; never force past a refusal.

## Seeds

None: this session executes the plan under the director's protocol.
