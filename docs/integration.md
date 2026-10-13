# Integrating the compliant USDC

For wallets and x402 facilitators that hold, move or pay with the bridged USDC on Aztec. The token is aztec-standards' `Token` (v6.0.0-rc.1) plus a merchant list, so upstream calls keep working; what changes is who may do what. Every rule below is enforced on chain; `@inference-money/bridge-core` checks the same rules before anything is signed or proven, so a refused action costs no fee.

## Who may do what

Every Aztec account is either a **merchant** (on the token's list, curated by the merchant admin) or a **user** (everyone else).

| Action | If it's a user | If it's a merchant |
|---|---|---|
| Receive a deposit from Ethereum | Private deposits only. The account's first claim binds it, for good, to the depositor that deposit names, the Ethereum key holder that made it (its **funding address**); every later deposit must name that depositor. | Public or private deposits. Its first private claim binds it too, to whoever made that deposit, so a merchant binds its own treasury before it is listed: while listed it exits anywhere, but after a switch-off only there. |
| Claim a deposit | Only itself, privately. Its first claim binds it, so bridge-core claims it only with the owner's consent (`allowBind`). | Its private deposits only itself, as a user; its public ones anyone, and the tokens always land with it. It claims a private deposit before delivering what it pays for: until then the depositor, who holds its claim data, can return it. |
| Send privately | Only to a merchant, or into its own private balance. | To anyone. |
| Open a payment request | Only with a merchant as the recipient. | With any recipient. |
| Pay a request | Only one opened for a merchant (stamped), until its stamp expires a day later. | Any request. |
| Withdraw to Ethereum | Only privately, and only to its funding address. | Publicly or privately, to any address but zero and the portal. |

A stamp carries the hour its opening anchored in and expires 24 h to 25 h after that anchor (`stampDeadline`), and a switch-off does not end it sooner: a switched-off merchant is a user from then on, but a request stamped for it before the switch-off landed stays payable by the payer it names until the stamp expires, so under 25 h after the switch-off. A merchant payer can pay any request without a stamp, so no stamp's expiry binds it. A switch-off demotes, it does not freeze: the ex-merchant keeps its balance under a user's rules, so it can no longer pay users back privately: it refunds them from its public balance, or on Ethereum from its funding address.

Every request takes one payment, privately or publicly: the first positive completion, in whatever amount the payer sent. The recipient checks the amount; a private payment of zero is refused.

The payer is the completer the opening named, which is the caller of the payment, not necessarily the account debited. A contract named as completer must decide who may call it: one that lets anyone through lets anyone spend the request's one payment with one unit.

Whoever opens a request writes the log its recipient finds the payment by, so a request a payer opens for a merchant (`initialize_transfer_commitment`, or `transfer_private_to_public_with_commitment`) trusts the payer's log: a wrong one strands the payer's own payment, which the merchant then cannot find. It also announces the merchant as that payer's payee (see What each action makes public). So bridge-core's `openRequest` lets only a merchant open a request for another account (a pad: a refund, or a payment to another merchant), and refuses a user opening one for someone else before anything is proven; the merchant opens its own requests and shares the commitment. A merchant with a switch-off pending is refused too, as of the merchant list passed in, so pass one read just before the call. The token itself still accepts a payer's opening from an upstream caller.

A contract checking merchants through the token's `try_prove_merchant(account)` gets a proven `true`, or a `false` that is only the prover's word: use `false` to refuse, never to grant.

Integrations written against upstream keep every signature and lose four behaviours: a second completion of one commitment, a private completion of zero, a user's payment into a commitment stamped more than a day ago, and a shared relay as completer without an access rule of its own.

A deposit that can't be claimed (a public deposit to a user, or a private one from another address than the recipient's funding address) is **returned**: anyone holding its claim data consumes it on Aztec, nothing is minted, and the depositor is paid back on Ethereum once the epoch is proven. A merchant's public deposit is claimed, never returned, while the merchant is listed; while it is switched off the deposit is a user's, and can only be returned.

## Refusals

Each refusal is one exact string, exported from `bridge-core/src/rules.ts` (`TOKEN_REFUSALS`, `BRIDGE_REFUSALS`, with `tokenRefusalOf` / `bridgeRefusalOf` to read them out of an error) and checked against the Noir sources by a test.

