# Handover: integrating private payments and split deposits into aztec-x402

For the agent implementing the aztec-x402 side of `private-payment-amounts.md` and `one-step-payment-from-ethereum.md`.
Read both proposals first, the **Concerns** sections in particular; this file covers what they leave to the
integration. Everything on the inference-money side is done (PR #4 into `chore/aztec-6.0.0`); nothing here needs a
contract change.

## Before you start

- **SDK version.** The functions below are in `@galactica-net/inference-money-core` from the release after 0.3.0
  (expected 0.4.0, built for Aztec 6.0.0). It ships only once the bridge is redeployed on testnet: every class id moved,
  so the new token has a new address and the shipped testnet manifest changes with it. Until then, develop against
  a local network and a workspace link to `packages/bridge-core`, never against the testnet manifest of 0.3.0.
- **Pins.** aztec-x402 pins the SDK exactly, and every `@aztec-labs/*` package at the SDK's Aztec version (6.0.0 now,
  rc.3 in aztec-x402 today). Bump them together; mixed versions disagree about artifacts and addresses.
- **Reference usage.** `packages/integration/test/payments-private.test.ts` and `split.test.ts` in inference-money run
  both flows end to end through the SDK on a local network; copy their call sequences. The SDK's semantics and every
  refusal are in `docs/integration.md` (sections "Payments under a reference" and "Split deposits").
- **Never set `SEED`** in a process that loads the SDK; draw references and salts only through the SDK
  (`newPaymentRef`, `prepareSplitDeposit`), which use the platform CSPRNG.

## Where aztec-x402 is today

- `packages/middleware/src/middleware.ts`: 402 with a nonce, then `X-402-PREPARE` (the merchant opens a request on
  chain), then `PAYMENT-SIGNATURE` (verify, settle, serve). Pending payments live in an in-memory `pendingPayments` map.
- `packages/core/src/types.ts`: `ExactAztecPayload`, `ClientAztecSigner` (`finalizePayment`), `FacilitatorAztecSigner`
  (`prepareCommitment`, `verifyPayment`).
- `packages/agent/src/aztec/tokens/`: `TokenAdapter` with `openRequest` / `pay`; `inference.ts` is the inference-money
  adapter (`openRequest`, `payRequest` through a `PaymentGate`); `payment-store.ts` holds the file-backed store.
- `packages/agent/src/aztec/completion-log.ts`: verification by the completion log, which is exactly what leaks the
  amount. The new flows do not use it.

Keep the commitment flow working alongside during the migration (AIP-20 tokens and existing clients still use it).

## Flow A: pay under a reference (private amount)

**Protocol.** No prepare phase. The 402's `extra` carries `{ nonce, mode: "ref", paymentRef }`; the client pays and
retries with the proof in `PAYMENT-SIGNATURE`. Naming is yours (a new `mode`, or a new scheme); keep the 402 shape
otherwise unchanged so a client can tell the modes apart from `extra`.

**Merchant (server).**
1. On a 402: `paymentRef = newPaymentRef()` (or an HMAC of the nonce under a server key, for a stateless server). Store
   `{ nonce, paymentRef, price, asset, payTo, expiresAt }`. The reference must be unpredictable: anyone who knows it can
   test whether it was paid (`refPaidOnChain`).
2. On `PAYMENT-SIGNATURE`: look up the nonce, check the proof's `paymentRef` is the one issued for it, and **persist the
   proof durably before anything else**. Then
   `receivePayment(wallet, node, token, merchant, proof, { paymentRef, price })`. It throws `PaymentProofRefusedError`
   with `reason`: `malformed` and `foreign` (a bad proof: answer 402), `not-mined` (retry later: answer 402 with a retry
   hint, keep the stored proof), `reverted`, `no-payment`, `underpaid`.
3. Mark the reference served (durably, before responding) and serve. `receivePayment` is idempotent, but "served" is
   yours to track: a retried request with an already-served reference must not be served twice.
4. A background job calls `consolidate(wallet, node, token, merchant, { fee })` at least every 12 h. Also back up the
   merchant wallet's store. A stored proof can be fed in again only within 26 h of the payer's transaction; after a
   crash between storing and taking in, replay stored proofs on start.

**Buyer (client).**
1. `payPrivate(gate, wallet, token, { from, to: payTo, amount, paymentRef }, { list, fee })`. The wallet must be built
   through the gate (`gate.bindWallet`), as for `payRequest` today; `list` is a freshly synced merchant list
   (`syncMerchantList`), `fee` the sponsor's payment method (there is no default).
