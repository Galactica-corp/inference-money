# Phase 0: planning

- The drained-sponsor refusal is the node's own validator text (`Insufficient fee payer balance`, stdlib `tx/validator/error_texts.js`), raised in `sendTx`. The PXE and wallet-sdk never check the fee payer's balance, so an exit can learn of a dry sponsor only after the node received the tx.
- Asked the director: (1) honest drained sponsor on an exit becomes `ExitUnconfirmedError`, (2) `fee` required on payment calls only. Both answered yes; the error must name the tx's expiry, and a shorter exit lifetime goes to a follow-up issue.
- `exitToL1`'s `node` has no `sendTx`, so a proxy on it records nothing: the journal has to be the node the wallet was built on.
- Skipped appending `narration.mp3`/`narration.mp4` to `implementations-plan/.gitignore`: explainer is off and parallel batches would conflict on the same lines.
