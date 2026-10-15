---
plan: audit-fixes-sdk-fees
tier: light
status: delivered 2026-10-13 (PR #45)
base: ad77d10
trunk: dev
driver: claude-code
codex_model: sol
claude_model: opus
code_review: off
explainer: off
eli5_mode: file
budget: recon 1 agent; code-review off; Codex at high
---

## Outcome

- **Date**: 2026-10-13. **Status**: delivered in PR #45 to `dev`; merging is the owner's call.
- **Shipped**: `ListOptions.fee` required and `"account-public"` the one public spelling, with a missing or unknown fee refused at runtime before any send; `verify` fails a sponsor-less manifest off a local network; `openRequest` refuses an opener that is not a merchant through `MERCHANT_MAX_DELAY` opening for another account; `SendJournal` and `exitToL1`'s hand-off rule (`ExitUnconfirmedError.sent`), wired into the integration harness, the deployer session and the showcase.
- **Validation**: the unit gate green after the rebase onto `dev`; integration 46/47, with `[A28]` failing on #40 (the local L1 gas cap) in both runs; clock 6/6, the held exit refused after hand-off now expected as `ExitUnconfirmedError`; e2e `try-happy` passed; the Codex fix loop converged in three rounds (`lessons/phase-4.md`).
- **Rejected or narrowed**: matching a private exit by its authwit nullifier (rejected in plan audit round 2: the content match suffices); enforcing list freshness in `openRequest` (narrowed to a documented bound, round 2); treating an `Invalid tx:` refusal as nothing burned (rejected by the director, Ask 1); changing the showcase's conflict retry (out of scope by the director's condition 2, filed as #43).
- **Open items**: #43, #44.
- **Seeds retired**: the `/goal` and `/loop` seeds at the end are a historical record; never run them.

# bridge-core: who pays, who opens, and an exit's hash

Four SDK fixes in one PR to `dev`:
1. Every payment call names its fee payer. The public option is spelled `"account-public"` for payments, claims, exits and returns alike.
2. `verify` fails a manifest without a fee sponsor off a local network.
3. `openRequest` refuses anyone but a merchant opening a request for another account.
4. `exitToL1` keeps the hash of every exit tx it handed to the node, so an exit whose send failed after that is never reported as safe to retry.

## Outcome & Quality Bar

**For whom**: an integrator who calls bridge-core (a wallet, an x402 facilitator) and reads its types and errors, not its source.

**What excellent looks like**:
- A payment call that does not say who pays does not compile. The public choice reads `"account-public"` everywhere, and its doc says what it publishes.
- An exit whose tx reached the node is never answered with "kept; retry later": the error carries the tx hash, and the integrator resumes from it.
- `openRequest` refuses the one opening that names a merchant for nothing (a user opening for someone else) before anything is proven. Every other opening still works: own requests, merchant pads, merchant to merchant.

**Good enough**: claims, exits and returns keep their documented default (sponsored for private, account for public); the production fee strategy stays Galactica's decision.

## Architecture & Implementation

**Fee vocabulary** (`claim.ts`, `payments.ts`):
- `FeeChoice = "sponsored" | "account-public"`. `feeFor` maps `"account-public"` to `undefined`, as it does `"wallet-default"` today. Public kinds still default to `"account-public"`; private kinds to `"sponsored"`.
- `export type PaymentFee = { paymentMethod: FeePaymentMethod } | "account-public"`; `ListOptions.fee: PaymentFee` (required). One local helper `sendFee(fee)` maps it for the three `.send({ fee })` sites.
- Why one literal: the literal is the only place an integrator sees that the account becomes the tx's public fee payer. `"public"` (the card's spelling) collides with `kind: "public"`, which means the public balance, not the payer.

**Sponsor guard** (`deployer/src/verify.ts`): `verifyEnvironment` returns `check("SponsoredFPC", m.network === "local", …)` for a manifest without `sponsoredFpc`, with a detail that says private flows then have no fee payer that hides the account. `verifyEnvironment` is exported for its unit test.