2. **Persist the returned `PaymentProof` immediately** (concern 1 of the proposal: before this returns, a crash loses the
   payment). Keep it until the server answers 2xx; resend the same proof on every retry. Never pay the same reference
   again: the gate refuses it (`PaymentRefusedError`), and so does the token.
3. Send it as the `PAYMENT-SIGNATURE` payload: `{ txHash, paymentRef, messages }` (`PaymentProof` is JSON-safe). It is
   about 2 KB of JSON (two messages of 15 fields each), about 3 KB base64: fine for a header, but check your proxies'
   header limits.

**External wallets.** `payPrivate` needs the wallet to return the transaction's `offchainMessages` (aztec.js
`TxSendResult`). An embedded wallet does; check any external wallet you support before offering it this flow.

## Flow B: split deposit (pay from Ethereum in one step)

**Protocol.** The 402's `extra` carries `{ nonce, mode: "split", paymentRef, merchant: payTo, price,
denominations, chainId, portal }`; the client deposits on Ethereum and retries with the `SplitProof` (`{ l1TxHash,
price, paymentRef, changeCommitment, salt }`).

**Buyer (client).**
1. Pick an amount from `DENOMINATIONS` (at least the price), never the bare price.
2. `prepareSplitDeposit({ amount, merchant, price, paymentRef, buyer }, manifest, now, list)`. `buyer` is the Aztec
   account that will collect the change: it must exist at deposit time, and its first collection binds it to the
   depositing Ethereum address. `now` is L1 time (the permit deadline counts from it).
3. Persist the draft durably (`encodeTicket("draft", draft)`): it holds the only copy of the change's salt. Then the
   usual deposit calls: `ensurePermit2Allowance` once, `submitDeposit`, `confirmDeposit` (store the ticket,
   `encodeTicket("claim", ticket)`), with `reconcileDeposit` for recovery, exactly as the existing deposit UI does.
4. Send `splitProofOf(draft)` as the payment payload.
5. Later, from any Aztec wallet holding the buyer account: `changeState(changeOf(ticket), node, manifest)` until
   `"owed"`, then `claimChange(change, node, wallet, manifest, { allowBind })` (ask for binding consent on a first claim,
   as today). A buyer bound to another Ethereum address gets `NotFundingAddressError`: offer `returnChange` and say it
   publishes the change amount.

**Merchant (server).**
1. Needs an Ethereum RPC (a viem `PublicClient`) besides its Aztec node.
2. `verifySplitDeposit(publicClient, manifest, merchant, proof, { paymentRef, price }, { confirmations })`. Default 2
   blocks; a price threshold above which you wait for `finalized` is a good server option. Refusals:
   `SplitProofRefusedError` with `malformed`, `not-found`, `unconfirmed` (answer 402 with a retry hint), `underpaid`.
3. **Listing timing (concern 3).** Refuse a deposit whose L1 block is older than the moment your listing landed on
   Aztec, or it can be returned to the buyer after you served it. The SDK has no helper for this yet: read your
   `MerchantAdded` event's block (`contractEvent(tokenArtifact, "MerchantAdded")` through `getPublicEvents`) once at
   start, and compare its timestamp with the deposit block's. Ask inference-money for a helper if you prefer.
4. Persist the returned `SplitClaim` (it holds the salt) and the served reference, then serve.
5. A background job, per stored claim: `waitSplitClaimable(claim, node, wallet, manifest, merchant)`, then
   `claimSplit(claim, node, wallet, manifest, { from: merchant })`. `"consumed-unknown"` means someone else claimed it
   (the price is still yours: check the balance) or it was returned. Claim promptly: an unclaimed deposit becomes
   returnable once a switch-off of yours takes effect. Retry on `SponsorUnavailableError`.

## Storage the server needs

Durable, shared by every server instance: issued references (nonce, price, expiry), received payment proofs, served
references, pending split claims. The in-memory `pendingPayments` map is not enough for either flow.

## Testing

- Local: inference-money's local network (`RUN_ID=x bun run net:up`, `deploy:local`) and its manifest; list the merchant
  with `bun run bridge merchants add <manifest> <address>`.
- Cover at least: a retried request with the same proof (served once); a proof replayed for another nonce; a client
  crash after `payPrivate` returns (proof persisted, retry succeeds); a server crash between storing and taking in a
  proof (replayed on start); an unconfirmed split deposit (402, then success); a split deposit for another merchant or
  price (refused); the claim job surviving a restart.
- Measure `pay_private` proving time in the browser and `claimSplit` throughput for the sponsor before mainnet.