| Contract | String | Meaning |
|---|---|---|
| token | `Transfer refused: neither sender nor recipient is a merchant` | a private transfer between two users |
| token | `Request refused: neither creator nor recipient is a merchant` | a request with no merchant on either side |
| token | `Payment refused: users may only pay into requests opened for a merchant` | a user paying a request with no live stamp: opened for a user, or more than a day ago |
| token | `Payment refused: the request's stamp has expired` | a private payment whose capsule names a stamp past its deadline |
| token | `Payment refused: the request is already paid` | a second payment into one request, through either path |
| token | `Payment refused: the amount is zero` | a private payment of zero |
| bridge | `Public claims are for merchants only` | a public deposit to a user: return it |
| bridge | `Only the recipient can claim privately` | a relayed private claim |
| bridge | `Deposit is not from this account's funding address` | a private deposit from another address than the bound one: return it |
| bridge | `A merchant's public deposit is claimed, not returned` | |
| bridge | `Public exits are for merchants only` | |
| bridge | `Withdrawals from a user account go only to its funding address` | also: an account that never claimed has no funding address yet |
| bridge | `Bridge is paused` | claims, returns and exits wait until the owner resumes, which nothing forces (`docs/operations.md`, Admin keys); Ethereum withdrawals already made are unaffected |

The merchant admin's own refusals (`Only the merchant admin`, `Merchant already added`, …) are in `TOKEN_REFUSALS` too.

bridge-core raises typed errors before any signature or proof: `PublicDepositToUserError` (`assertPublicRecipient`), `NotFundingAddressError` (`claimBinding`, and inside `claim`), `BindConsentRequiredError` (inside `claim` and `waitClaimable`) and `ExitDestinationError` (inside `exitToL1`). `KeyHolderRequiredError` comes after the wallet signs a private deposit and before anything is sent: the signature is not the account's own key's in the form the router accepts (65 bytes, `v` 27 or 28, low `s`), which is what a contract wallet produces. A Permit2 approval made earlier stays.

On Ethereum the router and the portal revert with typed errors, all in bridge-core's ABIs: `ZeroAmount`, `AmountExceedsL2Max`, `RollupNotCanonical` (an Aztec rollup upgrade stopped deposits; withdrawals still pay), `SignerIsNotTheCaller` (router: a private deposit signed by anyone but its caller), `InvalidDepositor`, `AuthorizationExpired`, `AuthorizationUsed`, `SignerIsNotTheDepositor`, and OpenZeppelin's `ECDSAInvalidSignature`, `ECDSAInvalidSignatureLength`, `ECDSAInvalidSignatureS`. Permit2 checks a 7702 account through its delegate's ERC-1271, and the router's private leg also needs the account key's raw signature, so only a delegate that accepts that raw signature passes both. A delegate with no ERC-1271 gets Permit2's `InvalidContractSignature` (`PERMIT2_SIGNATURE_ERRORS`) or an undecodable revert of its own, on both legs; one that wants a wrapped signature (ERC-7739) fails the private leg either way. Their way in is the portal's signed path below.

## Using bridge-core

