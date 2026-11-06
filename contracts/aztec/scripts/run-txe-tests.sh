#!/usr/bin/env bash
# Runs a crate's Noir tests against a TXE oracle server this script starts and owns.
#
#   run-txe-tests.sh [--crate token|token_bridge|keystone] [nargo flags...] [-- test names...]
#
#   - aztec-nargo's test runner does not resolve TXE oracles; @aztec-labs/txe serves them over JSON-RPC.
#   - The server resolves dependency contracts from the crate's target/ as "<dep_package>-<Contract>.json", and
#     they must be transpiled artifacts (the committed token and proxy; aztec-standards' published test contracts).
#   - The server's dependency set is the committed ../toolchain lockfile (frozen), never an ad-hoc install.
#   - Pass criterion: the crate's committed txe-manifest.txt names every test that must pass (at least the crate's
#     floor), so a dropped `mod test;` or a silently skipped file cannot read as green. nargo alone exits 0 on zero
#     tests.
set -euo pipefail
# shellcheck source=toolchain.sh
source "$(dirname "${BASH_SOURCE[0]}")/toolchain.sh"

crate="token_bridge"
if [ "${1:-}" = "--crate" ]; then
  crate="${2:-}"
  shift 2
fi
case "$crate" in
  token) floor=215 ;;
  token_bridge) floor=125 ;;
  keystone) floor=22 ;;
  *)
    echo "usage: $0 [--crate token|token_bridge|keystone] [nargo flags...] [-- test names...]" >&2
    exit 2
    ;;
esac
# Everything before `--` is a nargo flag; only names after it filter (and a filtered run skips the manifest gate,
# since a partial run is never a pass claim).
nargo_flags=()
filters=()
seen_sep=0
for a in "$@"; do
  if [ "$seen_sep" = 1 ]; then
    filters+=("$a")
  elif [ "$a" = "--" ]; then
    seen_sep=1
  else
    nargo_flags+=("$a")
  fi
done
tb="$aztec_root/$crate"
mkdir -p "$tb/target"

standards="$aztec_root/node_modules/@aztec-foundation/aztec-standards/artifacts/target"
stage_standard() {
  [ -f "$standards/$1" ] || {
    echo "$1 missing from $standards — run bun install" >&2
    exit 1
  }
  cp "$standards/$1" "$tb/target/"
}
case "$crate" in
  token)
    stage_standard generic_proxy-GenericProxy.json
    stage_standard test_authorization_contract-AuthorizationContract.json
    ;;
  token_bridge)
    cp "$aztec_root/token/target/merchant_token-Token.json" "$tb/target/"
    cp "$aztec_root/token_minter_proxy/target/token_minter_proxy-TokenMinterProxy.json" "$tb/target/"
    ;;
esac

# A per-run port: a fixed one collides with another agent's run or, worse, silently reuses ITS server. The kernel's
# free port can be taken before the server binds it, so the whole claim-and-bind retries.
pick_free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'
}
PORT_PINNED=1
if [ -z "${TXE_PORT:-}" ]; then
  PORT_PINNED=0
  TXE_PORT="$(pick_free_port)"
fi
TXE_PID=""
TXE_LOG=""

# Tears down only the server and log this run created; a caller-pinned server is left alone.
# shellcheck disable=SC2317,SC2329 # invoked by the trap (shellcheck < 0.11 reports it as SC2317)
cleanup() {
  [ -n "$TXE_PID" ] && kill "$TXE_PID" 2>/dev/null
  [ -n "$TXE_LOG" ] && rm -f "$TXE_LOG"
  return 0
}
trap cleanup EXIT INT TERM

# TXE answers JSON-RPC only (a bare GET fails even once serving), so probe the TCP socket.
txe_up() { (exec 3<>"/dev/tcp/127.0.0.1/$TXE_PORT") 2>/dev/null; }
# A connectable port alone may be another run's server that won the race for it. Each spawn writes to a log file
# created fresh for it, and the server prints this line only after its own bind succeeds (a failed bind exits), so the
# line in that file plus a live pid proves the listener is ours.
owned_up() {
  grep -q "TXE listening on port $TXE_PORT\$" "$TXE_LOG" && kill -0 "$TXE_PID" 2>/dev/null && txe_up
}

