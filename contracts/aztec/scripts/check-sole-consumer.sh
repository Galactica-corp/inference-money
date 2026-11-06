#!/usr/bin/env bash
# Static tripwire for what no TXE test can prove absent: the bridge consumes L1→L2 messages at EXACTLY six sites, each
# bound to its own message type and sent by config.portal, and the rules guarding them are still in their bodies, behind
# no control flow but the rule branches (`if bind`, `if as_merchant`, `if change > 0`, `if price <= amount`). It pins text
# and shape; the TXE suites prove that each rule refuses.
#   claim_public:           consumes mint_to_public(to, amount, depositor) with the caller's secret; `to` must be a
#                           merchant; mints to `to`; messages no portal.
#   return_deposit_public:  the same consumption; refuses a merchant `to`; pays `depositor` on L1, once, and mints nothing.
#   claim_private:          takes claim_salt and no raw-secret parameter; consumes mint_to_private(amount, depositor)
#                           with exactly derive_claim_secret(claim_salt, recipient); only `recipient` submits it; the
#                           first claim binds `depositor`, every later one must match it; mints to `recipient`.
#   return_deposit_private: the same consumption; pays `depositor` on L1, once, and mints nothing.
#   claim_split:            takes no raw-secret parameter; consumes mint_to_private(amount, depositor) with exactly
#                           split_secret(merchant, price, payment_ref, change_commitment, salt); `merchant` must be
#                           proven a merchant and `price` at most `amount`; mints `price` to `merchant` against a supply
#                           increase of `amount`, self-delivered only on the merchant's own claim; leaves the rest as
#                           the IOU split_iou(change_commitment, change, depositor, secret, message_leaf_index).
#   return_split:           the same consumption; unless `price` exceeds `amount`, proves `merchant` not a merchant; pays
#                           `depositor` on L1, once, and mints nothing.
#   claim_change and return_change consume no message: each spends one IOU through _spend_iou, which rebuilds it from
#   the change's owner (claim_change's caller), proves it settled and pushes its salted spent marker. claim_change binds
#   or holds its caller to `depositor` as claim_private does and mints exactly the change to the caller; return_change
#   pays `depositor` the change on L1, once, releases it from the supply, and mints nothing.
#   exit_to_l1_public needs a merchant sender; exit_to_l1_private holds a merchant to try_prove_merchant and a user to
#   its funding address. Each exit pays `recipient` on L1 once, unconditionally (at function scope), through one binding
#   whose whole initializer is withdraw_content_hash(recipient, amount, caller_on_l1), none of those names rebound.
# Each of these reads config once, from storage, so config.portal is the stored portal.
# No lower-level messaging/nullifier primitive may exist anywhere to consume around these checks: the only nullifiers the
# bridge pushes itself are the IOU (in claim_split) and the spent marker (in _spend_iou), whose separators the keystone
# holds apart from the protocol's message nullifier. A stray site, raw secret, foreign sender or misdirected payout
# turns a deposit into something whoever holds (salt, amount, leaf) can redirect, or lets an attacker's L1 contract mint
# unbacked tokens.
#
# Counts are occurrences across every non-test source the bridge executes (its crate plus the local claim_secret and
# portal_messages libs), after stripping comments and emptying string literals; bodies are analysed on a newline-flattened copy because signatures
# span lines.
# `--self-test` mutates the real source one rule at a time and requires each mutant to fail for its own reason.
set -euo pipefail

aztec_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bridge_main="$aztec_root/token_bridge/src/main.nr"
lib_src="$aztec_root/claim_secret/src"
messages_src="$aztec_root/portal_messages/src"
# shellcheck source=noir-text.sh
source "$aztec_root/scripts/noir-text.sh"

violation() {
  echo "SOLE-CONSUMER VIOLATION: $*" >&2
  return 1
}

config_read="let config${S}=${S}self\\.storage\\.config\\.read\\(\\)"
# The context's own call: a lookalike (`not_message_portal(...)`) would pass a bare `message_portal(` match.
pay_portal="(^|[^A-Za-z0-9_.])self\\.context\\.message_portal${S}\\(${S}config\\.portal${S},${S}"
token_view="self\\.view\\(${S}Token::at\\(${S}config\\.token${S}\\)"

# bound_to <body> <call regex>: the variable a `let X = <call>` binds, if any.
bound_to() {
  printf '%s' "$1" | sed -nE "s/.*let[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)${S}=${S}$2.*/\\1/p" | head -1
}

# consumes_public <fn> <body>: hashes mint_to_public(to, amount, depositor) and consumes it with `secret` from
# config.portal.
consumes_public() {
  local content
  content=$(bound_to "$2" "mint_to_public_content_hash${S}\\(${S}to${S},${S}amount${S},${S}depositor${S}\\)")
  [ -n "$content" ] || violation "$1 does not hash mint_to_public(to, amount, depositor)" || return 1
  need "$1" "$2" "$config_read" "does not read config from storage" || return 1
  need "$1" "$2" "consume_l1_to_l2_message${S}\\(${S}${content}${S},${S}\\[${S}secret${S}\\]${S},${S}config\\.portal${S}," \
    "does not consume its public content hash from config.portal"
}