- **Who pays the fee.** Every Aztec tx names its fee payer in public. Private claims, exits and returns default to the network's sponsor (`FeeChoice` `"sponsored"`); the payment calls (`openRequest`, `transferPrivate`, `payRequest`) have no default, so pass the sponsor's payment method in `fee`. `"account-public"`, in either place, makes the sending account pay from its own Fee Juice and names it as payer beside what the tx shows: a claim's amount, an exit's funding address, a return's depositor, a payment's merchant. The sponsor is what keeps private flows private, and bridge-core never falls back to the account on its own: while it cannot pay, claims, returns and exits not yet handed to the node throw `SponsorUnavailableError`, payments throw the wallet's fee error, and an exit already handed over is unconfirmed (below).
- **When a flow returns**: once its L2 tx is checkpointed (`L2_DONE`). A UI can pass `wait: L2_PROPOSED`, as the showcase does, to answer about a minute earlier on testnet, at a proposed block the next tx can already build on. A prune can still undo that block, so read claims at the same tip (`isClaimConsumed(…, tipOf(wait))`), and forget nothing before finality. That includes a rejected exit: `ExitRevertedError.final` is false until its block is finalized, and until then a prune can re-include the tx, which may then burn. Keep its hash and read `locateWithdrawal` again.
- **Keep deposit drafts and claim tickets for good**: each holds the only copy of its deposit's salt. `waitClaimFinalized`'s `"finalized"` is the node's word, and `reconcileDeposit`'s `"not-deposited"` (an error-free scan through a finalized block past the permit deadline, with the permit's Permit2 nonce unused at that block) is the L1 reader's. On either, mark the record final or archive it; never delete it.
- **Before a first private claim**, `claimBinding(wallet, manifest, recipient, depositor)` answers `"binds"`: show "this binds the account to 0x… for good", and pass `allowBind: true` to `waitClaimable` and `claim` only on consent. Without it both throw `BindConsentRequiredError` before anything is simulated or sent. `fundingAddress(wallet, manifest, account)` reads the binding; only a wallet holding the account's keys can.
- **A claim that reports `consumed-unknown`** found its message already consumed, by an earlier claim or by a return. It is never a mint: `depositFate(ticket, node, manifest)` finds the consuming tx and whether it emitted a withdrawal to the depositor.
- **Returns**: `waitReturnable`, then `returnDeposit(ticket, …)` gives an exit ticket for the depositor; `finishWithdrawal` pays it out on Ethereum, from any account. A depositor whose deposit someone else returned needs only the deposit ticket: `depositFate` names the return's tx, and `exitTicketFromTx(tx, depositor, amount, …)` builds the withdrawal. A tx that batches a claim with another return or exit of the same amount to the same address also reads as a withdrawal; finishing it pays the depositor either way.
- **Exits send through a journal.** `exitToL1` takes a `SendJournal` and refuses a wallet not opened through `sends.bindWallet` on `sends.node` (with a `PaymentGate` too, build the gate on `sends.node` and open the wallet inside both binds, as the showcase does). The journal notes each exit tx as it is handed to the node, so a send that fails after that point, including a fee rejection the node reports then, throws `ExitUnconfirmedError` with `sent`: the hash and expiry of every handed tx that may be this exit. Any of them can be included until its expiry, so never exit again: resume with `locateWithdrawal`, and treat one as gone only when `finalFate(node, hash, expiresAt)` says so. Both believe the node they read, so read your own.
- **Merchant exits** pass `asMerchant: true`; the bridge proves the sender's listing at the tx's anchor block. That read caps the tx's expiry before any pending switch-off, so an exit proven before one lands and sent after is refused by the node, burning nothing. `exitToL1` still reports it as `ExitUnconfirmedError`, the refusal being the node's word, with an expiry already past: `finalFate` calls it gone once a finalized block passes that.
- **A request takes one payment, and the token refuses a second only on chain**, after its proof (and, publicly, its fee). `payRequest` refuses before proving a request it has paid or is paying, or that was paid on chain; a facilitator that pays without `payments.ts` needs the same guard.
- **A stale request.** A private payment through a stamp caps the tx's expiry at the stamp's deadline. Within about an hour of the opening that cap is above the 23 h every tx gets; later, the shorter expiry would tell an observer the request's age. So `payRequest` refuses a private payment that would prove a stamp no longer fresh (a user's, or a merchant's whose own read would shorten the tx) as `PaymentRefusedError` `"stale"`, before proving and again on the proven tx; replace it through `payReplacingStale`, never by hand. It acts only on `stale`, which is told only to the attempt holding the request's reservation, and records the replacement on the stale request: every later attempt on that request is refused as `replaced`, and `payReplacingStale` follows it to the one replacement, so attempts sharing a store pay once between them. Never replace a request refused as in flight, uncertain, paid or replaced: its payment can still land, or already has. A public payment sets no cap and is not refused.

## Messages between the chains

Each L1↔L2 message content is `sha256ToField(abi.encodeWithSignature(signature, args…))`:

| Message | Signature | Arguments |
|---|---|---|
| Public deposit | `mint_to_public(bytes32,uint256,address)` | recipient, amount, depositor |
| Private deposit | `mint_to_private(uint256,address)` | amount, depositor; the recipient is bound through the claim secret |
| Withdraw (exits and returns) | `withdraw(address,uint256,address)` | L1 recipient, amount, L1 caller (zero: anyone may submit) |

The depositor is the address a deposit names: the Permit2 signer through the router, which for a private deposit must be the caller itself; the signer of a `FundingAuthorization` on the portal's signed private path; an explicit refund address on a direct public deposit. Vectors for all three formats are pinned in Solidity, Noir and TypeScript (`docs/architecture.md`).

USDC's blocklist, pause and upgrades reach the bridge as `docs/architecture.md` describes under "USDC's own controls": a withdrawal to a blocklisted recipient waits, unconsumed, until Circle clears it.

The portal refuses two deposits that no Aztec call could consume: an amount above u128 (`AmountExceedsL2Max`), and a public recipient above the largest field element (`RecipientExceedsFieldMax`), since an Aztec address is a field element. Encoding an `AztecAddress` (`toString()`, as bridge-core does) always fits. The cap is per deposit; the L2 supply is a u128 as well, so deposits summing past it could not all be claimed, which USDC's own supply keeps out of reach.

It cannot check a secret hash. A private deposit is claimed or returned only with the secret `prepareDeposit` derives from a claim salt and the recipient, so one made with any other hash stays escrowed for good, with no rescue path. Aztec's own portal tooling draws a plain secret and does not read this portal's events, and its `bridgeTokens{Public,Private}` now revert (both direct deposits take different arguments), so deposit through bridge-core or the signed path below.

### Depositing without the router

`depositToAztecPrivate(depositor, amount, secretHash, deadline, signature)` is for an integrator (a smart-account bundler, a custodian's periphery) that funds a deposit in someone else's name. The depositor signs EIP-712 `FundingAuthorization(address depositor,address submitter,uint256 amount,bytes32 secretHash,uint256 deadline)` in the domain `InferenceMoneyTokenPortal`, version `1`, this chain, this portal: bridge-core's `fundingAuthorizationTypedData` builds it, and `fundingAuthorizationDigest` on the portal returns its digest. bridge-core has no flow for this path.
- **The submitter** is the only caller the portal accepts it from (a 4337 account: the smart account), once (`AuthorizationUsed`), until `deadline` (`AuthorizationExpired`). Nothing cancels it sooner, so sign a short deadline.
- **The submitter pays**: the portal pulls `amount` from its caller with `transferFrom`, so the submitter approves the portal first, two txs unless batched.
- **The signature** is 65 bytes with `v` 27 or 28 and a low `s`; OpenZeppelin refuses yParity 0/1 and high `s`. It must recover to `depositor` (`SignerIsNotTheDepositor`).
- **The depositor derives its own claim salt** (`prepareDeposit`), and the secret hash it signs commits to it. Whoever holds the salt claims, binding that account to the depositor. Claim the message your own deposit sent, by its leaf index and depositor, never by secret hash: anyone can copy a published secret hash into a deposit of their own, and claiming that copy binds the account to them.
- **A return pays the depositor**, never the submitter.

`depositToAztecPublic(depositor, to, amount, secretHash)` names `depositor` as the refund address a return pays; it is unsigned, and zero, the portal and the router are refused (`InvalidDepositor`). So on this path `DepositToAztecPublic.depositor` is whatever the caller named, not proof of who paid.

**Smart-contract wallets** have no SDK private deposit: the router recovers its caller's key, which a contract does not have. They use the signed path above, with an owner EOA as the depositor. That one owner then holds the deposit outside the wallet's threshold: it derives the claim salt, a return pays it, and the funded account's exits go only to it. Their public deposits through the router are unchanged.

The bridge, in turn, refuses an exit no Ethereum call could pay: to the portal itself (`Recipient cannot be the portal`; its payout must lower its own balance), or naming a recipient or caller wider than 20 bytes, which the ABI would otherwise decode into an `EthAddress`.

## Following the contracts

An indexer reconstructs every admin-controlled value from the deployment's initial state plus events. The constructors emit nothing: read their state once (`bun run bridge verify` checks it), then follow:

| Contract | Events |
|---|---|
| TokenBridge (Aztec) | `PauseSet{paused}`, `OwnershipTransferStarted{owner, pending_owner}`, `OwnershipTransferCancelled{owner, pending_owner}`, `OwnershipTransferred{previous_owner, new_owner}` |
| Token (Aztec) | the merchant list: `MerchantAdded`, `MerchantOffScheduled`, `MerchantDelayScheduled`; its roles and delay: `MerchantAdminProposed{pending_admin}`, `MerchantAdminAccepted{previous_admin, admin}`, `MerchantGuardianScheduled{guardian, effective_at}`, `MerchantDelaySet{delay, guardian_delay_effective_at}` |
| TokenPortal (Ethereum) | `PortalInitialized` (the whole binding, Outbox included), `DepositToAztecPublic`, `DepositToAztecPrivate`, `Withdraw(recipient, amount, callerOnL1)` |
| Permit2DepositRouter (Ethereum) | `Deposit` |

Aztec events are public logs: read them with the SDK's `getPublicEvents` and bridge-core's `contractEvent(artifact, name)`; the Ethereum ones are in bridge-core's `TOKEN_PORTAL_ABI` and `PERMIT2_DEPOSIT_ROUTER_ABI`. A refused change emits nothing, and an event naming a replaced holder (`previous_owner`, `previous_admin`, a cancelled `pending_owner`) read it before the write. `Withdraw.amount` is the reserve's debit, not what the recipient nets under a USDC fee; `callerOnL1` is the caller the message was hashed with, zero when anyone could execute it.

## What each action makes public

- **Visible.** Every tx's fee payer: the sponsor, or the account itself on `"account-public"`. Ethereum shows who deposited and who withdrew, with amounts. Aztec shows claim and withdrawal amounts (total-supply writes) and payment-request amounts (completion logs). A return shows no amount on Aztec, but its payout on Ethereum shows recipient and amount, which a public deposit links back to. The merchant list is public. The pause checks a bridge call enqueues reveal bridge use, and an account's first claim is distinguishable from later ones.
- **Inferable from the rules.** A private↔public transfer whose public side isn't a listed merchant has a merchant on its hidden side, or shields the sender's own tokens. An Ethereum withdrawal to an address that never deposited is a merchant's. Whoever knows a request's commitment can tell whether it was opened for a merchant, in which hour, and whether it is paid.
- **Announced once per pair.** The first note an account ever sends another announces itself under a tag anyone can compute from the recipient's address: a user's first private payment to a merchant names that merchant, a merchant's first refund or pad to a user names that user, and an opening for another account names it. Later notes between the same two accounts announce nothing new. A payment into a request announces nothing: its log is tagged by the request, not by a handshake. A note pulled by authwit to its caller announces under the caller too. A note an account proves for itself announces nothing: a claim, change, a send or a shield to itself.
- **Your wallet** finds a note it proves for itself by scanning its own accounts as senders, so only from a tx one of its own accounts sent. Change from a tx another account sent (spending yours by authwit, or under the wallet's `sendMessagesAs`) is tagged under that account, which a wallet restored from your secret alone does not scan. An account whose keys several parties hold trusts whoever spends it to deliver its change, and a contract recipient anyone can call trusts its caller with its claims and its shields to itself.
- **Linkable.** A tx that proves a merchant under a 1 h delay, or with a pending change that shortens its rounded expiry, is recognisable by that expiry until the change lands. Between two merchants the proof reads the one whose read caps the tx later, so such a transfer stands out only when both would shorten it; a shield or unshield proves its public side whenever that is a merchant, and a merchant's private exit reads its own entry. So is a private payment through a stamp more than about an hour old, which bridge-core never sends.
- **Your node** learns what your wallet asks it in order to prove, capsule or not: a slot derived from your account's address on every tx, the same each time, so it links all your txs and names the account to a node that knows the address; which deposit a private claim or return consumes (the message's witness, asked with its nullifier); which settled notes a tx reads, and so the txs that created them; which of your earlier sends went to the same recipient, and their order (the wallet looks their tags up together); each merchant a proof reads; and a paid request's stamp. Only your own node keeps this from third parties; the testnet manifest's is a third party's. bridge-core's capsules spare only the token's hint: without them, the probe also asks the node about both sides, unless the first is a merchant the call must prove or whose read already keeps the full day, a node query that buys the later expiry on chain. A merchant's exit (`exitToL1` with `asMerchant`) carries no capsule and proves the merchant's own entry.
- **Hidden on chain.** Direct private transfers show an observer of the chain only counts, though a note an account proves for itself emits no delivery nullifier, so a send or shield to oneself has one nullifier fewer than one to another account; with a 24 h delay and no change pending their expiry equals any other tx's.
