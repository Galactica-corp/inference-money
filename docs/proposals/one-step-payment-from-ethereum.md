# Proposal: pay a merchant directly from Ethereum, in one step

Status: accepted (2026-11-05); implemented in this repository (bridge `claim_split`, `return_split`, `claim_change`, `return_change`; bridge-core `split.ts`), awaiting the testnet deploy and the aztec-x402 integration. Affects the inference-money bridge and token (new claim functions), bridge-core, and
aztec-x402 (a new payment variant). Builds on the private-payment proposal (`private-payment-amounts.md`) for the
payment reference.

## Summary

A buyer holding USDC on Ethereum can today only pay a merchant after three steps: deposit to Aztec, claim on Aztec,
then pay. We propose a **split deposit**: the buyer makes one Ethereum deposit of a round amount, and its terms
(merchant, price, payment reference) are sealed into the deposit itself. The merchant serves as soon as the Ethereum
transaction is confirmed, collects the price on Aztec later, and the rest of the deposit waits as change the buyer
collects into their own Aztec wallet whenever they want.

## Why change it

- **Too many steps.** Deposit, claim and pay are separate actions, and the claim can only happen once the deposit has
  crossed to Aztec, which takes several minutes.
- **Too slow for x402.** A first-time buyer waits minutes before the merchant can be paid.
- **Ties users to our website.** Automating claim and pay needs a wallet embedded in our site that stays open. Users
  with their own Aztec wallet (self custody) would have to run these steps by hand.
- **A simple direct deposit to the merchant is not acceptable:** it either doesn't work today (a merchant cannot claim
  private deposits from many buyers) or publishes buyer, merchant and amount on Ethereum.

## What we propose

1. The merchant's 402 response names its Aztec address, the price and a payment reference.
2. The buyer deposits a **round amount** (for example $10) on Ethereum: one signature, one transaction. The deposit's
   secret commits to the merchant, price, reference and a hidden claim on the change. No Aztec wallet is involved.
3. The buyer sends the deposit's terms to the merchant with the retried HTTP request.
4. The merchant checks the deposit on Ethereum and serves the request after a few confirmations (seconds). From then
   on the deposit can only be split as agreed; nobody can redirect or refund it.
5. A few minutes later, in the background, the merchant claims on Aztec: the price goes to the merchant, the change is
   recorded for the buyer.
6. Whenever they like, the buyer collects the change into their own Aztec wallet with one ordinary transaction. From
   then on they pay from that balance privately, without Ethereum.

## Implications

**Privacy**
- Ethereum shows the buyer's address and a round deposit, as any top-up does today. It shows neither merchant nor
  price.
- Aztec shows that a deposit of that amount was claimed (as today). The price, the merchant and the buyer's Aztec
  account stay hidden; collecting the change publishes nothing.
- The merchant learns the buyer's Ethereum address (it is on Ethereum anyway), but not their Aztec account.
- **A deposit of exactly the price leaks it**, and with it, likely the merchant. Clients should offer a few fixed
  amounts and never deposit the bare price.

**Buyer**
- One Ethereum confirmation, and the request is served within seconds instead of minutes.
- No Aztec wallet needed to pay; any Aztec wallet (embedded or external) can collect the change later. Nothing depends
  on our website staying up, as long as the buyer keeps the deposit's data (see technical details for making it
  recoverable).
- The change is not spendable until collected. Collecting it binds the Aztec account to the depositing Ethereum address
  on first use, as every claim does today.

**Merchant**
- Serves on Ethereum confirmation, and so bears the small risk of an Ethereum reorganisation or a bridge pause before
  its claim. It chooses its confirmation depth; for inference-sized payments a few blocks suffice.
- One Aztec claim transaction (fee and proof) per paid deposit, which it can run in the background.
- Needs an Ethereum connection to verify payments.

**Engineering**
- Ethereum contracts: no change.
- Bridge: two new claim functions. Token: two new minting functions. Existing functions are untouched.
- A new kind of deposit message and an IOU supply invariant warrant a careful security review.
- aztec-x402: a new payment variant; bridge-core: deposit building and the merchant's verification.

## Alternatives considered