**Opener rule** (`payments.ts` `openRequest`): inside the `withFreshList` attempt, before the side check, throw unless `r.from.equals(r.to)` or the opener is a merchant now and once any change already scheduled lands (`merchantStatus(list, r.from)` and `merchantStatus(list, r.from, list.at + MERCHANT_MAX_DELAY)`, the latter reading the scheduled value, since no change lands later than its delay's maximum). A switch-off can land before the tx's anchor, after which the token proves only the merchant recipient (it always keeps a merchant recipient's side) and the opening would go through; a cancelled switch-off leaves a future `changeAt` with the merchant still on, which this reading allows. The check is exactly as fresh as the list: a change scheduled after the read lands at least `MERCHANT_MIN_DELAY` (1 h) later, so a list read just before the call, which `ListOptions.list` already requires for every side choice, cannot miss one. A list kept for over an hour can, and the doc comment says so. The text names the remedy: ask a merchant to open the request. Existing rules still apply: a user's own request is refused by the token (no merchant on either side); that is unchanged.

**Send journal** (new `bridge-core/src/sent.ts`, exported from `index.ts`):

```ts
export interface HandedTx { txHash: TxHash; expiresAt: bigint }
export interface SendWatch { readonly seen: readonly HandedTx[]; stop(): void }

export class SendJournal<N extends Pick<AztecNode, "sendTx"> = AztecNode> {
  readonly node: N   // proxy: each live watch whose matcher accepts the tx records it, then sendTx is forwarded
  bindWallet<W extends object>(create: (node: N) => Promise<W>): Promise<W>
  isBound(wallet: object): boolean
  watch(matches: (tx: Tx) => boolean): SendWatch
}
```

- The watch matches the exit's own tx by content, as `PaymentGate` matches payments, so an unrelated send through the same wallet is never taken for the exit:
  - a public exit: a public call request to the bridge whose calldata (`[selector, recipient, amount, caller_on_l1, nonce]`, `getPublicCallRequestsWithCalldata`) carries this exit's fresh authwit nonce at index 4. Exact.
  - a private exit: an L2-to-L1 message emitted by the bridge to the portal whose content is `withdrawContentHash(recipient, amount, 0)` (`tx.data.getNonEmptyL2ToL1Msgs()`). Every tx with that message pays the same L1 recipient the same amount: another identical exit, or a return to that address, sent through the same wallet while this exit's send runs.
- `exitToL1(e, wallet, sends: SendJournal<ExitNode & Pick<AztecNode, "sendTx">>, m, opts)` replaces the `node` parameter; reads go through `sends.node`. It refuses a wallet not bound to `sends` before any witness or proof. `sendExit` takes the nonce from its caller, so the matcher knows it.
- On a throw from `sendExit`: the watch saw matching txs → `ExitUnconfirmedError(sent[0].txHash, …, { cause }, sent)` carrying every match with its own expiry; none → today's mapping (`sponsorFailure` when sponsored, else the raw error). So a sponsor-less manifest still gives `SponsorUnavailableError` before any hand-off. Several matches (only the private race above) are all kept: their fates and expiries are independent, so the exit may still burn until every one is gone, and dropping one would let a recovery rule declare the exit gone while it can still land.
- `ExitUnconfirmedError` gains `readonly sent?: readonly HandedTx[]`: set when the send itself failed, every tx the node received that may be this exit. Its message says the tx reached the node, that a fee rejection after that is the node's word the client cannot verify (when the cause carries fee text), the latest expiry among `sent`, and that a retry is safe only once every listed tx is gone. Without `sent`, today's text stands.
- Binding is cooperative, as with `PaymentGate`: `bindWallet` records what its factory returns, so it catches a wallet built without the journal, not a factory that ignores the node. The doc comment says so.
- Recovery trusts the node that reads it: `finalFate` and `locateWithdrawal` take that node's word. The docs say to resume against a node you trust (your own); the journal covers a wrong send error, not a wrong chain view.
- The three wallets built on a `PaymentGate` get the journal under the gate: `new PaymentGate(sends.node, …)`, wallet bound to both (`gate.bindWallet((gated) => sends.bindWallet(() => open(gated)))`). `Session`, `DemoWallet` and `Harness` expose `sends`. The showcase keeps its durable `onNextSend` record; the journal adds the error mapping.

**File map**: `bridge-core/src/{claim,payments,exit,sent,index}.ts` and tests (`claim.test.ts`, `payments.test.ts`, `exit.test.ts`); `deployer/src/{verify,session,smoke}.ts` + new `verify.test.ts`; `apps/showcase/src/{demo/wallet,live/actions}.ts` (+ any test fake of `DemoWallet`); `packages/integration/test/{harness,exits.test,exit-rules.test,actors}.ts`, `packages/integration/clock/merchant-exit-expiry.test.ts`; `docs/{integration,operations,assurance-map}.md`.

**Alternatives not taken**:
- Fold the journal into `PaymentGate` (every caller already has one): mixes payment records with exits, and an exit-only integrator would need a payment store.
- Brand the node type with a symbol instead of a class: same guarantee, but no wallet binding, so a wallet built on another node silently falls back to "kept; retry".
- A window of every hash handed off during the call (the first draft): an unrelated send through the same wallet in that window would be taken for the exit, and two overlapping exits would get an untyped error. Rejected after the plan audit for content matching, which uses two stdlib accessors (`getNonEmptyL2ToL1Msgs`, `getPublicCallRequestsWithCalldata`) that `PaymentGate` already relies on in kind.
- Match a private exit by its burn authwit's nullifier (unique per nonce): exact even for identical exits, but recomputes aztec-nr's authwit nullifier derivation and its domain separator in TypeScript (neither is exported by the pinned SDK). The message match differs only in a race that names another tx paying the same recipient the same amount.
- Enforce the opener's freshness against the chain clock (refuse when the latest block is over 30 min past `list.at`): one more node read on every opening for another account, and a freshness rule only this one check would have; every other side choice already rests on `ListOptions.list` being read just before the call.
- Trust an `Invalid tx:` refusal as nothing burned (keeps the honest drained-sponsor retry): that text is the node's word alone, the case this fix covers. Rejected by the director (Asks).

## Security & Adversarial Considerations

- **Threat model**: a chain observer (fee payer and handshake tags are public on every tx); a hostile or flaky node (lies about a send's fate, drops replies); an integrator who uses the API as typed.
- **Fee payer**: no silent public payer on payments; the public choice is explicit and documented. While the testnet sponsor is drained, private flows stall; no public fallback is added.
- **Double burn**: once the exit's tx reached the node, no error says "retry". A node that refuses honestly (drained sponsor) now also yields `ExitUnconfirmedError`; the integrator waits for the tx's fate instead of retrying. Residual trust: the recovery reads (`finalFate`, `locateWithdrawal`) believe the node they ask; the docs say to use your own.
- **Opener leak**: the SDK no longer creates the one opening that announces a merchant (a user opening for it), including through an opener whose switch-off is pending. The token still allows it to upstream-ABI callers; the docs say so.
- **Out of scope, reported**: the showcase's retry on a duplicate nullifier treats an `Invalid tx:` refusal of a sent copy as gone on the node's word (`apps/showcase/src/live/actions.ts`, `fateOf`). Exits no longer reach it (a send failing after hand-off is `ExitUnconfirmedError`); other one-send actions still do. Raised with the director; not changed here.
- **Supply chain / crypto / least privilege**: no new dependency, no crypto, no key handling, no CI permission change.
- **Residual**: the first note between two accounts still announces the recipient once per pair (refunds, pads, first direct sends). Docs state it; a token-side change is out of scope.

## Assumptions

**Facts**
1. `ListOptions.fee` is optional and only `payments.test.ts` omits it (`payments.ts:168`; recon callers list).
2. `"wallet-default"` appears only in `claim.ts:30,33` and `claim.test.ts:62`.
3. The wallet hands the proven tx to its node's `sendTx` after computing the hash (`base_wallet.js:368-386`).
4. The fee-balance refusal is a node validator text (`error_texts.js:3`), reached only after hand-off.
5. `verifyEnvironment` passes a sponsor-less manifest (`verify.ts:228`); `manifest.ts:32` knows only `local` and `testnet`.
6. Every product opener is a merchant opening its own request; `requests.test.ts:79,134` are merchant pads (recon). A user's own request is refused by the SDK (`payments.ts:195-196`) and the token (`token/src/main.nr:378-380`): no merchant on either side.
7. Three wallets are built on a `PaymentGate` (showcase, deployer session, integration harness), and `exitToL1` is called from them only, plus `exit.test.ts`.
8. The kernel tail output lists a private call's L2-to-L1 messages with their raw content, recipient and emitting contract (`stdlib/dest/kernel/private_kernel_tail_circuit_public_inputs.js:158-160`, `messaging/l2_to_l1_message.js:120`), and `exit_to_l1_private` emits its message in private (`token_bridge/src/main.nr:267-268`).
9. `"account-public"` sends with no fee option; the pinned wallet then makes the sending account pay (`base_wallet.js:185-188`).

**Inferences**
1. `bun run typecheck` checks `@ts-expect-error` lines in `src/*.test.ts` because `src` is in each tsconfig's `include` (Codex confirmed).
2. Reads through the journal's proxy behave as reads on the node: the pinned RPC client's methods are closures (Codex confirmed); a private-field class would need target-bound methods, as `demo/wallet.ts:72-79` does.
3. A public exit's calldata carries its authwit nonce as a field (`exit_to_l1_public(recipient, amount, caller_on_l1, authwit_nonce)`), so a random nonce identifies its tx.

**Asks** (both answered by the director, 2026-10-13)
1. A drained sponsor on an exit now reads `ExitUnconfirmedError`, not `SponsorUnavailableError`. **Answer: yes**, the card's rule: a node answering fee text after it took the tx is the very case fixed. The error names the tx's expiry and says resuming settles it. Follow-up, not in this PR: a shorter exit tx lifetime would bound the unconfirmed window (an issue at close-out).
2. `fee` is required on payment calls only; claims, exits and returns keep their default (`"sponsored"` for private kinds, `"account-public"` for public ones). **Answer: yes**, no test-only churn.

## Phases

### Phase 1: one fee vocabulary, and the sponsor guard ✓

1. Rename `"wallet-default"` to `"account-public"` in `FeeChoice` and `feeFor`. Rewrite the doc comment to say what the account publishes.
2. Add `PaymentFee`, make `ListOptions.fee` required, and map it at the three send sites.
3. Add `fee` to every `ListOptions` in `payments.test.ts`. Add one test: `"account-public"` sends with no fee option (the wallet's default, the account), and a sponsor method makes the sponsor the payload's fee payer.
4. Add `@ts-expect-error` lines: a `ListOptions` without `fee`, and a `FeeChoice` of `"wallet-default"`.
5. Make `verifyEnvironment` fail a sponsor-less manifest off local. Add `deployer/src/verify.test.ts`: testnet without a sponsor fails, local without one passes.
6. Docs: `integration.md` (fee payer is public on every tx, the sponsor is load-bearing, `"account-public"` names the account), `operations.md` (`verify` refuses a sponsor-less manifest off local; a deployment off testnet needs a fee strategy first, Galactica's decision), `assurance-map.md` A15.

**Validation gate**: `bun run lint && bun run typecheck && bun run test && bun run --cwd apps/showcase test:components`. Pass: all exit 0; the new payments, claim and verify tests run and pass. Layers: lint, typecheck, unit, component.

### Phase 2: the opener rule ✓

1. Add the opener check to `openRequest`; update its doc comment and `RequestIntent.from`'s.
2. Add a unit test: a user opening for a merchant, and a merchant with a switch-off pending opening for a user, are both refused with nothing sent; a merchant whose switch-off was cancelled is not refused by this rule.
3. Docs: `integration.md` (who `openRequest` lets open; the first note between two accounts announces itself once per pair; a payment into a request announces nothing).

**Validation gate**: same commands as Phase 1. Pass: all exit 0; the refusal test passes. Layers: lint, typecheck, unit, component.

### Phase 3: the send journal and exits ✓

1. Add `SendJournal` in `bridge-core/src/sent.ts` and export it.
2. Change `exitToL1` to take a journal, refuse an unbound wallet, and map a failed send as Architecture says.
3. Build the showcase, deployer and harness wallets under a journal; pass it at every `exitToL1` call.
4. Tests in `exit.test.ts`: a node that receives the exit's tx and then throws fee text, or rejects with a network error, gives `ExitUnconfirmedError` with that hash and expiry (private and public kinds); an unrelated tx sent beside an exit that fails before hand-off is not taken for it (the sponsor error stands); two overlapping identical private exits whose second send fails both appear in `sent`, each with its own expiry, and the message names the later one; an unbound wallet is refused before anything is sent. Existing tests move to a bound journal. The matchers run against real txs in the integration suite (Phase 4): a test there sends a private and a public exit through a node that throws after receiving each and expects `ExitUnconfirmedError` with the tx's real hash.
5. Docs: `integration.md` (build the wallet on a `SendJournal`; what `ExitUnconfirmedError` now covers), `assurance-map.md` A14 test names.

**Validation gate**: same commands as Phase 1. Pass: all exit 0; the new exit tests pass. Layers: lint, typecheck, unit, component.

### Phase 4: integration ✓

1. Run `RUN_ID=sdk-fees bun run test:integration`.
2. Run `RUN_ID=sdk-fees bun run test:e2e -- try-happy.spec.ts`: the page exits through its wallet, now built under the journal. A spec that fails only on a timeout gets one rerun; if it fails again, send a `MILESTONE` naming it.

**Validation gate**: both commands exit 0 with every spec passing, the A14, A15 and request specs included. Layers: integration (local network), e2e (browser on a local network).

## Post-implementation

1. **Codex audit**: `/codex high` on `gpt-6.1-sol` (pass the slug as `run-codex.sh`'s fifth argument) over the net diff from `ad77d10` (rebased base if it moved), with this plan, an adversarial ask (what could double-burn, leak a payer, or let a refused opening through), and the two rules below verbatim.
2. **Fix loop**: verify each finding against the code, fix, commit, log the round in `lessons/phase-4.md`, then resume the same Codex session with the fix diff. Stop when a round has no new material finding. Still material after round 3: stop and send `BLOCKED sdk-fees`.
3. **Delivery**: rebase onto `origin/dev`, rerun the Phase 1 gate, push, `gh pr create --base dev`. First time any PR is opened.
4. **Close-out**, as the PR's final commits:
   - Write `## Outcome` after the front matter: date, status, PR number, what was dropped and why, an `Open items:` line, and a line retiring the seeds.
   - Promote any generalizable gotcha into `implementations-plan/lessons.md` (8 KiB budget, dedupe, retire what it supersedes). Qualify the existing `Invalid tx:` line (Aztec / Noir section): it holds for an honest node only, and exits never trust it.
   - File open items in their homes (table below). Dedupe with `gh issue list --state all --search "<words>"`; an issue body has `## What happens`, `## Where`, `## Impact`, `## Possible fix`, `## Record`. Known items:
     - an issue for a shorter exit tx lifetime, which would bound how long an unconfirmed exit stays undecided;
     - an issue (label `showcase`) for the showcase's duplicate-nullifier retry (`apps/showcase/src/live/actions.ts:360-385`), which takes an exit copy's `Invalid tx:` refusal as gone. Possible fix: decide a refused copy's fate by the journal's expiry rule, never by the node's refusal text. The Outcome's `Open items:` links both.
   - `git mv implementations-plan/audit-fixes-sdk-fees implementations-plan/archive/audit-fixes-sdk-fees` in its own commit; repair links (`git grep -n audit-fixes-sdk-fees`); move the index line to `archive/index.md`.
   - Then `gh pr checks --watch`, send `DONE sdk-fees`, and wait. Merging is the owner's call.
5. **Teardown after the merge**: once `git fetch -q origin dev && git cat-file -e FETCH_HEAD:implementations-plan/archive/audit-fixes-sdk-fees/plan.md` succeeds, `ExitWorktree` (`keep`), then `agent-worktree done audit-fixes-sdk-fees --merged`. Never force past a refusal; relay it. A session without a `/loop` arms one background wait for that check right after its wrap-up report.

| Situation | Home |
|---|---|
| Work inside this implementation | this plan and the PR |
| Actionable work that outlives the plan | a GitHub issue, domain label, `Record` link to the archived plan |
| Needs a product call or waits outside the repo | an issue labelled `owner-decision` or `blocked:external` |
| A suspected exploitable weakness | a private draft security advisory |
| Rejected, superseded or done | a disposition line in the Outcome |
| Knowledge that prevents a repeat | `implementations-plan/lessons.md` |

**The no-over-engineering rule**: *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*

**The comment-quality rule**: *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*

## Delivery

Single arc, one branch (`worktree-audit-fixes-sdk-fees`), one PR to `dev` with `gh pr create --base dev`, Phases 1–4, `code_review: off`. The close-out lands as the PR's final commits. No stack.

## Audit verdicts

**Codex round 1 (gpt-6.1-sol, high): reject.** Findings and dispositions:
1. High, stale list lets a switched-off opener through: **adopted**. The opener must be a merchant with no change pending. A stale-negative list (a merchant added after the read) refuses without a resync; the caller re-reads and retries. Accepted as is: that costs one call, not privacy.
2. High, "a user's own request stays allowed" is false: **adopted as a correction**. The token never allowed it (no merchant on either side). The brief's "any opener opening its own request" means the new guard adds no refusal there. The remedy text now says "ask a merchant to open it".
3. High, a window of handed-off hashes can take an unrelated send for the exit: **adopted**. The journal now matches the exit's own tx by content (nonce for public, message for private).
4. Medium, binding is cooperative: **adopted** as a doc comment. Real composition is covered by the integration suite, whose harness builds the wallet the same way.
5. Medium, `finalFate` trusts its node: **adopted** in the docs (resume against your own node). The error text does not promise more.
6. Low, "no fee payer" wording: **adopted**; the test asserts the send option.
7. Low, `lessons.md`'s `Invalid tx:` line: **adopted** at close-out.
Also adopted: the showcase's component command repeats `bun run test`. Kept anyway: the brief lists it, and it costs little.

**Codex round 2: reject.** Findings and dispositions:
1. High, the opener check is only as fresh as the list: **narrowed explicitly**, not enforced. The token always keeps a merchant recipient's side, so no capsule can make the chain check the opener; a chain-clock rule would be the only freshness rule in an SDK whose every side choice rests on `ListOptions.list` being read just before the call. The doc comment states the bound (a list over an hour old can miss a switch-off).
2. High, the private content match can name another tx: **adopted in part**. The plain `Error` branch is gone: any match gives `ExitUnconfirmedError`. Kept the content match: a false match needs another tx paying the same L1 recipient the same amount, sent through the same wallet during this exit's send, and recovering from it pays exactly what the exit owed. Exact matching (the authwit nullifier) is rejected above.
3. Medium, `pending` is not a switch-off after a cancellation: **adopted**. The rule reads the scheduled value.
4. Low, the public matcher: **adopted**. Bridge address plus the nonce at calldata index 4; an integration test runs both matchers on real txs.

**Codex round 3: reject.** One finding:
1. High, reporting only the first match loses the real exit's expiry when identical private exits overlap: if the first expires early and is gone, a recovery rule built on it declares the exit gone while the second can still land, and a retry burns twice. **Adopted**: the error carries every match with its own expiry (`sent`), its message names the latest, and a retry is safe only once all are gone. A regression test covers the overlap.

**Codex round 4 (confirm): approve.**

**Director approval (2026-10-13), with conditions**: (1) Phase 4 adds the `try-happy.spec.ts` browser run; (2) the showcase's conflict retry stays out of this PR and becomes an issue at close-out; (3) `SendJournal` stays exactly as planned: no extra options, no second use.

## Seeds

```
/goal Phases 1-4 of implementations-plan/audit-fixes-sdk-fees/plan.md are marked ✓, each backed by its validation gate passing in the transcript and LESSONS_FILE=implementations-plan/audit-fixes-sdk-fees/lessons/phase-N.md printed; the Codex fix loop on gpt-6.1-sol converged (a resumed round with no new material finding, quoted); `RUN_ID=sdk-fees bun run test:e2e -- try-happy.spec.ts` passing in the transcript; one PR to dev exists, opened after the loop, carrying the close-out (`git show --stat` of the archive move in the transcript); `bun run test` and `bun run lint` exit 0.
```

```
/loop 15m Drive implementations-plan/audit-fixes-sdk-fees forward from its plan.md and lessons/ (not the chat). Pick the next unchecked step, run the fast gate after each edit, commit. Phase green → mark ✓, log lessons, next. All ✓ → Codex fix loop on gpt-6.1-sol with the plan's two rules, then rebase on origin/dev, gh pr create --base dev, close-out commits, gh pr checks --watch, DONE to the director. Stuck → /codex high, log the verdict. Never merge, never deploy, never widen scope.
```
