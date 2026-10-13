# Integrating the compliant USDC

For wallets and x402 facilitators that hold, move or pay with the bridged USDC on Aztec. The token is aztec-standards' `Token` (v6.0.0-rc.1) plus a merchant list, so upstream calls keep working; what changes is who may do what. Every rule below is enforced on chain; `@galactica-net/inference-money-core` checks the same rules before anything is signed or proven, so a refused action costs no fee.

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

Whoever opens a request writes the log its recipient finds the payment by, so a request a payer opens for a merchant (`initialize_transfer_commitment`, or `transfer_private_to_public_with_commitment`) trusts the payer's log: a wrong one strands the payer's own payment, which the merchant then cannot find. bridge-core's flows have the merchant open its own requests.

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
| bridge | `Bridge is paused` | claims, returns and exits wait for the owner to resume; Ethereum withdrawals already made are unaffected |

The merchant admin's own refusals (`Only the merchant admin`, `Merchant already added`, …) are in `TOKEN_REFUSALS` too.

bridge-core raises typed errors before any signature or proof: `PublicDepositToUserError` (`assertPublicRecipient`), `NotFundingAddressError` (`claimBinding`, and inside `claim`), `BindConsentRequiredError` (inside `claim` and `waitClaimable`) and `ExitDestinationError` (inside `exitToL1`). `KeyHolderRequiredError` comes after the wallet signs a private deposit and before anything is sent: the signature is not the account's own key's in the form the router accepts (65 bytes, `v` 27 or 28, low `s`), which is what a contract wallet produces. A Permit2 approval made earlier stays.

On Ethereum the router and the portal revert with typed errors, all in bridge-core's ABIs: `ZeroAmount`, `AmountExceedsL2Max`, `RollupNotCanonical` (an Aztec rollup upgrade stopped deposits; withdrawals still pay), `SignerIsNotTheCaller` (router: a private deposit signed by anyone but its caller), `InvalidDepositor`, `AuthorizationExpired`, `AuthorizationUsed`, `SignerIsNotTheDepositor`, and OpenZeppelin's `ECDSAInvalidSignature`, `ECDSAInvalidSignatureLength`, `ECDSAInvalidSignatureS`. Permit2 checks a 7702 account through its delegate's ERC-1271, and the router's private leg also needs the account key's raw signature, so only a delegate that accepts that raw signature passes both. A delegate with no ERC-1271 gets Permit2's `InvalidContractSignature` (`PERMIT2_SIGNATURE_ERRORS`) or an undecodable revert of its own, on both legs; one that wants a wrapped signature (ERC-7739) fails the private leg either way. Their way in is the portal's signed path below.

## Installing from npm

`@galactica-net/inference-money-core` is bridge-core with the Aztec artifacts, the L1 ABIs and the testnet deployment
in it (`docs/publishing.md`). Pin an exact version and the same `@aztec-labs/*` release it depends on.
`TESTNET_MANIFEST` (`…/deployments`) is the manifest every flow below takes; `registerBridgeContracts(wallet, manifest)`
registers proxy, token and bridge, each checked to derive its recorded address.

## Deploying your own test instance

