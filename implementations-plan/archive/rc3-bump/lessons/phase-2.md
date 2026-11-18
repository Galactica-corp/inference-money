# Phase 2 — Noir lane

## Refund commitment (D3 = C, amended)

- `transfer_private_to_public_with_commitment` initializes for `from`, completer `msg_sender()`, and pushes no stamp,
  pad or request effect; `_prove_merchant_side(to, from, true)` and its NEITHER refusal stay.
- Doc text: upstream rc.3's, plus one line (never stamped, so only a merchant source completes it, once). Other
  upstream rc.3 doc-comment edits (initialize, the completions, mint_to_commitment) are doc-only and were not synced.
- Tests: upstream's `…_refunds_from` (dex listed in that test only), `…_failure_wrong_completer` (the paid merchant is
  not the completer), `a_merchant_refunds_a_users_commitment_unstamped` (no stamp, pad or effect; refund from m1 under
  its authwit), `a_user_cannot_pay_into_a_users_refund_commitment` public and private (a zero-amount opening through
  Bob's proxy, then Bob pays: user to user if the commitment were stamped). `both_openings_…` → `an_opening_…`
  (initialize only); `with_commitment_to_a_merchant_is_stamped_and_from_a_merchant_padded` removed (its premise is
  gone).
- TXE: `env.deploy` takes `&mut self`, so a helper taking `MerchantWorld` by value cannot deploy; deploy in the test.
- Guard: `keeps_published … transfer_private_to_public_with_commitment to from recipient`, the owner regex
  (`_initialize_transfer_commitment(from,`), no `_push_request_stamp` in the body; three mutants, the side-swap and
  re-stamp ones anchored on the function (the file's first `(to, from, true)` is `transfer_private_to_public`'s).

## pre == post (aztec-nr rc.3 / protocol_types rc.6)

- `a_cancelled_entry_reads_unmarked`: after a switch-off and its cancel, the read caps at `MERCHANT_MAX_DELAY − 1`
  from the anchor, as a settled entry's.
- Comments that said a cancel or a switch back on marks the entry: main.nr (`schedule_merchant_off`,
  `cancel_merchant_change`), test/merchants.nr (two; the plan listed one), and the test name
  `cancel_refuses_to_re_mark_a_cancelled_entry` → `cancel_refuses_a_cancelled_entry`.
- The cancel's refusal when nothing is pending stays; its reason is now hygiene (a mistaken cancel fails loudly).

## Formatting

- `nargo fmt --check` is not clean on the base and is not gated; new code is hand-formatted to its style only.

## Gate

- `bun run test:noir`: token 188, token_bridge 85, keystone 20 named tests passed. Guards and their self-tests (sole
  consumer 48 mutants, stamp constraint 18), the ABI-superset test, `contracts/aztec` typecheck and lint: exit 0.
- Verbatim-port check: with `_push_request_stamp(commitment, side)` re-added to the refund function and the token
  rebuilt, `a_merchant_refunds_a_users_commitment_unstamped` and both `a_user_cannot_pay_into_a_users_refund_commitment`
  twins fail (the user→user payment lands); `…_refunds_from` still passes (its dex is listed). Source and artifact
  restored byte for byte.
