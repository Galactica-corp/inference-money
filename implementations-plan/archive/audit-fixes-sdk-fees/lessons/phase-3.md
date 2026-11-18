# Phase 3: the send journal and exits

- The journal sits under the payment gate's node: `new SendJournal(recordingNode(...))`, then `new PaymentGate(sends.node, …)`, with the wallet opened inside both binds. The harness, the deployer session and the showcase demo wallet all build it this way, so one wallet serves `payRequest` and `exitToL1`.
- The showcase demo wallet already had a local `journal` (the `onNextSend` hook list), so the new one is named `sends`, as in the harness and session.
- The fake wallet's send hook became async-capable (`await hooks.send?.(tx)`), so a unit test can hand a tx to the journal's node and then throw, which is the post-hand-off failure the fix covers.
- Unit tests cannot tell whether the matchers match a real tx; the integration spec drops the node's reply after it forwards a real private and a real public exit, and locates each `sent` hash's withdrawal.
- Gate: lint (after `biome check --write` sorted one import and reformatted two files), typecheck and every suite green except deployer `cli.test.ts` "never loads a .env…" on its 5 s timeout again (load average 291). With `--timeout 30000` the file passes 3/3.
