# Recon: audit-fixes-sdk-fees

Read against `dev` at `ad77d10`. One batched reuse sweep (Sonnet) plus the driver's own reads.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Fee payer for claims, exits, returns | `FeeChoice` and `feeFor` (`bridge-core/src/claim.ts:30-36`), imported by `exit.ts` and `return.ts` | adapt: rename `"wallet-default"` to `"account-public"`, document what it publishes |
| Fee payer for payments | `SendFee` and `ListOptions.fee?` (`payments.ts:158-168`), passed through at `:198`, `:221`, `:506` | adapt: required, `{ paymentMethod } \| "account-public"`, one mapping helper |
| Sponsor-less manifest in `verify` | `verifyEnvironment` (`deployer/src/verify.ts:228`): passes with `none on this network` | adapt: fail unless `m.network === "local"`; export `verifyEnvironment` for a unit test |
| Merchant status of the opener | `merchantStatus(list, account)` (`merchants.ts:133`) | reuse as is inside `openRequest`'s `withFreshList` attempt |
| Hash of a tx before the node sees it | `PaymentGate`'s node proxy (`payments.ts:325-328`, payment-specific); `recordingNode` (`packages/demo/src/sent.ts:21`, in demo, which bridge-core cannot import); the showcase's `onNextSend` slot (`apps/showcase/src/demo/wallet.ts:139`) | build new in bridge-core: `SendJournal`, a node proxy that records every handed-off hash, with `bindWallet`/`isBound` mirroring `PaymentGate` |
| Wallet bound to a proxy node | `PaymentGate.bindWallet` / `isBound` (`payments.ts:332-340`), refused in `payRequest` (`:494`) | mirror the pattern in `SendJournal` (two short methods; no shared base) |
| Test doubles | `fakeWallet` (`bridge-core/src/test/fake-wallet.ts`), `MANIFEST` fixture, `exit.test.ts` helpers `boundWallet`, `intent`, `effectNode` | reuse; new exit tests drive `sends.node.sendTx` from the fake wallet's `send` hook |
| Type tests | none in the repo (searched `@ts-expect-error`, `expectTypeOf` under packages and apps) | build new: `@ts-expect-error` lines in `payments.test.ts` and `claim.test.ts`; `src` is in each tsconfig's `include`, so `bun run typecheck` checks them |

## Callers the change reaches

- `ListOptions` without a fee today: only `payments.test.ts` (`:164`, `:198`, `:211`, `:407`). Every product caller passes the sponsor: `deployer/src/smoke.ts:197,206`, `apps/showcase/src/live/actions.ts:87-89`, `apps/showcase/src/proving/check.ts:39`, `packages/demo/src/flows.ts:182`, `packages/integration/test/requests.test.ts:26,32`, `packages/integration/clock/stamp-expiry.test.ts:39,49`.
- The literal `"wallet-default"`: `claim.ts:30,33` and `claim.test.ts:62` only. `FeeChoice` type users: `exit.ts`, `return.ts`, `packages/integration/test/actors.ts:10,99` (`payFor`).
- `exitToL1`: `exit.test.ts` (12 calls), `deployer/src/smoke.ts:234,238`, `apps/showcase/src/live/actions.ts:340`, `packages/integration/test/exits.test.ts:24`, `exit-rules.test.ts:21`, `packages/integration/clock/merchant-exit-expiry.test.ts:22`.
- Wallets built on a `PaymentGate`: `apps/showcase/src/demo/wallet.ts:150-153`, `deployer/src/session.ts:87-93`, `packages/integration/test/harness.ts:161-162`. Each needs the journal under its gate.
- `openRequest` openers: every product flow opens its own request (`actions.ts:266,286`, `smoke.ts:196`, `check.ts:61`); `requests.test.ts:79,134` are merchant-opened pads, which stay allowed.

## Facts that shape the design

- The wallet proves, computes `tx.getTxHash()`, then calls its node's `sendTx` (`wallet-sdk/dest/base-wallet/base_wallet.js:368-386`). Only a proxy on that node sees the hash before the node does.
- The fee-balance refusal text (`Insufficient fee payer balance`) exists only in stdlib's tx validators (`stdlib/dest/tx/validator/error_texts.js:3`), which the node runs in `sendTx`; PXE and wallet-sdk never check it. So a drained sponsor surfaces after the journal saw the tx.
- `exitToL1`'s `node` (`ExitNode`, `exit.ts:41`) has no `sendTx`: wrapping it records nothing. The journal must be the node the wallet was built on.
- `manifest.ts:32` knows only `local` and `testnet`; `local.ts:63` always writes `sponsoredFpc`, so the `verify` guard bites a hand-edited testnet manifest today and any new network value later.
- No verify unit test exists; the keyed integration test (`operator.test.ts`) needs a live network.

## Open work

`gh issue list --state all --search fee` returns nothing. `implementations-plan/follow-ups.md:24` holds the mainnet fee path (O-12); it stays there, and the docs name it as Galactica's decision.