# consumes_derived <fn> <body>: takes claim_salt and no raw secret, and consumes mint_to_private(amount, depositor) with
# exactly derive_claim_secret(claim_salt, recipient) from config.portal.
consumes_derived() {
  local params derived content
  params=$(printf '%s' "$2" | sed -E 's/\).*//')
  printf '%s' "$params" | grep -q claim_salt || violation "$1 no longer takes claim_salt" || return 1
  if printf '%s' "$params" | grep -qi secret; then
    violation "$1 accepts a raw secret parameter" || return 1
  fi
  need "$1" "$2" "derive_claim_secret${S}\\(" "does not call derive_claim_secret(...)" || return 1
  derived=$(bound_to "$2" "derive_claim_secret${S}\\(")
  [ -n "$derived" ] && [ "$derived" != _ ] ||
    violation "$1 does not bind the derived secret (let X = derive_claim_secret(...))" || return 1
  need "$1" "$2" "let ${derived}${S}=${S}derive_claim_secret${S}\\(${S}claim_salt${S},${S}recipient${S}\\)" \
    "does not derive from (claim_salt, recipient)" || return 1
  content=$(bound_to "$2" "mint_to_private_content_hash${S}\\(${S}amount${S},${S}depositor${S}\\)")
  [ -n "$content" ] || violation "$1 does not hash mint_to_private(amount, depositor)" || return 1
  need "$1" "$2" "$config_read" "does not read config from storage" || return 1
  # aztec-nr takes the secret as a one-element array; a second element would change the committed hash.
  need "$1" "$2" \
    "consume_l1_to_l2_message${S}\\(${S}${content}${S},${S}\\[${S}${derived}${S}\\]${S},${S}config\\.portal${S}," \
    "does not consume its private content hash with the derived secret ($derived) from config.portal"
}

# consumes_split <fn> <body>: takes no raw secret and rebinds no term, and consumes mint_to_private(amount, depositor)
# with exactly split_secret(merchant, price, payment_ref, change_commitment, salt) from config.portal.
consumes_split() {
  local params derived content
  params=$(printf '%s' "$2" | sed -E 's/\).*//')
  if printf '%s' "$params" | grep -qi secret; then
    violation "$1 accepts a raw secret parameter" || return 1
  fi
  if printf '%s' "$2" | grep -qE "(^|[^A-Za-z0-9_])let[^=;]*[^A-Za-z0-9_](amount|depositor|merchant|price|payment_ref|change_commitment|salt|message_leaf_index)([^A-Za-z0-9_]|$)"; then
    violation "$1 rebinds a term its secret or content hashes" || return 1
  fi
  derived=$(bound_to "$2" "split_secret${S}\\(")
  [ -n "$derived" ] && [ "$derived" != _ ] ||
    violation "$1 does not bind the split secret (let X = split_secret(...))" || return 1
  need "$1" "$2" \
    "let ${derived}${S}=${S}split_secret${S}\\(${S}merchant${S},${S}price${S},${S}payment_ref${S},${S}change_commitment${S},${S}salt${S}\\)" \
    "does not derive from the split terms" || return 1
  content=$(bound_to "$2" "mint_to_private_content_hash${S}\\(${S}amount${S},${S}depositor${S}\\)")
  [ -n "$content" ] || violation "$1 does not hash mint_to_private(amount, depositor)" || return 1
  need "$1" "$2" \
    "consume_l1_to_l2_message${S}\\(${S}${content}${S},${S}\\[${S}${derived}${S}\\]${S},${S}config\\.portal${S}," \
    "does not consume its private content hash with the split secret ($derived) from config.portal"
}

# A claim mints and nothing else: a withdraw from the same consumption would pay the deposit out twice.
no_portal_message() {
  if printf '%s' "$2" | grep -q message_portal; then
    violation "$1 messages the portal" || return 1
  fi
}

# pays_depositor <fn> <body>: one withdraw, to the depositor the consumed content names, and no mint.
pays_depositor() {
  need "$1" "$2" \
    "${pay_portal}withdraw_content_hash${S}\\(${S}depositor${S},${S}amount${S},${S}EthAddress::zero\\(\\)${S}\\)${S}\\)" \
    "does not pay the depositor" || return 1
  [ "$(printf '%s' "$2" | grep -o message_portal | wc -l | tr -d ' ')" -eq 1 ] ||
    violation "$1 messages the portal more than once" || return 1
  if printf '%s' "$2" | sed -E 's/mint_to_(public|private)_content_hash//g' | grep -q mint; then
    violation "$1 mints" || return 1
  fi
}

# config_once <fn> <body>: one binding of `config`, read from storage; a second (say, a Config with another portal)
# would redirect every config.portal after it.
config_once() {
  [ "$(printf '%s' "$2" | grep -oE "(^|[^A-Za-z0-9_])let[^=;]*[^A-Za-z0-9_]config([^A-Za-z0-9_]|$)" | wc -l | tr -d ' ')" -eq 1 ] ||
    violation "$1 binds config more than once" || return 1
  need "$1" "$2" "${config_read}${S};" "does not read config from storage"
}

