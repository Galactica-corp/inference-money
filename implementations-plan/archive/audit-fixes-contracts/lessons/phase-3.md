# Phase 3 — integration spec, docs, Codex fix loop

## Discovery spec

- A between-accounts step cannot use the second wallet as its read barrier: U's change from the merchant's authwit pull is self-delivered under the tag sender (merchant, U), which a wallet restored from U's secret alone does not scan. The harness wallet, which holds both, reads U instead.
- A tag query proves nothing until the step's tx is in a block the node indexed: `landed()` polls the receipt for a block number, and a balance read that sees the step's note follows before the query.

## Gate evidence

- `RUN_ID=contracts bun run test:integration` on the pre-rebase base: specs 49 pass across 12 files (the three discovery cases included, 2513 s under a host load near 150), clock specs 6 pass; the run reaped its network (no `contracts` row in the port registry).
- After the rebase onto dev `8701a42`: the discovery spec alone, 3 pass (283 s), its network reaped.

## Codex fix loop (`gpt-6.1-sol`, high)

**Round 1: 2 material (both Low), accepted.**
- GL-22 read "open to anyone up to the delay in force", the reverse of the guard, and still said the guardian "can only cancel": reworded (at or above; cancel is the guardian's only extra power).
- A31 promised recovery from the secret alone without naming the tag sender: qualified to txs the account itself sent.
- Non-material, accepted: the self-shield comment paraphrased its predicate; it now says why the caller must be `to`.
- Non-material, rejected: upstream's "Subtracts `amount`…" comment in `_decrease_private_balance`; the fork leaves upstream's lines alone.

**Round 2 (after the rebase onto dev `8701a42`): 0 new material findings; converged.** Round-1 fixes verified. The rebase folded the discovery bullets into dev's new "Announced once per pair" and "Hidden on chain" bullets rather than adding a second announcement bullet, and the spec's `exitToL1` takes the harness's `SendJournal`.
