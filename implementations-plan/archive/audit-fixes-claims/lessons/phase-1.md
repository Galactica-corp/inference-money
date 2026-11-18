# Phase 1: bridge-core verdict and send

- `locateDeposit` reads `nonceBitmap(owner, nonce >> 8)` on the draft's Permit2 at the finalized block, only on the path that would answer `not-deposited`. The test uses a nonce in word 5 at bit 255 and checks an unrelated bit and another word, so a wrong shift or a "any nonzero word" check fails.
- The rejection gate reads the signer's kind from `signerOf`: a bare address or a `json-rpc` account asks its user; a local account does not. The test sets `walletClient.account` on the fake, since the fake had none (every earlier refusal test exercised only the bare-address branch).
- Left `claim()`'s doc line alone: it sits next to the `FeeChoice` link another batch renames; the rule lives on `waitClaimFinalized`.
- Gate: `bun run lint`, `bun run typecheck`, `bun run --cwd packages/bridge-core test` (182 pass). One formatter miss (an Edit swallowed the space in `const view = <…>`), fixed.