# pays_recipient <fn> <body>: one withdraw of (recipient, amount, caller_on_l1) to config.portal, at function scope. The
# hash names its parameters by text, so none may be rebound; and `flow_is` only lists branch conditions, so a payout
# moved into one branch would pass without the depth check.
pays_recipient() {
  local content
  content=$(bound_to "$2" "withdraw_content_hash${S}\\(${S}recipient${S},${S}amount${S},${S}caller_on_l1${S}\\)")
  [ -n "$content" ] || violation "$1 does not hash withdraw(recipient, amount, caller_on_l1)" || return 1
  need "$1" "$2" \
    "let ${content}${S}=${S}withdraw_content_hash${S}\\(${S}recipient${S},${S}amount${S},${S}caller_on_l1${S}\\)${S};" \
    "alters its withdraw hash" || return 1
  [ "$(printf '%s' "$2" | grep -oE "(^|[^A-Za-z0-9_])let[^=;]*[^A-Za-z0-9_]${content}([^A-Za-z0-9_]|$)" | wc -l | tr -d ' ')" -eq 1 ] ||
    violation "$1 rebinds $content" || return 1
  if printf '%s' "$2" | grep -qE "(^|[^A-Za-z0-9_])let[^=;]*[^A-Za-z0-9_](recipient|amount|caller_on_l1)([^A-Za-z0-9_]|$)"; then
    violation "$1 rebinds a parameter its withdraw hashes" || return 1
  fi
  need "$1" "$2" "${pay_portal}${content}${S}\\)" "does not pay the hashed withdraw to config.portal" || return 1
  [ "$(printf '%s' "$2" | grep -o message_portal | wc -l | tr -d ' ')" -eq 1 ] ||
    violation "$1 messages the portal more than once" || return 1
  [ "$(depth_at "$2" message_portal)" -eq 1 ] || violation "$1 pays out inside a branch"
}

check_claim_public() {
  local body
  body=$(fn_body "$1" claim_public)
  config_once claim_public "$body" || return 1
  consumes_public claim_public "$body" || return 1
  need claim_public "$body" "assert${S}\\(${S}${token_view}\\.is_merchant\\(${S}to${S}\\)${S}\\)${S}," \
    "does not require a merchant recipient" || return 1
  need claim_public "$body" "\\.mint_to_public${S}\\(${S}to${S},${S}amount${S}\\)" \
    "does not mint to the hashed recipient" || return 1
  no_portal_message claim_public "$body" || return 1
  flow_is claim_public "$body" ""
}

check_claim_private() {
  local body
  body=$(fn_body "$1" claim_private)
  config_once claim_private "$body" || return 1
  consumes_derived claim_private "$body" || return 1
  need claim_private "$body" "assert${S}\\(${S}self\\.msg_sender\\(\\)${S}==${S}recipient${S}," \
    "does not require the recipient to submit it" || return 1
  need claim_private "$body" "let funding${S}=${S}self\\.storage\\.funding_address\\.at\\(${S}recipient${S}\\)${S};" \
    "does not read the recipient's binding" || return 1
  need claim_private "$body" \
    "if${S}bind${S}\\{${S}funding\\.initialize\\(${S}FundingAddressNote${S}\\{${S}address${S}:${S}depositor${S}\\}${S}\\)" \
    "does not bind the deposit's depositor" || return 1
  need claim_private "$body" "\\}${S}else${S}\\{${S}assert${S}\\(${S}funding\\.get_note\\(\\)\\.address${S}==${S}depositor${S}," \
    "does not hold a later deposit to the funding address" || return 1
  need claim_private "$body" "\\.mint_to_private${S}\\(${S}recipient${S},${S}amount${S}\\)" \
    "does not mint to the committed recipient" || return 1
  no_portal_message claim_private "$body" || return 1
  flow_is claim_private "$body" bind
}

check_returns() {
  local body
  body=$(fn_body "$1" return_deposit_private)
  config_once return_deposit_private "$body" || return 1
  consumes_derived return_deposit_private "$body" || return 1
  pays_depositor return_deposit_private "$body" || return 1
  flow_is return_deposit_private "$body" "" || return 1
  body=$(fn_body "$1" return_deposit_public)
  config_once return_deposit_public "$body" || return 1
  consumes_public return_deposit_public "$body" || return 1
  need return_deposit_public "$body" "assert${S}\\(${S}!${S}${token_view}\\.is_merchant\\(${S}to${S}\\)${S}\\)${S}," \
    "does not refuse a merchant's deposit" || return 1
  pays_depositor return_deposit_public "$body" || return 1
  flow_is return_deposit_public "$body" ""
}

