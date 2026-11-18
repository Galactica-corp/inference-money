# Recon: audit-fixes-claims

Read against `dev` at `ad77d10`. One reuse sweep (Explore, Sonnet) plus the driver's own read of every file the plan edits. No open GitHub issues touch this work (`gh issue list --state open` is empty).

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| Permit2 `nonceBitmap` ABI | Solidity only: `contracts/evm/src/interfaces/ISignatureTransfer.sol:31`. No TS entry (searched `nonceBitmap\|invalidateUnordered\|permit2\|ISignatureTransfer` over `.ts/.tsx/.json/.sol`). | build new: one entry in `abi.ts`, pinned in `abi.test.ts` with the existing `expectPinned(…, forgeAbi("ISignatureTransfer"))` |
| Word and bit of a Permit2 nonce | `randomPermitNonce` (`permit2.ts:77`) draws a random 256-bit nonce; nothing splits it. | build new, inline in `locateDeposit` (`nonce >> 8`, `1 << (nonce & 0xff)`): three lines, one caller |
| Local key vs JSON-RPC wallet | `signerOf(l1)` (`types.ts:22`) returns the wallet client's own `Account` or the bare address. No `type === "local"` anywhere. | reuse `signerOf`; the account's `type` tells a JSON-RPC wallet from a local key |
| A record flag kept instead of a delete | `claimed: z.literal(true).optional()` in `apps/showcase/src/demo/tickets.ts:16` | adapt: `archived` and `final` follow the same literal-flag shape; the schema is strict, so both must be declared there |
| An archive file the resume ignores | `StateDir` (`packages/deployer/src/run-state.ts`): `read`, atomic `write`, `remove`. No rename. `demoSetup` resumes iff `setup.json` exists (`demo.ts:221`). | adapt: add `StateDir.rename` (atomic `renameSync` + `syncDir`, like `write`) |
| Keeping an abandoned draft | Nothing named archive/abandon in any record (searched `archive\|abandon\|stale\|isFinal\|\bfinal\b`). `castDeposit` has three callers: showcase (never a prior), `demo.ts` `seedTicket`, `smoke.ts` deposit step. | build new: a `PriorDraft` callback in `castDeposit`; the deployer keeps abandoned drafts in a file named by permit nonce (`keepAbandonedDraft`) |
| A pending-record row in the showcase | `Payouts` (`LiveMode.tsx:112`): a titled `<section>` with `<li data-testid>` rows; `LiveEngine.payouts` → `useChains` state → refresh after each run. No row has a button yet. | adapt: an `ArchivedDeposits` section beside it, fed the same way; the button reuses the Reset link's classes |
| Seeding page state in e2e | No spec writes `localStorage`; state comes from driving the UI and reloading. `rpc.ts` can hold and abort one request (`holdNext`), not rewrite a response. | adapt: add a response rewrite to `recordRpc`, the run's view of a wrong L1 reader |
| Real Permit2 on a local chain | `packages/integration` deposits specs run the router against the local network's Permit2. | reuse for the one real-data test of the nonce read |

## Deletions and overwrites this work removes

- `apps/showcase/src/live/actions.ts:158` `stillClaimed`: drops the record on a finalized hit.
- `apps/showcase/src/live/actions.ts:170` `fromDraft`: drops the record on `not-deposited`.
- `packages/demo/src/flows.ts:136-141` `castDeposit`: a prior read as `not-deposited` is replaced; the caller's `persist` overwrites it (`demo.ts:96-99`, `smoke.ts:178-181`).
- `packages/deployer/src/demo.ts:136` `runSetup`: `store.clear()` removes `setup.json`, the tickets' only copy.
- `packages/bridge-core/src/deposit.ts:204`: any rejection-shaped send error clears `submission`, a local key's included, after which `reconcileDeposit` answers `not-deposited` with no read.

Kept on purpose: `claimableEntry` drops a record that no longer decodes (local corruption, not a remote answer); exit records (`payouts.ts`) are another batch's surface.

## Conventions to match

- bridge-core tests fake the `PublicClient` per method (`deposit.test.ts` `chain()`); a new read needs a stub there.
- Showcase action tests run under `// @vitest-environment node` with `vi.mock` of bridge-core; `Tickets` is a `Map`-backed fake. Component tests fake the `LiveEngine` (`LiveMode.test.tsx` `fakeEngine`), so a new engine method needs a default there.
- Copy states what happened and what to do next ("That deposit is still confirming on Ethereum; try again in a minute.").

## Docs that say a record goes at finality

`packages/bridge-core/src/claim.ts:219,225-229,250`; `docs/integration.md:60`; `docs/architecture.md:40`; `docs/operations.md:101`; `docs/assurance-map.md` row A11; code comments `deposit.ts:67`, `tickets.ts:15,36`, `actions.ts:153`, `demo.ts:116-119`, `claim-finality.ts:11-14`, `flows.ts:123`.

## Collision risks

- `abi.ts` (deploy-verify adds a portal view): the new entry is its own export, appended after the router ABI.
- `actions.ts` (deploy-verify's withdraw-only mode), `demo.ts` (the fee-juice manager), `claim.ts` (sdk-fees renames `FeeChoice`), `docs/integration.md` (every batch): edits stay inside the functions and lines named above.
