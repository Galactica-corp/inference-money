# Phase 2 lessons: each new check fails on its mutant

Each mutant is one local edit to `contracts/evm/src/`, run against `FoundryTester.test_harness_permit2EdgeAndFeeProbes` (the test that drives every new probe), then restored with `git checkout`. None was committed. The unmutated test passes (forge 1.7.1, 2 s warm). To attribute the "a probe misfired" sum, a temporary `console.log` of each ghost ran beside it and was reverted with the src.

| Class | Mutant | Expected failure | Observed |
|---|---|---|---|
| Refund seed | `depositToAztecPublic` passes `msg.sender`, not `_depositor`, to `_depositPublic` | the message names the payer, not the seeded refund (`misnamedMessages`, "a probe misfired") | as expected: "a probe misfired: 1 != 0", `misnamedMessages` = 1, every other ghost 0 |
| Permit digest | `permitDigest` hashes `deadline` before `nonce` | SP-23 (`router.permitDigest` differs from the spec digest) | as expected: "SP-23: router.permitDigest != the spec digest", on the first digest the probe checks |
| Withdraw debit (FeeOnTransfer admitted) | `withdraw` also requires the recipient's credit to equal `_amount` | "a withdraw under a recipient fee did not pay" (GL-28) | as expected: "a withdraw under a recipient fee did not pay: 0 != 1" |
| Direct pull (SenderSurcharge admitted) | `_pullExact` also requires the payer's debit to equal `_amount` | "surcharged direct deposits did not land" (GL-29) | as expected: "surcharged direct deposits did not land, or a router one ran: 6 != 8" |
| Deadline edge | `_requireUnexpired` refuses at `block.timestamp >= _deadline` | "a deposit at its deadline was refused" (GL-29) | as expected: "a deposit at its deadline was refused: 4 != 5" |
| Routed field rule | `_requireRecipient` skips the check when the router calls | GL-21 (`boundaryAccepted`, "a probe misfired") | caught earlier, by SP-08: the router deposit to the field max + 1 succeeded, so "SP-08: portal balance moved" (10000000 != 8000000) fired inside the probe before the ghost sum is read |

## What the last row says

The over-field probe treats the router's deposit as a call that must be refused, so it checks SP-08 (a refused call changes nothing) right after the deposit. A deposit that goes through moves the portal's balance, and SP-08 fails before GL-21's ghost is counted. Either property names the mutant; SP-08 fails at the deposit itself, so the trace points at it directly.