check_splits() {
  local body
  body=$(fn_body "$1" claim_split)
  config_once claim_split "$body" || return 1
  consumes_split claim_split "$body" || return 1
  need claim_split "$body" "assert${S}\\(${S}price${S}<=${S}amount${S}," "does not hold the price to the deposit" || return 1
  need claim_split "$body" "assert${S}\\(${S}${token_view}\\.try_prove_merchant\\(${S}merchant${S}\\)${S}\\)${S}," \
    "does not require a listed merchant" || return 1
  need claim_split "$body" "let change${S}=${S}amount${S}-${S}price${S};" "does not compute the change" || return 1
  need claim_split "$body" \
    "if${S}change${S}>${S}0${S}\\{${S}self\\.context\\.push_nullifier_unsafe\\(${S}split_iou\\(${S}change_commitment${S},${S}change${S},${S}depositor${S},${S}secret${S},${S}message_leaf_index${S}\\)${S}\\)${S};${S}\\}" \
    "does not leave the change as its IOU" || return 1
  need claim_split "$body" "let self_send${S}=${S}self\\.msg_sender\\(\\)${S}==${S}merchant${S};" \
    "does not self-deliver only on the merchant's own claim" || return 1
  need claim_split "$body" "\\.mint_split_to_private${S}\\(${S}merchant${S},${S}price${S},${S}amount${S},${S}self_send${S}\\)" \
    "does not mint the price to the merchant against the whole deposit" || return 1
  no_portal_message claim_split "$body" || return 1
  flow_is claim_split "$body" "change > 0" || return 1
  body=$(fn_body "$1" return_split)
  config_once return_split "$body" || return 1
  consumes_split return_split "$body" || return 1
  need return_split "$body" \
    "if${S}price${S}<=${S}amount${S}\\{${S}self\\.view\\(${S}Token::at\\(${S}config\\.token${S}\\)\\.prove_not_merchant\\(${S}merchant${S}\\)${S}\\)${S};${S}\\}" \
    "does not prove the merchant unpayable" || return 1
  pays_depositor return_split "$body" || return 1
  flow_is return_split "$body" "price <= amount"
}

check_change() {
  local body
  body=$(fn_body "$1" _spend_iou)
  need _spend_iou "$body" "let change_commitment${S}=${S}split_change_commitment${S}\\(${S}owner${S},${S}change_salt${S}\\)${S};" \
    "does not rebuild the change commitment from its owner" || return 1
  need _spend_iou "$body" \
    "let iou${S}=${S}split_iou${S}\\(${S}change_commitment${S},${S}amount_change${S},${S}depositor${S},${S}secret${S},${S}message_leaf_index${S}\\)${S};" \
    "does not rebuild the IOU" || return 1
  need _spend_iou "$body" \
    "self\\.context\\.assert_nullifier_exists\\(${S}NullifierExistenceRequest::for_settled\\(${S}compute_siloed_nullifier\\(${S}self\\.context\\.this_address\\(\\)${S},${S}iou${S}\\)${S},?${S}\\)${S}\\)${S};" \
    "does not prove the IOU" || return 1
  need _spend_iou "$body" "let spent${S}=${S}split_iou_spent${S}\\(${S}iou${S},${S}change_salt${S}\\)${S};" \
    "does not mark the IOU spent with its salt" || return 1
  flow_is _spend_iou "$body" "" || return 1
  body=$(fn_body "$1" claim_change)
  need claim_change "$body" "let recipient${S}=${S}self\\.msg_sender\\(\\)${S};" "does not collect for its caller" || return 1
  need claim_change "$body" "self\\.internal\\._spend_iou\\(${S}recipient${S},${S}amount_change${S},${S}depositor${S}," \
    "does not spend its caller's IOU" || return 1
  need claim_change "$body" \
    "if${S}bind${S}\\{${S}funding\\.initialize\\(${S}FundingAddressNote${S}\\{${S}address${S}:${S}depositor${S}\\}${S}\\)" \
    "does not bind the deposit's depositor" || return 1
  need claim_change "$body" "\\}${S}else${S}\\{${S}assert${S}\\(${S}funding\\.get_note\\(\\)\\.address${S}==${S}depositor${S}," \
    "does not hold a later deposit to the funding address" || return 1
  need claim_change "$body" "\\.mint_reserved_to_private${S}\\(${S}recipient${S},${S}amount_change${S}\\)" \
    "does not mint the change it spends" || return 1
  no_portal_message claim_change "$body" || return 1
  flow_is claim_change "$body" bind || return 1
  body=$(fn_body "$1" return_change)
  config_once return_change "$body" || return 1
  need return_change "$body" "self\\.internal\\._spend_iou\\(${S}buyer${S},${S}amount_change${S},${S}depositor${S}," \
    "does not spend the change's IOU" || return 1
  need return_change "$body" \
    "${pay_portal}withdraw_content_hash${S}\\(${S}depositor${S},${S}amount_change${S},${S}EthAddress::zero\\(\\)${S}\\)${S}\\)" \
    "does not pay the depositor" || return 1
  [ "$(printf '%s' "$body" | grep -o message_portal | wc -l | tr -d ' ')" -eq 1 ] ||
    violation "return_change messages the portal more than once" || return 1
  need return_change "$body" "\\.release_reserved${S}\\(${S}amount_change${S}\\)" \
    "does not release the change from the supply" || return 1
  if printf '%s' "$body" | sed -E 's/token_minter_proxy|TokenMinterProxy//g' | grep -q mint; then
    violation "return_change mints" || return 1
  fi
  flow_is return_change "$body" ""
}