The shared testnet deployment's merchant list belongs to its admin, whose key is never shared. An integration that needs
merchants of its own (an x402 facilitator's `payTo`, say) deploys an instance: `deployTestBridge` (`…/deploy`) deploys
the portal and the router on L1 and proxy, token and bridge on Aztec from the package's own artifacts and bytecode, paid
through the canonical sponsor, and returns its manifest.

- **The deployer keeps both roles.** The account `deployerSecret` rebuilds is bridge owner and merchant admin: pass the
  returned `admin` to `addMerchants`, `scheduleMerchant`, `setMerchantDelay` and `setPaused` (each takes
  `{ wallet, m, node }`).
- **`usdc: "mock"`** deploys a 6-decimal token anyone can mint (`BRIDGE_EVM_ARTIFACTS.mockUsdc.abi`, `mint(to, amount)`),
  so the L1 key needs Sepolia ETH only. An address binds the bridge to that token instead (`TESTNET.usdc`: Circle's).
- **Tokens still come over the bridge.** The token's only minter is the proxy, so an account gets a balance by a deposit
  and its claim (`prepareDeposit`, `submitDeposit`, `confirmDeposit`, `waitClaimable`, `claim`), about the time of an L1 to L2 message.
- **Reuse the manifest.** The deploy proves and sends about ten transactions; store the JSON and read it back with
  `parseManifest`. Its `sourceCommit` is the shipped testnet deployment's, whose contract code these artifacts are.
- **Merchants bind first.** The rules are the real ones: list an account only after its own first private claim, or
  accept that whoever deposits to it first binds it (`docs/operations.md`, Merchants).
- **Tests only.** One key holds every role, and nothing is checked against a fresh build.

## Using bridge-core

- **When a flow returns**: once its L2 tx is checkpointed (`L2_DONE`). A UI can pass `wait: L2_PROPOSED`, as the showcase does, to answer about a minute earlier on testnet, at a proposed block the next tx can already build on. A prune can still undo that block, so read claims at the same tip (`isClaimConsumed(…, tipOf(wait))`), and forget nothing before finality. That includes a rejected exit: `ExitRevertedError.final` is false until its block is finalized, and until then a prune can re-include the tx, which may then burn. Keep its hash and read `locateWithdrawal` again.
- **Before a first private claim**, `claimBinding(wallet, manifest, recipient, depositor)` answers `"binds"`: show "this binds the account to 0x… for good", and pass `allowBind: true` to `waitClaimable` and `claim` only on consent. Without it both throw `BindConsentRequiredError` before anything is simulated or sent. `fundingAddress(wallet, manifest, account)` reads the binding; only a wallet holding the account's keys can.
- **A claim that reports `consumed-unknown`** found its message already consumed, by an earlier claim or by a return. It is never a mint: `depositFate(ticket, node, manifest)` finds the consuming tx and whether it emitted a withdrawal to the depositor.
- **Returns**: `waitReturnable`, then `returnDeposit(ticket, …)` gives an exit ticket for the depositor; `finishWithdrawal` pays it out on Ethereum, from any account. A depositor whose deposit someone else returned needs only the deposit ticket: `depositFate` names the return's tx, and `exitTicketFromTx(tx, depositor, amount, …)` builds the withdrawal. A tx that batches a claim with another return or exit of the same amount to the same address also reads as a withdrawal; finishing it pays the depositor either way.
- **Merchant exits** pass `asMerchant: true`; the bridge proves the sender's listing at the tx's anchor block. That read caps the tx's expiry before any pending switch-off, so an exit proven before one lands and sent after is refused by the node, burning nothing.
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

- **Visible.** Ethereum shows who deposited and who withdrew, with amounts. Aztec shows claim and withdrawal amounts (total-supply writes) and payment-request amounts (completion logs). A return shows no amount on Aztec, but its payout on Ethereum shows recipient and amount, which a public deposit links back to. The merchant list is public. The pause checks a bridge call enqueues reveal bridge use, and an account's first claim is distinguishable from later ones.
- **Inferable from the rules.** A private↔public transfer whose public side isn't a listed merchant has a merchant on its hidden side, or shields the sender's own tokens. An Ethereum withdrawal to an address that never deposited is a merchant's. Whoever knows a request's commitment can tell whether it was opened for a merchant, in which hour, and whether it is paid.
- **Linkable.** A tx that proves a merchant under a 1 h delay or with a change pending is recognisable by its expiry until the change lands. Between two merchants the proof reads the one whose read caps the tx later, so such a transfer stands out only when both would shorten it; a shield or unshield proves its public side whenever that is a merchant, and a merchant's private exit reads its own entry. So is a private payment through a stamp more than about an hour old, which bridge-core never sends.
- **Your node** learns which merchant each proof reads, and a paid request's stamp; with bridge-core's capsule it learns nothing about your own address. Without one, the token's probe asks it about both sides, unless the first is a merchant the call must prove or whose read already keeps the full day: a node query traded for a shorter expiry on chain. Run your own node to keep this from third parties.
- **Hidden.** Direct private transfers show only counts; with a 24 h delay their expiry equals any other tx's.