| Option | Why not |
|---|---|
| The buyer's client claims and pays automatically on Aztec | Minutes of waiting, the site must stay open, and external wallets cannot run it unattended. |
| An authorization (authwit) letting the merchant claim and pay for the buyer | Not possible: spending the buyer's funds and binding the account need the buyer's own keys, not just consent. |
| Deposit directly to the merchant, publicly | Publishes buyer, merchant and amount on Ethereum. |
| Deposit directly to the merchant, privately | Today's bridge cannot accept it, and the deposit amount (the price) would name the merchant. |
| Prepaid credit held by the merchant | Simple and fast, but the merchant holds the user's money: no self custody. |

## Decisions

1. **Fixed deposit amounts: $1, 5, 10, 50, 100, 500, 1000 and 5000.** USDC has 6 decimals, so $1 is 1 000 000 base
   units. The SDK only builds deposits of these amounts; the contracts accept any amount, so a hand-built exact-price
   deposit still leaks its price.
2. **Confirmation depth: 2 Ethereum blocks (about 24 s) by default**, configurable per merchant, with an optional price
   threshold above which the merchant waits for finality. The merchant risks only the price of the one request it served
   (a reorg can undo the deposit before its claim), not the deposit. Reorgs deeper than one block have been extremely
   rare on Ethereum since the Merge, and an attacker would have to control block proposals to cause one on purpose,
   which is far costlier than an inference request. Waiting for finality (about 13 minutes) would undo the benefit of
   the feature.
3. **The buyer's salts are random and kept in the deposit draft**, as for today's deposits. The SDK can export and
   import the draft, so any client or wallet can collect the change. Deriving them from an Ethereum signature is left
   for later.

## Concerns

Found while implementing; none blocks the testnet deploy, each needs an answer before mainnet.

1. **The total supply now depends on the bridge's bookkeeping.** From a split claim on, the supply counts the whole
   deposit, part of it change still owed to the buyer. Three new minter-only token functions keep the books, and only
   the bridge can reach them. The contract tests check the supply after every flow, and the local-network tests check
   that the portal's reserve still covers it, but this is the most sensitive change: it needs an external security
   review before mainnet.
2. **The merchant serves before its claim.** Once the deposit is two blocks deep on Ethereum, the merchant serves; until
   its claim lands on Aztec minutes later, an Ethereum reorg, a bridge pause or a rollup upgrade can delay or undo it. The
   exposure is the price of one request. Merchants can require more confirmations above a price threshold.
3. **A deposit made before the merchant's listing can be taken back.** A deposit is returned to its depositor if the
   merchant can be proven not listed at any point after the deposit. A deposit sent before the listing landed could
   therefore be returned after the merchant served it. Merchants must accept split deposits only once their listing has
   landed; the x402 integration has to enforce that.
4. **A merchant switched off loses unclaimed deposits.** Once a switch-off takes effect (24 hours after it is scheduled),
   the buyer can return any deposit the merchant has not claimed yet. Merchants should claim promptly.
5. **The fixed amounts are enforced by the SDK only.** The contracts accept any amount, so a hand-built deposit of
   exactly the price shows the price on Ethereum, and with it, likely the merchant.
6. **The buyer must keep the deposit's data.** Without the draft's salts the change can never be collected; it stays
   counted in the supply and locked. The payment itself is unaffected.
7. **The fallback paths leak.** Returning the change to Ethereum publishes its amount, which with the deposit gives the
   price. A split claimed by anyone but the merchant delivers the merchant's note on chain, which announces the merchant.
8. **One claim per deposit.** Each split deposit costs the merchant one Aztec transaction (sponsored fee, a proof). Its
   proving time and the sponsor's capacity at volume are not measured yet.

---

## Technical details

### Deposit secret

No portal change: the router's Permit2 witness and the portal take any `secretHash`.

```
change_commitment = poseidon2([buyer_aztec_address, change_salt],                    DOM_SEP__SPLIT_CHANGE)
secret            = poseidon2([merchant, price, payment_ref, change_commitment, salt], DOM_SEP__SPLIT_CLAIM)
secretHash        = computeSecretHash(secret)
```

The message content stays `mint_to_private(amount, depositor)`. The new separators are pinned in the keystone and
must differ from `DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET`, so `claim_private` and `return_deposit_private` (which
derive their secret as `poseidon2([salt, recipient])`) can never consume a split deposit, and `claim_split` never a
plain one. `check-sole-consumer.sh` gains the new consumer and this separation.

### `claim_split` (bridge, private)

Arguments: `amount, depositor, message_leaf_index, merchant, price, payment_ref, change_commitment, salt`.