check_exits() {
  local body
  body=$(fn_body "$1" exit_to_l1_public)
  config_once exit_to_l1_public "$body" || return 1
  need exit_to_l1_public "$body" "assert${S}\\(${S}${token_view}\\.is_merchant\\(${S}sender${S}\\)${S}\\)${S}," \
    "does not require a merchant sender" || return 1
  flow_is exit_to_l1_public "$body" "" || return 1
  pays_recipient exit_to_l1_public "$body" || return 1
  body=$(fn_body "$1" exit_to_l1_private)
  config_once exit_to_l1_private "$body" || return 1
  need exit_to_l1_private "$body" \
    "if${S}as_merchant${S}\\{${S}assert${S}\\(${S}${token_view}\\.try_prove_merchant\\(${S}sender${S}\\)${S}\\)${S}," \
    "does not require try_prove_merchant for a merchant exit" || return 1
  need exit_to_l1_private "$body" \
    "\\}${S}else${S}\\{.*assert${S}\\(${S}self\\.storage\\.funding_address\\.at\\(${S}sender${S}\\)\\.get_note\\(\\)\\.address${S}==${S}recipient${S}," \
    "does not hold a user to its funding address" || return 1
  flow_is exit_to_l1_private "$body" as_merchant || return 1
  pays_recipient exit_to_l1_private "$body"
}

# check_file <main.nr> [extra source dir...]: 0 when the invariant holds, 1 with a reason on stderr otherwise.
check_file() {
  local main="$1" all consumers flat name
  shift
  [ -f "$main" ] || violation "no such file: $main" || return 1
  all="$(find "$(dirname "$main")" "$@" -name '*.nr' -not -path '*/test/*' -exec cat {} + | strip_comments)"
  consumers=$(printf '%s' "$all" | grep -o consume_l1_to_l2_message | wc -l | tr -d ' ')
  [ "$consumers" -eq 6 ] || violation "expected 6 consume_l1_to_l2_message sites, found $consumers" || return 1
  # The two nullifiers the bridge pushes itself, each in its one exact form; any other push could consume around the
  # sites above.
  if printf '%s' "$all" | perl -0pe '
    s/self\.context\.push_nullifier_unsafe\(\s*split_iou\(\s*change_commitment\s*,\s*change\s*,\s*depositor\s*,\s*secret\s*,\s*message_leaf_index\s*\)\s*\)//;
    s/self\.context\.push_nullifier_unsafe\(\s*spent\s*\)//' | grep -qE 'process_l1_to_l2_message|push_nullifier'; then
    violation "a lower-level messaging/nullifier primitive can consume around consume_l1_to_l2_message" || return 1
  fi
  flat=$(strip_comments <"$main" | tr '\n' ' ' | tr -s ' ')
  for name in claim_public claim_private return_deposit_private return_deposit_public exit_to_l1_public \
    exit_to_l1_private claim_split return_split claim_change return_change _spend_iou; do
    printf '%s' "$flat" | grep -qE "fn ${name}${S}\\(" || violation "no $name in $main" || return 1
  done
  check_claim_public "$flat" && check_claim_private "$flat" && check_returns "$flat" && check_exits "$flat" &&
    check_splits "$flat" && check_change "$flat"
}

