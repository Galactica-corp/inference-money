#!/usr/bin/env bash
# Static tripwire for what no TXE test can see (TXE runs no kernel and ignores a tx's expiry): a user's private payment
# through a request's stamp proves the stamp settled and caps the tx's expiry at the stamp's deadline. Inside
# `_prove_payment_side`'s FIRST branch, at that branch's own depth and in this order, it must
#   bind `let stamp_nullifier = stamp(commitment, bucket)` and `let deadline = stamp_deadline(bucket)`,
#   assert the siloed stamp exists as a SETTLED nullifier, and set the tx's expiry to `deadline`;
# none of `stamp_nullifier`, `deadline` or `bucket` is rebound nor `commitment` shadowed, the function is constrained,
# and the one private paying function proves its side through it, at its own function scope. Without the expiry cap, a payment proven against an old anchor lands after the
# stamp expired; without `for_settled`, against a stamp that is still pending.
# It also pins the side order of the three calls that publish one account: each proves a side once, at its own scope,
# passing that account first, kept, so the hint proves it rather than the hidden one (TXE cannot see which entry a call
# read). Of these, `transfer_private_to_public_with_commitment` owns its refund commitment by `from` and never stamps
# it: a stamp is the only owner check a payment makes.
# `--self-test` mutates the real source one rule at a time and requires each mutant to fail for its own reason.
set -euo pipefail
export LC_ALL=C

aztec_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
token_main="$aztec_root/token/src/main.nr"
# shellcheck source=noir-text.sh
source "$aztec_root/scripts/noir-text.sh"

violation() {
  echo "STAMP-CONSTRAINT VIOLATION: $*" >&2
  return 1
}

# block_after <text> <regex ending at `{`>: the inside of the balanced block the first match opens.
block_after() {
  printf '%s' "$1" | RE="$2" perl -0ne '
    if (/$ENV{RE}/g) {
      my ($depth, $start, $i) = (1, pos, pos);
      while ($depth && $i < length) { my $c = substr($_, $i++, 1); $depth++ if $c eq "{"; $depth-- if $c eq "}" }
      print substr($_, $start, $i - $start - 1);
    }'
}

# offset_of <text> <regex>: the byte offset of the first match, or -1.
offset_of() {
  local at
  at=$(printf '%s' "$1" | grep -obE "$2" | head -1 | cut -d: -f1)
  echo "${at:--1}"
}

# bound <fn> <body> <name> <count>: exactly <count> `let`s bind the name (0 for a parameter).
bound() {
  [ "$(printf '%s' "$2" | grep -oE "(^|[^A-Za-z0-9_])let[^=;]*[^A-Za-z0-9_]$3([^A-Za-z0-9_]|$)" | wc -l | tr -d ' ')" -eq "$4" ] ||
    violation "$1 rebinds $3"
}