start_server() {
  local attempt
  for attempt in 1 2 3; do
    [ -n "$TXE_LOG" ] && rm -f "$TXE_LOG"
    TXE_LOG="$(mktemp "$TOOLCHAIN_DIR/txe-$TXE_PORT.log.XXXXXX")"
    echo "starting TXE server on :$TXE_PORT (attempt $attempt)"
    # Node, not bun: the native lmdb binding crashes under bun. `exec` makes $! the server, not a subshell.
    # FORCE_COLOR=0: under CI the logger colors its lines, and owned_up's anchored match then misses.
    (cd "$TOOLCHAIN_DIR" && TXE_PORT="$TXE_PORT" FORCE_COLOR=0 NODE_OPTIONS="--max-old-space-size=8192" \
      exec node node_modules/@aztec-labs/txe/dest/bin/index.js >"$TXE_LOG" 2>&1) &
    TXE_PID=$!
    for _ in $(seq 1 60); do
      owned_up && return 0
      kill -0 "$TXE_PID" 2>/dev/null || break
      sleep 1
    done
    kill "$TXE_PID" 2>/dev/null || true
    TXE_PID=""
    if [ "$PORT_PINNED" = 1 ] || [ "$attempt" = 3 ]; then break; fi
    TXE_PORT="$(pick_free_port)"
  done
  echo "TXE server never came up on :$TXE_PORT; the end of its log:" >&2
  tail -n 20 "$TXE_LOG" >&2
  exit 1
}

if [ "$PORT_PINNED" = 1 ] && txe_up; then
  echo "reusing the TXE server already listening on :$TXE_PORT (caller-pinned)"
else
  start_server
fi

# Long TXE calls outlive nargo's default foreign-call timeout.
export NARGO_FOREIGN_CALL_TIMEOUT=1200000
# The server's lmdb store opens with maxReaders 2 and nargo defaults to a thread per core; past the reader limit the
# binding aborts the server, every in-flight test fails with "Failed calling external resolver", and a bare
# should_fail passes vacuously on that error. Raise only if the server gains readers.
TEST_THREADS="${TXE_TEST_THREADS:-2}"
log="$tb/txe-run.log"
cd "$tb"
set +e
"$NARGO" test --force --show-output --test-threads "$TEST_THREADS" --oracle-resolver "http://127.0.0.1:$TXE_PORT" \
  "${nargo_flags[@]}" "${filters[@]}" | tee "$log"
rc=$?
set -e
grep -qE "[1-9][0-9]* tests? passed" "$log" || {
  echo "run-txe-tests.sh: nargo reported no passing tests — is the test module still wired in?" >&2
  exit 1
}
if [ "${#filters[@]}" -eq 0 ]; then
  manifest="$tb/txe-manifest.txt"
  [ -f "$manifest" ] || {
    echo "run-txe-tests.sh: $manifest is missing" >&2
    exit 1
  }
  named=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*$' <(sort -u "$manifest"))
  [ "$named" -ge "$floor" ] || {
    echo "run-txe-tests.sh: $manifest names $named tests; the floor for $crate is $floor" >&2
    exit 1
  }
  missing=0
  # Colour escapes stripped once. Never pipe into `grep -q` here: it exits at the first match, the writer dies of
  # SIGPIPE, and pipefail turns a passing test into a missing one.
  results=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log")
  while IFS= read -r name; do
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # The name must follow `Testing ` or a `::` module path, so an entry cannot be satisfied by a longer name ending
    # in it. Root-level tests (keystone) print with no path.
    if ! grep -qE "Testing ([A-Za-z0-9_]+::)*${name} \.\.\. ok" <<<"$results"; then
      echo "run-txe-tests.sh: required test '$name' did not pass" >&2
      missing=1
    fi
  done <"$manifest"
  [ "$missing" = 0 ] || exit 1
  echo "run-txe-tests.sh: $crate manifest satisfied ($named named tests passed)"
fi
exit "$rc"