self_test() {
  local tmp fails=0 count=0
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064 # expand now: tmp is local
  trap "rm -rf '$tmp'" EXIT
  check_file "$bridge_main" "$lib_src" "$messages_src" >/dev/null 2>&1 || {
    echo "SELF-TEST FAIL: the real bridge source is rejected" >&2
    fails=1
  }

  # mutant <name> <expected reason> <main|lib> <from> <to> [nth]: the real crate with ONE literal substitution (of the
  # nth occurrence, default the first; any run of whitespace in <from> matches any other, so the source's layout
  # never matters), which must apply and must be rejected for the expected reason.
  mutant() {
    local name="$1" want="$2" dir="$tmp/$1" target reason
    count=$((count + 1))
    mkdir -p "$dir/src" "$dir/lib" "$dir/messages"
    cp "$bridge_main" "$dir/src/main.nr"
    cp "$lib_src"/*.nr "$dir/lib/"
    cp "$messages_src"/*.nr "$dir/messages/"
    target="$dir/src/main.nr"
    [ "$3" = lib ] && target="$dir/lib/lib.nr"
    if ! FROM="$4" TO="$5" NTH="${6:-1}" perl -0pi -e \
      'my $c = 0; my $re = join "\\s+", map { quotemeta } split /\s+/, $ENV{FROM}, -1;
       s/$re/++$c == $ENV{NTH} ? $ENV{TO} : $&/ge; die "no match\n" if $c < $ENV{NTH}' \
      "$target" 2>/dev/null; then
      echo "SELF-TEST FAIL: '$name' mutation did not apply" >&2
      fails=1
      return
    fi
    if reason=$(check_file "$dir/src/main.nr" "$dir/lib" "$dir/messages" 2>&1); then
      echo "SELF-TEST FAIL: '$name' accepted" >&2
      fails=1
    elif [[ "$reason" != *"$want"* ]]; then
      echo "SELF-TEST FAIL: '$name' rejected for the wrong reason: $reason" >&2
      fails=1
    else
      echo "  $name → ${reason#SOLE-CONSUMER VIOLATION: }"
    fi
  }

  local derive='let secret = derive_claim_secret(claim_salt, recipient);'
  local exits='#[external("public")]
fn exit_to_l1_public('
  local payout='withdraw_content_hash(depositor, amount, EthAddress::zero())'
  local public_consume='[secret], config.portal, message_leaf_index);'

  # Consumption: the sites, their message types, secrets and sender.
  mutant raw_secret "claim_private accepts a raw secret parameter" main "claim_salt: Field," \
    "claim_salt: Field, raw_secret: Field,"
  mutant no_call "claim_private does not call derive_claim_secret" main "$derive" "let secret = claim_salt;"
  mutant discarded "does not bind the derived secret" main "$derive" \
    "let _ = derive_claim_secret(claim_salt, recipient); let secret = claim_salt;"
  mutant from_sender "does not derive from (claim_salt, recipient)" main "$derive" \
    "let secret = derive_claim_secret(claim_salt, self.msg_sender());"
  mutant extra_element "with the derived secret" main "content_hash,
[secret]," "content_hash,
[claim_salt, secret]," 2
  mutant public_redeems_private "claim_public does not hash mint_to_public" main \
    "mint_to_public_content_hash(to, amount, depositor)" "mint_to_private_content_hash(amount, depositor)"
  mutant foreign_sender "claim_public does not consume its public content hash from config.portal" main \
    "$public_consume" "[secret], sender, message_leaf_index);"
  mutant private_foreign_sender "claim_private does not consume its private content hash with the derived secret" \
    main "[secret],
config.portal," "[secret],
sender," 2
  mutant mint_to_sender "claim_private does not mint to the committed recipient" main \
    "mint_to_private(recipient, amount)" "mint_to_private(self.msg_sender(), amount)"
  mutant seventh_site "found 7" main "$exits" \
    "fn b() { self.context.consume_l1_to_l2_message(y, [z], config.portal, 0); } $exits"
  mutant one_line "found 7" main "config.portal, message_leaf_index);" \
    "config.portal, message_leaf_index); self.context.consume_l1_to_l2_message(o, [s], config.portal, 1);"
  mutant lowlevel "lower-level messaging/nullifier primitive" main "$exits" \
    "fn claim_bearer(raw: Field, leaf: Field) { let m = self.context.process_l1_to_l2_message(raw, leaf); self.context.push_nullifier(m); } $exits"
  mutant commented "does not call derive_claim_secret" main "$derive" "// $derive
let secret = claim_salt;"
  mutant string_slash "lower-level messaging/nullifier primitive" main "$derive" \
    "$derive let url = \"https://x\"; let m = self.context.process_l1_to_l2_message(claim_salt, message_leaf_index);"
  mutant string_block "lower-level messaging/nullifier primitive" main "$derive" \
    "$derive let open = \"/*\"; let m = self.context.process_l1_to_l2_message(claim_salt, message_leaf_index); let close = \"*/\";"
  mutant lib_consume "found 7" lib "pub fn derive_claim_secret" \
    "fn f() { self.context.consume_l1_to_l2_message(a, [b], c, d); }
pub fn derive_claim_secret"
  mutant return_raw_secret "return_deposit_private accepts a raw secret parameter" main "depositor: EthAddress,
) {" "depositor: EthAddress,
secret: Field,
) {"
  mutant return_underived "return_deposit_private does not call derive_claim_secret" main "$derive" \
    "let secret = claim_salt;" 2
  mutant return_foreign_sender "return_deposit_public does not consume its public content hash from config.portal" \
    main "$public_consume" "[secret], depositor_contract, message_leaf_index);" 2

  # Returns: the depositor is paid, once, and nothing is minted.
  mutant return_pays_caller "return_deposit_private does not pay the depositor" main "$payout" \
    "withdraw_content_hash(caller, amount, EthAddress::zero())"
  mutant return_pays_recipient "return_deposit_public does not pay the depositor" main "$payout" \
    "withdraw_content_hash(to, amount, EthAddress::zero())" 2
  mutant return_pays_twice "return_deposit_private messages the portal more than once" main "$payout);" \
    "$payout); self.context.message_portal(config.portal, withdraw_content_hash(caller, amount, EthAddress::zero()));"
  mutant return_mints "return_deposit_public mints" main "$payout);" \
    "$payout); self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_to_public(to, amount));" 2
  mutant return_bounces_merchant "return_deposit_public does not refuse a merchant's deposit" main \
    'assert(!self.view(Token::at(config.token).is_merchant(to)), "A merchant'"'"'s public deposit is claimed, not returned");' ""
  mutant claim_withdraws "claim_public messages the portal" main \
    "self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_to_public(to, amount));" \
    "self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_to_public(to, amount)); self.context.message_portal(config.portal, $payout);"

  # Rules: merchants, the self-claim, the binding and the exits.
  mutant public_claim_for_users "claim_public does not require a merchant recipient" main \
    'assert(self.view(Token::at(config.token).is_merchant(to)), "Public claims are for merchants only");' ""
  mutant relayed_private_claim "claim_private does not require the recipient to submit it" main \
    'assert(self.msg_sender() == recipient, "Only the recipient can claim privately");' ""
  mutant binds_another "claim_private does not bind the deposit's depositor" main \
    "FundingAddressNote { address: depositor }" "FundingAddressNote { address: EthAddress::zero() }"
  mutant unchecked_binding "claim_private does not hold a later deposit to the funding address" main \
    "assert(funding.get_note().address == depositor, \"Deposit is not from this account's funding address\");" \
    "let _ = funding.get_note();"
  mutant user_exits_anywhere "exit_to_l1_private does not hold a user to its funding address" main \
    "self.storage.funding_address.at(sender).get_note().address == recipient" "bound"
  mutant merchant_flag_unchecked "exit_to_l1_private does not require try_prove_merchant" main "assert(
self.view(Token::at(config.token).try_prove_merchant(sender))," \
    "let _ = self.view(Token::at(config.token).try_prove_merchant(sender));
assert(
true,"
  mutant public_exit_for_users "exit_to_l1_public does not require a merchant sender" main \
    'assert(self.view(Token::at(config.token).is_merchant(sender)), "Public exits are for merchants only");' ""

  # Exits: each pays its own recipient on L1, once, unconditionally, through the stored portal.
  local exit_hash='withdraw_content_hash(recipient, amount, caller_on_l1)'
  local exit_pay='self.context.message_portal(config.portal, content);'
  local funding_tail='"Withdrawals from a user account go only to its funding address",
);
}
let content ='
  mutant exit_public_unpaid "exit_to_l1_public does not pay the hashed withdraw to config.portal" main "$exit_pay" ""
  mutant exit_private_unpaid "exit_to_l1_private does not pay the hashed withdraw to config.portal" main "$exit_pay" "" 2
  mutant exit_lookalike_payout "exit_to_l1_public does not pay the hashed withdraw to config.portal" main "$exit_pay" \
    "not_message_portal(config.portal, content);"
  mutant exit_quoted_hash "exit_to_l1_public does not hash withdraw(recipient, amount, caller_on_l1)" main \
    "let content = $exit_hash;" "let content = 0; assert(true, \"let content = $exit_hash;\");"
  mutant exit_quoted_config "exit_to_l1_private does not read config from storage" main \
    "let config = self.storage.config.read();
assert(recipient != config.portal, \"Recipient cannot be the portal\");
if as_merchant" \
    "let config = Config { token_minter_proxy: config.token_minter_proxy, token: config.token, portal: caller_on_l1 };
assert(true, \"let config = self.storage.config.read();\");
assert(recipient != config.portal, \"Recipient cannot be the portal\");
if as_merchant"
  mutant exit_pays_twice "exit_to_l1_public messages the portal more than once" main "$exit_pay" "$exit_pay $exit_pay"
  mutant exit_pays_portal "exit_to_l1_public does not hash withdraw(recipient, amount, caller_on_l1)" main \
    "$exit_hash" "withdraw_content_hash(config.portal, amount, caller_on_l1)"
  mutant exit_drops_caller "exit_to_l1_private does not hash withdraw(recipient, amount, caller_on_l1)" main \
    "$exit_hash" "withdraw_content_hash(recipient, amount, EthAddress::zero())" 2
  mutant exit_altered_hash "exit_to_l1_public alters its withdraw hash" main "$exit_hash;" "$exit_hash + 1;"
  mutant exit_shadowed_hash "exit_to_l1_private rebinds content" main "$exit_pay" "let content = 0; $exit_pay" 2
  mutant exit_rebinds_recipient "exit_to_l1_private rebinds a parameter its withdraw hashes" main "$funding_tail" \
    "${funding_tail%let content =}let recipient = caller_on_l1; let content ="
  mutant exit_paid_in_branch "exit_to_l1_private pays out inside a branch" main "$funding_tail $exit_hash;
$exit_pay" "${funding_tail%\}*}let content = $exit_hash; $exit_pay }"
  mutant exit_redirected "exit_to_l1_private binds config more than once" main "$funding_tail" \
    "${funding_tail%let content =}let config = Config { token_minter_proxy: config.token_minter_proxy, token: config.token, portal: caller_on_l1 }; let content ="

  # Control flow: a rule's text kept behind a branch or loop that never runs it.
  mutant dead_branch "exit_to_l1_private branches on [as_merchant false]" main \
    "assert(
self.storage.funding_address.at(sender).get_note().address == recipient," \
    "if false { assert(
self.storage.funding_address.at(sender).get_note().address == recipient,"
  mutant paren_branch "exit_to_l1_private branches on [as_merchant (false)]" main \
    "assert(
self.storage.funding_address.at(sender).get_note().address == recipient," \
    "if(false) { assert(
self.storage.funding_address.at(sender).get_note().address == recipient,"
  mutant dead_loop "claim_private has a loop, match or closure" main \
    'assert(self.msg_sender() == recipient, "Only the recipient can claim privately");' \
    'for _ in 0..0 { assert(self.msg_sender() == recipient, "Only the recipient can claim privately"); }'

  # Split deposits: the terms, the merchant, the price, the IOU, and the change's owner, binding and supply.
  local split_derive='let secret = split_secret(merchant, price, payment_ref, change_commitment, salt);'
  local iou_push='self.context.push_nullifier_unsafe(split_iou(change_commitment, change, depositor, secret, message_leaf_index));'
  local change_pay='withdraw_content_hash(depositor, amount_change, EthAddress::zero())'
  mutant split_raw_secret "claim_split accepts a raw secret parameter" main "change_commitment: Field,
salt: Field,
) {" "change_commitment: Field,
salt: Field,
secret_in: Field,
) {"
  mutant split_underived "claim_split does not bind the split secret" main "$split_derive" "let secret = salt;"
  mutant split_other_merchant "claim_split does not derive from the split terms" main "$split_derive" \
    "let secret = split_secret(self.msg_sender(), price, payment_ref, change_commitment, salt);"
  mutant split_rebinds_price "claim_split rebinds a term" main "$split_derive" "let price = amount; $split_derive"
  mutant split_foreign_sender "claim_split does not consume its private content hash with the split secret" main \
    "[secret],
config.portal," "[secret],
merchant_portal," 5
  mutant split_unlisted "claim_split does not require a listed merchant" main "assert(
self.view(Token::at(config.token).try_prove_merchant(merchant))," "assert(
true,"
  mutant split_price_unchecked "claim_split does not hold the price to the deposit" main \
    'assert(price <= amount, "The price exceeds the deposit");' ""
  mutant split_mints_deposit "claim_split does not mint the price to the merchant" main \
    "mint_split_to_private(merchant, price, amount, self_send)" "mint_split_to_private(merchant, amount, amount, self_send)"
  mutant split_mints_caller "claim_split does not mint the price to the merchant" main \
    "mint_split_to_private(merchant, price, amount, self_send)" "mint_split_to_private(self.msg_sender(), price, amount, self_send)"
  mutant split_always_self "claim_split does not self-deliver only on the merchant's own claim" main \
    "let self_send = self.msg_sender() == merchant;" "let self_send = true;"
  mutant split_no_iou "claim_split does not leave the change as its IOU" main "if change > 0 {
$iou_push
}" ""
  mutant split_iou_amount "lower-level messaging/nullifier primitive" main "$iou_push" \
    "self.context.push_nullifier_unsafe(split_iou(change_commitment, amount, depositor, secret, message_leaf_index));"
  mutant split_extra_push "lower-level messaging/nullifier primitive" main "$iou_push" \
    "$iou_push self.context.push_nullifier_unsafe(message_leaf_index);"
  mutant split_withdraws "claim_split messages the portal" main "$iou_push
}" "$iou_push
} self.context.message_portal(config.portal, $payout);"
  mutant return_split_unproven "return_split does not prove the merchant unpayable" main \
    "self.view(Token::at(config.token).prove_not_merchant(merchant));" ""
  mutant return_split_pays_merchant "return_split does not pay the depositor" main "$payout" \
    "withdraw_content_hash(caller, amount, EthAddress::zero())" 3
  mutant return_split_underived "return_split does not bind the split secret" main "$split_derive" "let secret = salt;" 2
  mutant iou_unproven "_spend_iou does not prove the IOU" main "self.context.assert_nullifier_exists(NullifierExistenceRequest::for_settled(
compute_siloed_nullifier(self.context.this_address(), iou),
));" ""
  mutant iou_other_owner "_spend_iou does not rebuild the change commitment from its owner" main \
    "split_change_commitment(owner, change_salt)" "split_change_commitment(self.msg_sender(), change_salt)"
  mutant iou_unsalted "_spend_iou does not mark the IOU spent with its salt" main "split_iou_spent(iou, change_salt)" \
    "split_iou_spent(iou, 0)"
  mutant iou_never_spent "lower-level messaging/nullifier primitive" main "self.context.push_nullifier_unsafe(spent);" \
    "self.context.push_nullifier_unsafe(iou);"
  mutant change_for_anyone "claim_change does not collect for its caller" main "let recipient = self.msg_sender();" \
    "let recipient = AztecAddress::zero();"
  mutant change_binds_another "claim_change does not bind the deposit's depositor" main \
    "FundingAddressNote { address: depositor }" "FundingAddressNote { address: EthAddress::zero() }" 2
  mutant change_unchecked "claim_change does not hold a later deposit to the funding address" main \
    "assert(funding.get_note().address == depositor, \"Deposit is not from this account's funding address\");" \
    "let _ = funding.get_note();" 2
  mutant change_mints_more "claim_change does not mint the change it spends" main \
    "mint_reserved_to_private(recipient, amount_change)" "mint_reserved_to_private(recipient, amount_change + 1)"
  mutant return_change_pays_caller "return_change does not pay the depositor" main "$change_pay" \
    "withdraw_content_hash(caller, amount_change, EthAddress::zero())"
  mutant return_change_keeps_supply "return_change does not release the change from the supply" main \
    "self.enqueue(TokenMinterProxy::at(config.token_minter_proxy).release_reserved(amount_change));" ""
  mutant return_change_mints "return_change mints" main \
    "self.enqueue(TokenMinterProxy::at(config.token_minter_proxy).release_reserved(amount_change));" \
    "self.enqueue(TokenMinterProxy::at(config.token_minter_proxy).release_reserved(amount_change)); self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_reserved_to_private(buyer, amount_change));"

  [ "$fails" = 0 ] || exit 1
  echo "✅ check-sole-consumer self-test passed (real source upheld; $count single-rule mutants rejected for their own reasons)"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi
check_file "$bridge_main" "$lib_src" "$messages_src" || exit 1
echo "✅ sole-consumer invariant holds: six consume sites, each bound to its own message type from config.portal;" \
  "the private ones consume only the recipient-derived or split secret; returns pay their depositor and never mint;" \
  "split claims pay their merchant the price and leave the rest as one IOU, spent once by its owner; exits pay their" \
  "recipient, unconditionally; the merchant, binding and exit rules are in place, behind no control flow but their" \
  "own branches"