check_stamp_branch() {
  local body first prev at stmt name
  body=$(fn_body "$1" _prove_payment_side)
  first="if${S}side${S}==${S}FIRST${S}[{]"
  [ "$(depth_at "$body" "$first")" -eq 1 ] || violation "_prove_payment_side has no FIRST branch at function scope" || return 1
  if printf '%s' "$body" | grep -qE "(^|[^A-Za-z0-9_])mut([^A-Za-z0-9_]|$)"; then
    violation "_prove_payment_side binds something mutable" || return 1
  fi
  for name in stamp_nullifier deadline bucket; do
    bound _prove_payment_side "$body" "$name" 1 || return 1
  done
  bound _prove_payment_side "$body" commitment 0 || return 1
  first=$(block_after "$body" "$first")
  if printf '%s' "$first" | grep -q for_pending; then
    violation "_prove_payment_side accepts a pending stamp" || return 1
  fi
  prev=-1
  for stmt in \
    "the stamp|let stamp_nullifier${S}=${S}stamp${S}\\(${S}commitment${S},${S}bucket${S}\\)${S};" \
    "the deadline|let deadline${S}=${S}stamp_deadline${S}\\(${S}bucket${S}\\)${S};" \
    "a settled stamp|self\\.context\\.assert_nullifier_exists${S}\\(${S}NullifierExistenceRequest::for_settled${S}\\(${S}compute_siloed_nullifier${S}\\(${S}self\\.context\\.this_address\\(\\)${S},${S}stamp_nullifier${S}\\)${S},?${S}\\)${S}\\)${S};" \
    "the expiry cap|self\\.context\\.set_expiration_timestamp${S}\\(${S}deadline${S}\\)${S};"; do
    at=$(offset_of "$first" "${stmt#*|}")
    if [ "$at" -lt 0 ] && [ "$(offset_of "$body" "${stmt#*|}")" -ge 0 ]; then
      violation "_prove_payment_side proves ${stmt%%|*} outside its FIRST branch" || return 1
    fi
    [ "$at" -ge 0 ] || violation "_prove_payment_side's FIRST branch does not prove ${stmt%%|*}" || return 1
    [ "$(depth_at "$first" "${stmt#*|}")" -eq 0 ] ||
      violation "_prove_payment_side proves ${stmt%%|*} inside a nested block" || return 1
    [ "$at" -gt "$prev" ] || violation "_prove_payment_side proves ${stmt%%|*} out of order" || return 1
    prev=$at
  done
}

check_file() {
  local flat pay refund proof="let side${S}=${S}self\\.internal\\._prove_payment_side${S}\\(${S}from${S},${S}commitment${S}\\)${S};"
  [ -f "$1" ] || violation "no such file: $1" || return 1
  flat=$(strip_comments <"$1" | tr '\n' ' ' | tr -s ' ')
  if printf '%s' "$flat" | grep -qE "unconstrained${S}fn${S}_prove_payment_side"; then
    violation "_prove_payment_side is unconstrained" || return 1
  fi
  check_stamp_branch "$flat" || return 1
  pay=$(fn_body "$flat" transfer_private_to_commitment)
  need transfer_private_to_commitment "$pay" "$proof" \
    "does not prove its payment through _prove_payment_side(from, commitment)" || return 1
  [ "$(depth_at "$pay" "$proof")" -eq 1 ] ||
    violation "transfer_private_to_commitment proves its payment inside a nested block" || return 1
  keeps_published "$flat" transfer_private_to_public to from recipient || return 1
  keeps_published "$flat" transfer_private_to_public_with_commitment to from recipient || return 1
  keeps_published "$flat" transfer_public_to_private from to sender || return 1
  refund=$(fn_body "$flat" transfer_private_to_public_with_commitment)
  need transfer_private_to_public_with_commitment "$refund" "_initialize_transfer_commitment${S}\\(${S}from${S}," \
    "does not own its refund commitment by from" || return 1
  if printf '%s' "$refund" | grep -qE "_push_request_stamp${S}\\("; then
    violation "transfer_private_to_public_with_commitment stamps its refund commitment"
  fi
}

# keeps_published <flat> <fn> <published> <hidden> <role>: the function's one side proof passes its published account
# first, kept, at the function's own scope.
keeps_published() {
  local body call="_prove_merchant_side${S}\\(${S}$3${S},${S}$4${S},${S}true${S}\\)"
  body=$(fn_body "$1" "$2")
  need "$2" "$body" "$call" "does not keep its published $5 first" || return 1
  [ "$(printf '%s' "$body" | grep -oE "_prove_merchant_side${S}\\(" | wc -l | tr -d ' ')" -eq 1 ] ||
    violation "$2 proves a side more than once" || return 1
  [ "$(depth_at "$body" "$call")" -eq 1 ] || violation "$2 proves its side inside a nested block"
}

self_test() {
  local tmp fails=0 count=0
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # expand now: tmp is local
  trap "rm -rf '$tmp'" EXIT
  check_file "$token_main" >/dev/null 2>&1 || {
    echo "SELF-TEST FAIL: the real token source is rejected" >&2
    fails=1
  }

  # mutant <name> <expected reason> <from> <to>: the real source with its FIRST occurrence of <from> replaced, which
  # must apply and must be rejected for the expected reason. <from> is a Perl regex, so literal text is \Q-quoted.
  mutant() {
    local name="$1" want="$2" target="$tmp/$1.nr" reason
    count=$((count + 1))
    cp "$token_main" "$target"
    if ! FROM="$3" TO="$4" perl -0pi -e '
      s/$ENV{FROM}/my @g = ($1, $2, $3, $4); (my $t = $ENV{TO}) =~ s{\$(\d)}{$g[$1 - 1]}g; $t/se or die "no match\n"' \
      "$target" 2>/dev/null; then
      echo "SELF-TEST FAIL: '$name' mutation did not apply" >&2
      fails=1
      return
    fi
    if reason=$(check_file "$target" 2>&1); then
      echo "SELF-TEST FAIL: '$name' accepted" >&2
      fails=1
    elif [[ "$reason" != *"$want"* ]]; then
      echo "SELF-TEST FAIL: '$name' rejected for the wrong reason: $reason" >&2
      fails=1
    else
      echo "  $name → ${reason#STAMP-CONSTRAINT VIOLATION: }"
    fi
  }

  lit() { FROM="$1" perl -e 'print quotemeta $ENV{FROM}'; }
  local assert='(self\.context\.assert_nullifier_exists\(NullifierExistenceRequest::for_settled\(.*?\)\);)'
  local expiry='self.context.set_expiration_timestamp(deadline);'
  # shellcheck disable=SC2016 # $1… name the mutation's captures, which mutant() substitutes
  mutant dead_branch "proves a settled stamp inside a nested block" "$assert" 'if false { $1 }'
  mutant no_assert "does not prove a settled stamp" "$assert" ""
  # shellcheck disable=SC2016
  mutant assert_outside "proves a settled stamp outside its FIRST branch" \
    "(fn _prove_payment_side.*?)(if side == FIRST \\{)(.*?)$assert" '$1$4 $2$3'
  mutant no_expiry "does not prove the expiry cap" "$(lit "$expiry")" ""
  mutant reordered "proves the expiry cap out of order" "$(lit "let deadline = stamp_deadline(bucket);")" \
    "let deadline = stamp_deadline(bucket); $expiry"
  mutant pending "accepts a pending stamp" "for_settled" "for_pending"
  mutant rebind "rebinds stamp_nullifier" "$(lit "$expiry")" "$expiry let stamp_nullifier = commitment;"
  mutant unconstrained "_prove_payment_side is unconstrained" "$(lit "fn _prove_payment_side(")" \
    "unconstrained fn _prove_payment_side("
  mutant unproven_payment "transfer_private_to_commitment does not prove its payment" \
    "$(lit "let side = self.internal._prove_payment_side(from, commitment);")" "let side = FIRST;"
  mutant dead_payment "transfer_private_to_commitment proves its payment inside a nested block" \
    "$(lit "let side = self.internal._prove_payment_side(from, commitment);")" \
    "let side = { if false { let side = self.internal._prove_payment_side(from, commitment); } FIRST };"
  mutant rebind_commitment "rebinds commitment" "$(lit "let stamp_nullifier = stamp(commitment, bucket);")" \
    "let commitment = 0; let stamp_nullifier = stamp(commitment, bucket);"
  mutant hidden_recipient "transfer_public_to_private does not keep its published sender first" \
    "$(lit "_prove_merchant_side(from, to, true)")" "_prove_merchant_side(to, from, false)"
  # The first `(to, from, true)` in the file is transfer_private_to_public's.
  mutant hidden_sender "transfer_private_to_public does not keep its published recipient first" \
    "$(lit "_prove_merchant_side(to, from, true)")" "_prove_merchant_side(to, from, false)"
  mutant dead_published "transfer_private_to_public proves a side more than once" \
    "$(lit "let side = self.internal._prove_merchant_side(to, from, true);")" \
    "if false { let _ = self.internal._prove_merchant_side(to, from, true); } let side = self.internal._prove_merchant_side(from, to, false);"
  mutant nested_published "transfer_public_to_private proves its side inside a nested block" \
    "$(lit "let side = self.internal._prove_merchant_side(from, to, true);")" \
    "let side = if from == to { NEITHER } else { self.internal._prove_merchant_side(from, to, true) };"
  # Anchored: the file's first `(to, from, true)` is transfer_private_to_public's.
  local refund_fn='(fn transfer_private_to_public_with_commitment\(.*?)'
  # shellcheck disable=SC2016
  mutant hidden_refund_sender "transfer_private_to_public_with_commitment does not keep its published recipient first" \
    "$refund_fn$(lit "_prove_merchant_side(to, from, true)")" '$1_prove_merchant_side(from, to, true)'
  # shellcheck disable=SC2016
  mutant stamped_refund "transfer_private_to_public_with_commitment stamps its refund commitment" \
    "$refund_fn($(lit "let commitment = self.internal._initialize_transfer_commitment(from, completer);"))" \
    '$1$2 self.internal._push_request_stamp(commitment.to_field(), side);'
  mutant refund_to_recipient "transfer_private_to_public_with_commitment does not own its refund commitment by from" \
    "$(lit "_initialize_transfer_commitment(from, completer)")" "_initialize_transfer_commitment(to, completer)"

  [ "$fails" = 0 ] || exit 1
  echo "✅ check-stamp-constraint self-test passed (real source upheld; $count single-rule mutants rejected for their own reasons)"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi
check_file "$token_main" || exit 1
echo "✅ stamp constraint holds: a stamped payment proves its stamp settled and caps its expiry at the stamp's deadline," \
  "unconditionally within its branch; the published side of a public transfer is the one proven; a refund" \
  "commitment is its payer's and never stamped"
