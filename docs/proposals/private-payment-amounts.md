# Proposal: hide the amount of x402 payments

Status: accepted (2026-11-05); implemented in this repository (token `pay_private`, bridge-core `payPrivate`, `receivePayment`, `consolidate`), awaiting the testnet deploy and the aztec-x402 integration. Affects the inference-money token (one new function) and aztec-x402 (payment flow
and verification).

## Summary

Today every x402 payment publishes its amount on Aztec. We propose replacing the current payment mechanism (paying
into a "commitment" the merchant prepares) with an ordinary private transfer that carries a payment reference. The
buyer hands the encrypted payment details to the merchant directly, alongside the HTTP request, rather than through the
chain. Afterwards the chain shows neither the amount nor the merchant. The flow also becomes simpler and cheaper: the
merchant no longer sends a transaction for every request.

## Why change it

- **The amount is public.** Paying into a commitment emits an unencrypted log with the amount. That is how merchants
  verify payments today, so it cannot be switched off within the current design.
- **The amount usually names the merchant.** x402 prices are public. A payment of exactly a merchant's price
  effectively says who was paid, which undoes much of the privacy the token is built for.
- **The merchant pays for every request.** Before each payment the merchant sends an Aztec transaction to prepare the
  commitment. It costs fees and proving time, adds a round trip and a block of waiting for the buyer, and lets anyone
  who requests prices make the merchant spend.

## What we propose

1. The merchant's 402 response includes a random **payment reference** in place of a prepared commitment. Nothing is
   sent on chain.
2. The buyer makes a **private transfer** to the merchant through a new token function. That function also records
   the reference and the amount in an encrypted event for the merchant, and marks the reference as paid so it can
   only be paid once.
3. The buyer sends the encrypted note and event to the merchant with the retried HTTP request (**offchain delivery**),
   instead of publishing them on chain.
4. The merchant checks the transaction landed, decrypts the messages, checks reference and amount, stores the
   messages, and serves the request.

## Implications

**Privacy (better)**
- The amount is no longer visible to anyone but buyer and merchant.
- Nothing on chain names the merchant. A plain private transfer with onchain delivery would announce the merchant on
  each buyer's first payment to it; offchain delivery does not.
- The merchant no longer needs the buyer's Aztec address (today it must know it to prepare the commitment).
- Unchanged: the fee is paid by the sponsor, the buyer stays anonymous on chain, and the merchant list stays public.

**Buyer**
- Faster: one round trip and one waiting block fewer, since no preparation transaction is needed.
- The buyer's client must keep the payment messages until the merchant acknowledges them, so a dropped connection can
  be retried. A buyer who pays but never delivers loses that payment, as with any payment never presented.

**Merchant**
- No transaction or fee per request.
- **New duty: store the payment messages durably.** A note delivered offchain cannot be recovered from the chain with
  the merchant's keys alone. The merchant stores each message before serving and periodically merges its notes into
  one note it sends itself on chain (recoverable from keys), which limits the exposure to payments since the last merge.

**Engineering**
- Token: one additional function and event; existing functions and integrations are untouched.
- aztec-x402: new payment variant (no prepare phase; verification from the delivered messages). The current
  commitment flow can stay alongside during migration.
- Needs a security review like any token change.

## Alternatives considered

| Option | Why not |
|---|---|
| A fresh, undeployed merchant address per payment | Every address would have to be put on the public merchant list (publishing it), spending from each needs a deployed account contract, and the merchant's wallet slows down with every address. |
| Private transfer, payment details published on chain (encrypted) | Announces the merchant on each buyer's first payment, costs a fee per payment; its main benefit (no backup duty) is reachable with storage plus regular merges. Fallback if the team prefers no backup duty. |
| Same, with the delivery proven in the circuit ("constrained") | Additionally slower proving for the buyer. Its guarantee only matters when the recipient acts without checking; an x402 merchant always checks before serving. |
| Keep commitments, hide the amount | Not possible: the published amount is what makes a commitment payment verifiable. |

## Decisions

1. **Durable message storage is accepted.** Merchants use offchain delivery; the aztec-x402 integration gives them the
   tools to store the payment messages, take the payments in and consolidate them.
2. **Merchants consolidate regularly and back up their wallet store.** Aztec drops an offchain message that is not
   processed within 26 hours of the buyer's transaction (the 24 h transaction lifetime plus a 2 h margin), so a stored
   raw message can only be fed in again within that window. Consolidating at least every 12 hours keeps every payment
   either still re-ingestible or already in an onchain note the merchant's keys recover; the wallet store backup covers
   the rest.

## Concerns

Found while implementing; none blocks the testnet deploy, each needs an answer before mainnet.

1. **A payer can lose a payment in a short window.** aztec.js hands the payer a transaction's offchain messages only
   after the node has accepted the transaction, so they cannot be stored before the send. If the payer's process dies
   between the node accepting the payment and the SDK returning, the funds are spent and the merchant's note can never be
   delivered: the merchant cannot serve, and the payer cannot recover it. The SDK returns the messages at the earliest
   moment; the x402 client must persist them at once. A durable fix needs Aztec: a prove-then-send API that returns the
   messages before sending, or a wallet that keeps the offchain messages it sent.