- Not paused; `0 < price <= amount`.
- `try_prove_merchant(merchant)` must return `true` (a private read; caps the tx's expiry like every merchant read).
- Rebuilds the secret, consumes the message (content `mint_to_private(amount, depositor)`).
- Mints `price` to `merchant` and raises total supply by the full `amount` in **one** public write: two writes would
  publish price and change separately.
- If `amount > price`, pushes the IOU nullifier
  `iou = poseidon2([change_commitment, amount - price, depositor, secret, message_leaf_index], DOM_SEP__SPLIT_IOU)`.
  The leaf index makes it unique per deposit: two deposits with the same terms would otherwise share one IOU, and the
  second claim would fail for good.
- Callable by anyone, so the buyer can trigger it if the merchant never does. When the caller is the merchant, its
  note is delivered to itself and announces nothing; otherwise it is delivered onchain to the merchant, which
  announces the merchant (the rare fallback case).

### `claim_change` (bridge, private)

Arguments: `amount_change, depositor, message_leaf_index, secret, change_salt, bind`; caller is the buyer.

- Rebuilds `change_commitment` from `msg_sender` and `change_salt`, then `iou`; asserts the IOU nullifier exists
  (settled, as payments prove request stamps today).
- Pushes `poseidon2([iou, change_salt], DOM_SEP__SPLIT_IOU_SPENT)`: each IOU is collected once. `change_salt` keeps the
  merchant, who knows `iou`, from seeing when the change is collected.
- Binds or checks the funding address against `depositor`, exactly like `claim_private`'s `bind`.
- Mints `amount_change` to the caller **without** changing total supply (already counted in `claim_split`), delivered
  to itself (no announcement).

### Token and minter proxy

- Three minter-only functions, reached only by the bridge through the proxy: `mint_split_to_private` (mints the price,
  raises supply by the whole deposit in one write), `mint_reserved_to_private` (mints change without touching supply)
  and `release_reserved` (lowers supply when change is returned to Ethereum). They add no trust: the minter can already
  mint anything.
- New invariant: `total_supply = Σ notes + Σ public balances + Σ uncollected IOUs`. Extends the existing supply
  properties and their tests.
- Additive only: the token stays an ABI superset of upstream's.

### Merchant verification (aztec-x402)

The buyer sends `{ l1TxHash, amount, depositor, price, paymentRef, changeCommitment, salt }`. The merchant:

1. Checks `price` and `paymentRef` against what it issued (unexpired, not served).
2. Recomputes `secretHash` with its own address.
3. Finds the `DepositToAztecPrivate` event in `l1TxHash` with that `secretHash`, `amount >= price`, the stated
   `depositor`, and the configured confirmation depth.
4. Stores the claim data durably, serves, and queues `claim_split`, which runs once the message is consumable on Aztec.

### Failure paths

- **Merchant switched off (or never listed) before claiming:** `claim_split` cannot prove it. A `return_split` refunds
  the depositor on Ethereum after proving, privately, that the named merchant is not one at the anchor block: a
  non-inclusion proof of its list entry, or its switch-off entry. The anchor always follows the deposit (consuming the
  message proves its inclusion), and list entries are never removed, so an old anchor cannot fake an unlisted merchant.
- **`price > amount`:** unclaimable by construction; the SDK refuses to build such a deposit, and `return_split`
  covers one built by hand.
- **Merchant never claims:** anyone holding the data (the buyer) runs `claim_split`; the merchant still gets the price.
- **Buyer bound to another Ethereum address:** `claim_change` refuses, as `claim_private` does. A `return_change` pays
  the change back to the depositor on Ethereum and lowers supply by it. That publishes the change, and with the deposit
  the price, so the SDK warns before using it.

### Buyer's data

The buyer needs `salt`, `change_salt` and the deposit's coordinates to collect the change. To avoid depending on our
site, derive both salts from a deterministic signature by the buyer's Ethereum key over the deposit's nonce, so any
client can recover them from the key and the Ethereum event. `buyer_aztec_address` comes from the buyer's wallet.

### To verify before implementation

- Proving a settled nullifier from the bridge for the IOU (the token does the same for stamps, so expected to work).
- Fee and proving time of `claim_split` for a merchant claiming many deposits.
- How external Aztec wallets let a site request `claim_change` (an ordinary contract call; expected to work with any
  wallet that accepts dApp calls).
