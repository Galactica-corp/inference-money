---
plan: audit-fixes-contracts
tier: mid
status: delivered 2026-10-13 (PR #47)
base: ad77d10 (dev)
trunk: dev
driver: claude-code
eli5_mode: file
code_review: off
claude_model: opus
codex_model: sol
explainer: off
budget: recon 1 agent; code-review off; Codex gpt-6.1-sol at high
---

## Outcome

- **Date**: 2026-10-13. **Status**: delivered in PR #47 to `dev`; merging is the owner's call, and `dev`→`main` waits for the testnet redeploy (the token's class id changes).
- **Shipped**: `self_delivery()` for change, a send to oneself (`from == to`), a self-shield (`from == to == msg_sender`) and bridge mints; every other recipient note stays constrained. `sync_merchant_delay` open to anyone at or above the entry's delay in force, a decrease admin-only (`Only the merchant admin lowers a delay`, in `TOKEN_REFUSALS`). Four TXE re-sync tests, the `[A31]` discovery spec, docs (`integration.md`, A20, A31, GL-22, SP-23).
- **Validation**: `test:noir` token 185, bridge 85, keystone 20; `compile.sh --check`; integration specs 49/49 and clock 6/6 before the rebase, the discovery spec 3/3 after it; e2e 8/8; `build:testnet`; the unit gate after the rebase onto `dev` `8701a42`. The Codex fix loop converged in two rounds (`lessons/phase-3.md`).
- **Rejected or narrowed**: `.with_sender(recipient)` (rejected: the PXE refuses a tag sender outside the tx's scopes, which breaks minter-proven mints); TXE delivery tests (dropped: TXE does not record handshakes, so the integration spec carries them); the brief's caller-identity predicates (replaced by ownership proofs, D3–D5); a fully open re-sync (rejected: it could undo a guardian's cancel, D6); `docs/operations.md` (left to its own batch).
- **Open items**: #46 (nullifier padding for self-deliveries).
- **Seeds retired**: the `/goal` and `/loop` seeds at the end are a historical record; never run them.

# Self-deliveries that announce nothing, and an open delay re-sync

Two findings from a production audit, one on private note delivery and one on merchant delays, fixed in the token contract and delivered as one PR to `dev`:

- **Self-deliveries (high)**: a note the token delivers to an account whose keys the tx's prover provably or by invariant holds is delivered unconstrained, with a tag derived from the address pair. No handshake is created for the pair (account, account), so nothing on chain is findable from the account's address alone. This covers a claim's minted note, the change of every spend and exit, a send to oneself and a self-shield.
- **Delay re-sync, contract half (medium)**: anyone may sync a merchant's entry to a delay setting at or above the entry's current delay. Only the admin may start a decrease. A merchant left alone on a shorter delay is restored by anyone in the next block, and a guardian's cancel still binds everyone but the admin.

The delay finding's `verify` pin and manifest field belong to the `deploy-verify` batch. The toolchain stays at rc.1; the redeploy belongs to a later plan, and `dev`→`main` waits for it.

## Outcome & Quality Bar

**For whom.** A user who claims privately for the first time, then pays (directly or through a facilitator contract) and exits; the same user restoring the wallet on a new device; a merchant that a hostile admin put alone on a short delay.

**What excellent looks like.**
1. After a first claim, a payment with change, a send to oneself and a private exit with change, a node holds no private log under the account's handshake tag. An integration spec proves it. Its control finds exactly the payment tx under the merchant's tag, so the zero is not vacuous. The same spec shows each branch that must stay constrained still announces: a self-shield adds nothing, a public pull by authwit announces under the puller, a private pull under the merchant.
2. A second wallet that holds only the account's secret finds the minted note, each kind of change note and the funding-address binding, with no `registerSender` and no other step, for every tx the account itself sent (the PXE scans its own accounts as tag senders). The same spec proves it, reading that wallet's balance after every step.
3. The token diff is small and each rule is stated once: one invariant comment on the self-delivery builder, one short reason at each site that uses it.
4. A stranger restores a targeted entry at once; a stranger's sync never restarts a pending decrease and never undoes a guardian's cancel. TXE tests prove all three.

**Good enough.** No change to wallets or the showcase. A note from one account to another still announces a handshake once per pair, and self-deliveries drop a nullifier that constrained ones emit; the docs say both.

## Scope

- **In**: `contracts/aztec/token/src/main.nr`; the token's TXE tests and `txe-manifest.txt`; the rebuilt artifacts (`compile.sh`); the token class-id pin in `packages/bridge-core/src/artifacts.test.ts`; the new refusal in `packages/bridge-core/src/rules.ts`; one new integration spec; `docs/integration.md` (inside "What each action makes public"); the token rows of `docs/assurance-map.md` (A20, a new A31); `contracts/aztec/PROPERTIES.md` GL-22 and SP-23.
- **Out**: `verify`, the manifest schema and `docs/operations.md` (the `deploy-verify` batch); `toolchain.json`; any testnet action; the bridge and proxy contracts; nullifier padding (an open item, see Close-out).

## Architecture & Implementation

### Proposed architecture

All changes sit in the token's private library methods and in `sync_merchant_delay`. No external signature, selector, storage slot or event changes.

- **`self_delivery()`**, a contract library method returning `OnchainUnconstrainedDelivery` = `MessageDelivery::onchain_unconstrained().via_address_derived_secret()`. Its comment states the invariant once: use it only where the recipient's own call or its nullifier key proves the tx; a wrong delivery then hides the note only from an owner that trusts its prover; the tag comes from the pair (tx sender, recipient), which no third party can compute, so nothing is announced; a PXE scans its own accounts as senders, so a wallet finds every such note a tx from one of its accounts delivered.
- **Change notes** (`_decrease_private_balance`): always `self_delivery()`. Reason at the site: the call just nullified `account`'s notes, which takes `account`'s nullifier key (`request_nhk_app`, checked by the kernel against the owner's keys): the prover holds the owner's spending authority, not necessarily every key. No minter read, no branch.
- **Recipient notes** (`_increase_private_balance(to, amount, self_send: bool)`): `self_delivery()` when `self_send`, else `onchain_constrained()`. Call sites:
  - `transfer_private_to_private`: `self_send = from == to` (the same call nullified `to`'s notes).
  - `transfer_public_to_private`: `self_send = (from == to) & (to == msg_sender)` (a shield of the caller's own public balance into its own notes).
- **Minted notes** (`_mint_to_private`): delivers its own note with `self_delivery()` instead of calling `_increase_private_balance`. Reason at the site: the only minter is the proxy, which only the bridge calls, and `claim_private` requires `msg_sender == recipient`.
- **`sync_merchant_delay`**: drop the leading `_assert_merchant_admin()`. Inside the existing `if scheduled != delay` branch, assert `delay >= entry.get_current_delay() | msg_sender == admin` with `"Only the merchant admin lowers a delay"`. The no-op check stays first, so a stranger's sync of an entry already scheduled to the setting succeeds and changes nothing.

### Key interfaces

None external. `_increase_private_balance` (internal) gains a `self_send: bool` parameter. bridge-core's `TOKEN_REFUSALS` gains `notAdminLowersDelay: "Only the merchant admin lowers a delay"`.

### Data & control flow (critical path)

1. Claim: U's wallet sends `bridge.claim_private` (tx `from` = U) → proxy → `token.mint_to_private(U)` → minted note to U with the address-derived (U, U) tag → no registry call.
2. Payment: U's wallet sends `token.transfer_private_to_private(U, M, x)` → change to U self-delivered; the note to M constrained (U's first payment to M announces one handshake under M's tag, as before).
3. Facilitator payment: U's tx calls contract C, which spends U's notes by authwit → change to U self-delivered, tag pair (U, U).
4. Exit: U's wallet sends `bridge.exit_to_l1_private` → proxy → `token.burn_private(U)` → change to U self-delivered.
5. Restore: a fresh PXE registers U's keys; log sync adds its own accounts as senders (`log_service.js:201-207`), derives the (U, U) secret and finds every self-delivered note.

### File-level change map

| File | Change |
|---|---|
| `contracts/aztec/token/src/main.nr` | `self_delivery()`; change always self-delivered; `_increase_private_balance` takes `self_send`; `_mint_to_private` delivers directly; `sync_merchant_delay` rule; fork-delta header line |
| `contracts/aztec/token/target/*`, `contracts/aztec/token_bridge/target/*` | rebuilt by `compile.sh` only (the bridge crate stages the token artifact) |
| `contracts/aztec/token/src/test/merchants.nr` | delete `sync_merchant_delay_is_admin_only`; add four re-sync tests |
| `contracts/aztec/token/txe-manifest.txt` | names follow the tests |
| `packages/bridge-core/src/artifacts.test.ts` | the token class-id pin |
| `packages/bridge-core/src/rules.ts`, `rules.test.ts` | the new refusal |
| `packages/integration/test/discovery.test.ts` | new: self-deliveries announce nothing; each constrained branch announces; a restored wallet finds every note |
| `docs/integration.md` | "What each action makes public": what is still announced, the nullifier-count difference, the residuals |
| `docs/assurance-map.md` | A20 names the re-sync tests; new A31 |
| `contracts/aztec/PROPERTIES.md` | GL-22 and SP-23: who may sync, and what a guardian's cancel holds against |

### Algorithms / non-obvious mechanics

- **Runtime choice of a compile-time mode.** aztec-nr asserts the delivery mode is constant per call site (`assert_constant(is_constrained)`, `delivery/mod.nr:102-109`). Each branch calls `deliver` with its own constant builder, so both compile; the runtime condition predicates which one emits. `MaybeNoteMessage::deliver` already wraps delivery in a runtime `if` (`note_message.nr:144`).
- **Who the tag sender is.** aztec-nr reads it from the wallet (`get_sender_for_tags`), which sets it to the tx's `from` (`base_wallet.js:67-69`). The repo never sets `sendMessagesAs`. A wallet that does moves the pair to (override, recipient), and its restore then needs that sender registered; the docs say so.
- **Why pin the derivation.** Without a pinned derivation, aztec-nr first reuses any existing handshake for the pair (`tag_derivation.nr`, `existing_handshake_secrets_or_else`), and only then asks the wallet, whose PXE forces address-derived for a local recipient (`private_execution_oracle.js:142-155`). Pinning skips the handshake lookup and any wallet hook.
- **Cost.** Removing the constrained path from change delivery and from minting shrinks those circuits; the recipient switch adds a small unconstrained path to `transfer_private_to_private` and `transfer_public_to_private`. Baseline (`aztec profile gates`, rc.1): `transfer_private_to_private` 66,116; `transfer_private_to_public` 41,646; `transfer_private_to_public_with_commitment` 46,684; `transfer_private_to_commitment` 44,846; `transfer_public_to_private` 35,581; `burn_private` 36,703; `mint_to_private` 27,692. Phase 2 re-measures and records both in lessons.
- **Re-sync rule.** DelayedPublicMutable schedules a delay change against the delay in force at the tx timestamp: an increase applies at once; a decrease waits old − new; scheduling the current delay clears a pending decrease at once and leaves the value change untouched. So "a non-admin may schedule only `delay >= get_current_delay()`" lets anyone restore an entry and never lets a stranger start or restart a decrease. A guardian-cancelled entry (current = scheduled = 24 h, setting 1 h) is refused because the sync would lower it.

### Trade-offs & alternatives not taken

See the decision ledger. The audits moved the design from the brief's predicates (`account == msg_sender || msg_sender == minter` for change, `to == msg_sender` for recipients) to ownership proofs: a nullification of the recipient's notes in the same call, or the caller shielding its own balance into itself.

## Security & Adversarial Considerations

- **Threat model.** An observer with a list of Aztec addresses (a merchant knows its payers, a node operator its clients) wants to find an account's txs from its address and link them to the L1 depositor. After the fix, the only address-findable markers are handshakes between two different accounts (a payment to a merchant, a merchant payout, a pull by another account), once per pair.
- **Unconstrained delivery trusts the prover.** A wrong unconstrained delivery leaves a note nobody can find. Each use rests on the recipient's own call or its nullifier key proving the tx:
  - change and `from == to` recipient notes: proven by the nullification in the same call (the kernel checks the nullifier key against the owner's address; it proves spending authority, not every key);
  - the minted note: by the invariant that only the bridge mints privately, to `claim_private`'s caller;
  - the self-shield: by the caller being `to`.
- **Residuals (documented, accepted by the director).**
  - A shared-key account (an escrow whose keys several parties hold): a co-holder spending it can withhold the change from the others.
  - A contract recipient whose code anyone can call: its private claim and its self-shield are proven by whoever calls it, who can withhold the note.
  - Recovery follows the tag sender: a wallet finds a self-delivered note only from a tx one of its own accounts sent. A tx sent from another account A that spends U's notes (U in `additionalScopes`), or one under `sendMessagesAs`, tags U's change under (A, U); a wallet restored from U alone does not scan A.
  - The minter invariant holds once the tx is included: the proxy checks its caller through an enqueued public call (`token_minter_proxy/src/main.nr:84,91`), so a non-bridge caller can prove an unconstrained mint, but the tx then reverts.
- **Pulls stay constrained.** A contract that pulls another account's tokens to itself by authwit gets its note by constrained delivery: the payer proves that tx and cannot withhold the note while the contract credits it.
- **Tx shape.** A constrained delivery emits a sequence nullifier; a self-delivery does not. A tx that moves only its sender's own notes now emits fewer nullifiers than one that delivers a note to another account. Counts reveal no address. Padding with a constrained, domain-separated nullifier would restore the old counts; it is an open item. A raw prover-chosen pad would be unsafe: it could equal a request's `paid(c)` nullifier and mark the request paid.
- **Open re-sync.** A stranger's sync schedules only the admin's setting, only upward or to the current delay, never touches the switch value, and is a no-op when the setting is already scheduled. It cannot restart a decrease or undo a guardian's cancel. Events fire only on a real change.
- **Least privilege / supply chain / crypto.** No new dependency, key or CI permission. Cryptography stays aztec-nr's (pinned v6.0.0-rc.1).
- **Contract specifics.** No reentrancy surface. Front-running an admin's sync only does the same scheduling. No new nullifier kind.

## Assumptions

### Facts

1. `claim_private` asserts `self.msg_sender() == recipient` (`token_bridge/src/main.nr:167`) and calls the proxy's `mint_to_private` (`:184`); the proxy checks the bridge through an enqueued public call (`token_minter_proxy/src/main.nr:83-86`).
2. `exit_to_l1_private` burns `self.msg_sender()` through the proxy (`token_bridge/src/main.nr:250`, `:269`); the proxy is the token's immutable minter (`main.nr:153`, `packages/deployer/src/deploy-l2.ts:76`).
3. aztec-nr v6.0.0-rc.1 has `OnchainUnconstrainedDelivery::via_address_derived_secret()` (`messages/delivery/builder.nr`); the address-derived branch never consults the registry (`tag_derivation.nr`).
4. Nullifying a `UintNote` requests the owner's `nhk_app` (`uint-note/src/uint_note.nr:64-70`), which the kernel validates against the owner's keys.
5. The PXE scans its own accounts as senders (`log_service.js:201-207`), and forces the address-derived secret for unpinned unconstrained deliveries to its own accounts when no handshake exists (`private_execution_oracle.js:142-155`).
6. The wallet's tag sender is the tx's `from` unless `sendMessagesAs` overrides it (`base_wallet.js:67-69`); the repo sets neither `sendMessagesAs` nor `registerSender`.
7. `BalanceSet::add(0)` yields no note; `MaybeNoteMessage::deliver` delivers only an existing note (`balance_set.nr:50-56`, `note_message.nr:140-147`).
8. A constrained delivery emits a sequence nullifier (`constrained_delivery.nr:59-66`); an unconstrained one emits none.
9. `sync_merchant_delay` schedules only when the scheduled delay differs from the setting (`main.nr:733-737`); `cancel_merchant_change` re-schedules the current delay (`:790-799`).
10. `packages/bridge-core/src/artifacts.test.ts:11` pins the token's class id; `registerBridgeContracts` refuses a manifest the artifacts no longer derive (`instances.ts:35`, `:53-60`).

### Inferences

1. TXE resolves address-derived tags for its own accounts, so the token and bridge TXE suites stay green. Checked at Phase 2's gate.
2. ~~TXE can count a recipient's non-interactive handshakes~~ Disproved by a probe: the registry's `get_non_interactive_handshakes` utility read 0 under TXE even after a constrained delivery. The integration spec carries every delivery assertion, unconditionally.
3. The registry announces a non-interactive handshake under `computeSiloedPrivateLogFirstField(HANDSHAKE_REGISTRY, computeLogTag(recipient, NON_INTERACTIVE_HANDSHAKE_LOG_TAG))`. The spec's control proves it on every run.
4. `build:testnet` still builds with the new artifact (it checks no class id). The testnet bundle would refuse at runtime until the redeploy, which `dev`→`main` waits for.

### Asks (resolved)

1. Self-deliveries in the token, unconstrained and address-derived: decided by the owner.
2. Delay re-sync: open to anyone upward, admin-only downward, error `"Only the merchant admin lowers a delay"`: decided by the director.
3. Change always self-delivers; a recipient note only when `from == to`; a self-shield only when `from == to == msg_sender`; residuals documented: decided by the director.
4. Nullifier-count difference: accepted and documented; padding is an open item: decided by the director.
5. Disclosure: change-framed wording, no advisory, no audit ids in committed files: decided by the director.
6. `registerSender`: not needed; the spec proves it.

## Phases

### Phase 1: the open delay re-sync

1. In `sync_merchant_delay`, delete the leading `_assert_merchant_admin()`. Inside `if scheduled != delay`, assert `(delay >= entry.get_current_delay()) | (msg_sender == merchant_admin)` with `"Only the merchant admin lowers a delay"`. Rewrite the doc comment.
2. In `merchants.nr`, delete `sync_merchant_delay_is_admin_only`. Add:
   - `a_stranger_restores_a_targeted_entry_at_once`: after the admin's set 1 h, add bob, sync m1, set 24 h, alice syncs bob and m1; both read 24 h now and scheduled.
   - `a_strangers_sync_never_restarts_a_pending_decrease`: alice's sync 12 h into a pending decrease leaves m1's status unchanged, and the decrease lands on time.
   - `a_strangers_sync_never_lowers_the_delay_in_force`: with a pending 24 h → 1 h decrease and the setting moved to 12 h, alice's sync fails with the new refusal (the guard reads the delay in force, not the scheduled one).
   - `a_guardians_cancel_holds_against_a_strangers_sync`: after the guardian cancels a decrease while the setting stays 1 h, alice's sync fails with the new refusal.
3. Add the refusal to bridge-core `TOKEN_REFUSALS` and its mapping test; every `should_fail_with` names the full refusal text (it matches substrings).
4. Update `txe-manifest.txt`, `PROPERTIES.md` GL-22 and SP-23, and the A20 row.
5. Rebuild with `compile.sh`; update the token class-id pin in `artifacts.test.ts`; commit; run `compile.sh --check`.

**Validation gate.**
- Commands: `bash contracts/aztec/scripts/compile.sh --check`; `bun run test:noir`; `bash contracts/aztec/scripts/check-sole-consumer.sh`; `bash contracts/aztec/scripts/check-stamp-constraint.sh`; `bun run lint`; `bun run typecheck`; `bun run test`.
- Pass: every command exits 0; `run-txe-tests.sh` reports every manifest name passed, the four new ones included.
- Layers: typecheck/lint, unit, TXE.

### Phase 2: self-deliveries in the token

1. ✓ Probed TXE: a throwaway test read the registry's `get_non_interactive_handshakes(recipient, 0)` after a constrained delivery and got 0, so TXE cannot observe handshakes. Record it in `lessons/phase-2.md`.
2. Add `self_delivery()` with the invariant comment.
3. Make `_decrease_private_balance` always deliver with `self_delivery()`.
4. Give `_increase_private_balance` the `self_send` parameter; pass `from == to` from `transfer_private_to_private` and `(from == to) & (to == msg_sender)` from `transfer_public_to_private`.
5. Make `_mint_to_private` deliver its note with `self_delivery()`.
6. Add one line to the fork-delta header.
7. The negative branches get no TXE test (step 1); Phase 3's spec asserts each one.
8. Rebuild with `compile.sh`; update the class-id pin; commit; `compile.sh --check`. Re-measure gates; record them.

**Validation gate.**
- Commands: as Phase 1.
- Pass: every command exits 0; every token and token_bridge TXE manifest name passes; the ABI-superset test passes with its additions list unchanged.
- Layers: typecheck/lint, unit, TXE.

### Phase 3: integration spec and docs

1. Add `packages/integration/test/discovery.test.ts`:
   - `beforeAll` runs one scenario and records each step: the txs under the account's handshake tag, and a second wallet's private balance (read first, so it also proves the node indexed the step). The second wallet (`openBridgeWallet`, `registerBridgeContracts`, `createSchnorrAccount(secret, …)`, no `registerSender`) opens right after the claim. `afterAll` stops it.
   - Steps: an account U from `newAccount(wallet, m, randomSecret())`; a fresh merchant; a private deposit of 7 USDC and its claim; a payment of 2 to the merchant (`transfer_private_to_private` U→M, change 5); a send of 1 to itself (notes 4 and 1); a private exit of 2 to the funding address (nonzero change whichever notes it takes).
   - `it("[A31] a claim, a payment's change, a send to itself and a private exit announce nothing under the account's address")`: no tx under U's tag at any step; under the merchant's tag, nothing before the payment and exactly the payment tx after it.
   - `it("[A31] a wallet holding only the account's secret finds every note, with no registerSender")`: the second wallet reads 7, 5, 5 and 3 USDC after the claim, payment, send and exit, and the depositor as the funding address.
   - Then, between accounts: the merchant unshields 2 and shields 1 to itself; a fresh account pulls 1 of the merchant's public balance to itself by authwit; the merchant pulls 1 of U's private balance to itself by authwit.
   - `it("[A31] a shield to oneself announces nothing; a note pulled by authwit to its caller announces the caller's handshake")`: the merchant's tag still holds only the payment after its self-shield; the puller's tag holds exactly the public pull; the merchant's tag adds exactly the private pull; U's tag stays empty (the pulled account's change is a self-delivery).
   - Every tag query follows its step's `landed()` (the receipt carries a block) and a balance read that sees the step's note: the second wallet's for U's own steps, the harness wallet's between accounts (the second wallet does not scan the merchant, under whom U's change from the pull is tagged).
2. Add the A31 row to `docs/assurance-map.md`.
3. In `docs/integration.md` "What each action makes public": what is still announced (the first note one account sends another, once per pair: a payment to a merchant, a merchant's payout, a pull by authwit); the nullifier-count difference in the "Hidden" bullet; the residuals (shared-key accounts, contract recipients callable by anyone; recovery of a note whose tx another account sent, by authwit or `sendMessagesAs`).

**Validation gate.**
- Commands: the fast layers (`bun run lint`, `bun run typecheck`, `bun run test`); then `RUN_ID=contracts bun run test:integration`.
- Pass: every spec passes, the new ones included; the run reaps its network (no `contracts` row left in `~/.agents/ports.md`).
- Layers: typecheck/lint, unit, integration (local network).

### Pre-PR gate

- Commands: every Phase 1 gate command; `RUN_ID=contracts bun run test:e2e`; `bun run --cwd apps/showcase build:testnet`.
- Pass: all exit 0.

## Delivery

Single arc: one branch (`worktree-audit-fixes-contracts`), one PR to `dev` (`gh pr create --base dev`), opened only after the Codex loop converges and a rebase onto `origin/dev`. `code_review: off`. The close-out lands as the PR's final commits. Never merge. The PR body says the token's class id changes, so testnet `verify` and the testnet bundle's contract registration fail until the redeploy, which `dev`→`main` waits for.

## Post-implementation

1. `/code-review`: not run (`code_review: off`).
2. **Codex audit.** Run `/codex high` on `gpt-6.1-sol` (`run-codex.sh … high read-only gpt-6.1-sol`) over the net diff from `ad77d10`, with this plan and its decision ledger, the adversarial ask ("What could go wrong? What would an attacker target? What are we trusting that we shouldn't?"), and both rules below, verbatim.
3. **Fix loop.** Verify each finding against the code. Apply the accepted fixes, commit, and log the round in `lessons/phase-3.md`. Resume the same Codex session with the fix diff. Stop when a round has no new material findings. Still material after round 3: stop and send `BLOCKED contracts` to the director.
4. **Delivery**: rebase onto `origin/dev`, rerun the fast gates, push, `gh pr create --base dev`, `gh pr checks --watch`.
5. **Close-out**, as the PR's final commits:
   1. Write `## Outcome` right after the front matter: date, status, what shipped (PR number), dispositions, `Open items:` (issue numbers or `none`), and the line retiring the seeds.
   2. Promote generalizable gotchas to `implementations-plan/lessons.md` (8 KiB budget; dedupe, prune, date-stamp).
   3. File every open item in its home; at least the nullifier-padding issue (dedupe with `gh issue list --state all --search`; sections What happens / Where / Impact / Possible fix / Record):

      | Situation | Home |
      |---|---|
      | Work inside the implementation you are on | the active `plan.md` and the PR |
      | Actionable work that outlives the plan | a GitHub issue, with a domain label and a `Record` link to the archived plan |
      | Needs a product call, or waits on something outside the repo | an issue labelled `owner-decision` or `blocked:external` |
      | A suspected exploitable weakness | a private draft security advisory |
      | Rejected, superseded or already done | a disposition line in the Outcome block |
      | Knowledge that prevents a repeat | `implementations-plan/lessons.md` |

   4. `git mv implementations-plan/audit-fixes-contracts implementations-plan/archive/audit-fixes-contracts` in its own commit; repair relative links (`git grep -n audit-fixes-contracts`); move the index line to `archive/index.md`.
   5. Push; send `DONE contracts: <PR url>; CI <state>` to the director; stay alive for rebases.
6. **Teardown after the merge.** Once `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/audit-fixes-contracts/plan.md` succeeds, run `agent-worktree done audit-fixes-contracts --merged --trunk dev` (this session started inside the worktree, so there is nothing to exit). It never forces: on a refusal, relay its output and stop. The director tells this session when the PR merges; no background wait is armed.

**No-over-engineering rule** (verbatim in every Codex prompt): *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*

**Comment-quality rule** (verbatim in every Codex prompt): *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*

## Decision ledger

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | Where decisions live | Outline A: in the internal helpers, one `self_delivery()` builder; the recipient helper takes a `self_send` flag from its two callers | Outline B (a flag from every external caller): the invariant spread over seven sites; its one advantage, scoping the minter read, vanished with D3 |
| D2 | Tag derivation | Pinned `via_address_derived_secret()` | Unpinned `onchain_unconstrained()`: reuses an existing handshake first and then follows the wallet; offchain: a restored wallet loses the note; constrained with an interactive handshake: a restored wallet never learns it |
| D3 | Change notes | Always self-delivered (the spend proves the prover holds the owner's nullifier key) | The brief's `account == msg_sender ∥ msg_sender == minter`: a facilitator contract paying from U inside U's tx kept constrained change, which created the (U, U) handshake; it also cost a minter read per spend |
| D4 | Recipient notes in `transfer_private_to_private` | Self-delivered only when `from == to` | `to == msg_sender`: a contract pulling U's tokens by authwit in U's tx would get a note U proves and could withhold |
| D5 | Self-shield | Self-delivered only when `from == to == msg_sender` | `to == msg_sender` alone: also covered a contract pulling another account's public tokens; always constrained: a user's first self-shield would announce its tag |
| D6 | Re-sync | Anyone upward or to the current delay; only the admin lowers | Fully open: a stranger could undo a guardian's cancel while the setting stays low; admin-only: leaves the targeted entry until the admin acts |
| D7 | Nullifier-count difference | Accept and document; padding is an open item | A prover-chosen pad: could equal a request's `paid(c)`; a constrained, domain-separated pad: sound but more circuit and scope than this PR |
| D8 | Re-sync TXE tests | Restore (both variants), no restart, never below the delay in force, guardian cancel holds | A stranger copy of `sync_is_a_no_op_on_a_synced_entry`: duplicates a covered path |
| D9 | Integration spec shape | One scenario in `beforeAll`, recorded per step; three `it`s assert; the second wallet reads after every step | Two independent scenarios: double the deposits and claims for no extra coverage |
| D10 | Tag constants | The registry address and the domain separator as spec constants named after their aztec-nr source, guarded by the control | A new package dependency in `packages/integration`: the brief allows none without a card |

Disputed: none.

## Audit verdicts

**Round 1, Codex (`gpt-6.1-sol`, high): conditional approve.** Adopted:
- Caller identity is not ownership proof: the plan now rests self-delivery on nullification or on the shielding caller, and documents the residuals (→ D3–D5, Security).
- An open sync could undo a guardian's cancel (→ D6, a TXE test).
- Delivery changes the nullifier count (→ D7, docs).
- The spec contradicted itself; it now records in `beforeAll`, asserts exact positive balances with nonzero change, uses a fresh merchant and the payment's exact hash (→ D9).
- Outline A preferred; `self_delivery()` returns the builder type (→ D1).
- The standalone ABI command was wrong (the gates use `bun run test`); runtime registration refuses the old testnet manifest (→ Inference 4).

**Round 1, Opus (Plan agent): conditional approve.** Adopted:
- H1, the class-id pin in `artifacts.test.ts` fails on any rebuild (→ Phases 1 and 2).
- H2, a contract recipient's note proven by the payer (→ D4).
- M1, the fingerprint (→ D7). M2, the cost sign was wrong (→ Cost).
- M3, the spec shape and the named payment call (→ D9). M4, the guardian interaction (→ D6).
- Fact 1 and Fact 5 reworded. The `sendMessagesAs` caveat goes into the docs.
- The Ask to always self-deliver change (→ D3).
- Rejected: none.

**Final fresh-context Codex pass (`gpt-6.1-sol`, high): conditional approve.** Conditions adopted:
- Nullification proves spending authority (the owner's nullifier key), not every key: the comments and the Security section say so.
- Recovery needs a known tag sender: the guarantee is narrowed to txs a wallet's own accounts sent, and the docs name the residual (another account spending U's notes, `sendMessagesAs`). Rejected: `.with_sender(recipient)`, since the PXE refuses a tag sender outside the tx's scopes (`assertAllowedScope`), which breaks mints a minter account proves.
- Predicate coverage made unconditional: TXE cannot observe handshakes (Inference 2), so the integration spec asserts the self-shield, the public pull and the private pull.
- Low: "three" new tests → four; a receipt barrier (`landed()`) before every log query.
- Disputed: none.

## Seeds

The crew director drives this plan; the seeds exist for a resumed session.

```
/goal Phases 1–3 of implementations-plan/audit-fixes-contracts/plan.md are marked ✓, each backed by its validation gate's output in the transcript; LESSONS_FILE=implementations-plan/audit-fixes-contracts/lessons/phase-N.md printed per phase; the Codex fix loop converged (a resumed pass with no new material findings, quoted); the pre-PR gate passed; one PR to dev exists (gh pr view output), opened after the loop, carrying the close-out that archived the plan (git show --stat of the archive move); bun run test and bun run lint exit 0.
```

```
/loop 15m Drive implementations-plan/audit-fixes-contracts forward per its plan.md; never idle; report to the crew director by SendMessage at each milestone; never merge, never touch testnet, never bump the toolchain.
```