2. **Messages expire after 26 hours.** A merchant's wallet drops an offchain message not processed within 26 hours of
   the payer's transaction. An x402 merchant takes a payment in while serving the request, so this only bites after a
   crash between storing a proof and taking it in, or when restoring a lost wallet store: a stored proof can be fed in
   again only within 26 hours.
3. **Merchants must consolidate and back up.** Until a merchant merges its notes (`consolidate`), the funds depend on
   the stored messages and the wallet store; afterwards on its keys alone. Consolidating at least every 12 hours and
   backing up the wallet store keeps every payment recoverable. An operator that skips both can lose received payments
   with its database.
4. **External Aztec wallets are untested.** A buyer paying from a wallet that is not embedded in the site needs that
   wallet to hand the transaction's offchain messages back to the site. No external wallet has been checked yet; if one
   does not, its users cannot use this payment method.
5. **Proving time is not measured yet.** `pay_private` adds an event and a nullifier to a private transfer. Its proving
   time in the browser, against today's `transfer_private_to_commitment`, still has to be measured with the showcase's
   proving harness.
6. **Unchanged leaks.** The merchant-list read caps the transaction's expiry like every merchant transfer (only a
   shortened merchant delay makes it recognisable), and the fee payer is public (the sponsor keeps the payer out of it).

---

## Technical details

### Token function (sketch)

```noir
#[authorize_once("from", "_nonce")]
#[external("private")]
fn pay_private(from: AztecAddress, to: AztecAddress, amount: u128, payment_ref: Field, _nonce: Field)
```

- Refuses `amount == 0` and `from == to`.
- Proves `to` (or `from`) a merchant like `transfer_private_to_private` does (`_prove_merchant_side`, a private read at
  the anchor; the read caps the tx's expiry like every merchant-rule tx).
- Pushes `paid_ref = poseidon2([to, payment_ref], DOM_SEP__MERCHANT_REF_PAID)`: one payment per reference and merchant.
  The reference is a random field from the merchant, so the nullifier reveals nothing; including `to` keeps references
  of different merchants apart.
- Decreases `from`'s balance as today (change via `self_delivery`), adds a `UintNote` for `to`, and emits a private
  event `Payment { payment_ref, amount }` to `to`. Both delivered with `MessageDelivery::offchain()`.
- Additive only: the token stays an ABI superset of upstream's. The new domain separator goes into `merchant_stamp`
  (or a sibling crate), mirrored in bridge-core and pinned by the keystone. New TXE tests go in `txe-manifest.txt`.
- Stamps, request openings and `paid(c)` are untouched; they keep serving the commitment flow.

### x402 flow

1. `402` with `extra: { nonce, paymentRef, … }`. The reference can be stateless (an HMAC of the nonce with a server
   key) or stored with the nonce; it expires with the nonce.
2. The buyer proves and sends `pay_private`, waits for inclusion, and retries with `{ txHash, paymentRef, messages }`.
   The client stores the messages durably until a 2xx, and resends them on retry.
3. Merchant verification:
   - Transaction mined and successful.
   - Feed the messages to the merchant's PXE through the token's `offchain_receive` utility, which processes them
     against the transaction's effects (note hash present).
   - Find the `Payment` event in that tx with the expected `paymentRef` and `amount >= price`.
   - Reference issued by this server, unexpired, not served before.
   - Persist the messages, then serve.
4. A presented `txHash` is useless to anyone but the buyer: without the matching reference and messages it verifies
   nothing. This is what blocks a third party from claiming someone else's payment.

### Merchant operations

- Append-only message store, written before serving and backed up.
- Merge job: a `transfer_private_to_private` to itself (no merchant proof, no announcement; the result is delivered on
  chain to itself). A transfer spends 2 notes, then 8 more per recursive call, so a busy merchant runs it often
  enough to keep note counts low.

### Offchain message lifetime

aztec-nr v6.0.0's offchain inbox (`messages/processing/offchain`) drops an unprocessed message once
`anchor_block_timestamp + MAX_MSG_TTL` has passed (`MAX_TX_LIFETIME + 7200` = 93 600 s, 26 h), and a processed one once
its block finalizes. So the merchant feeds every message in as it verifies the payment (well inside the window), and a
raw-message backup can only be replayed within 26 hours of the buyer's anchor. Consolidating at least every 12 hours
turns every received note into an onchain self-delivered note well before that window closes.

### To verify before implementation

- The aztec.js 6.0.0 API a merchant wallet uses to receive offchain messages and check them against the
  transaction (aztec-nr documents `offchain_receive`).
- That a received event is validated against the transaction, not only decrypted (aztec-nr pushes a commitment
  nullifier per private event and validates it per tx: expected to hold).
- Proving time and fee of `pay_private` against `transfer_private_to_commitment`, measured in the browser
  (`apps/showcase` proving harness).
