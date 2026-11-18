#!/usr/bin/env bash
# Slither over src/, failing on any finding that slither.config.json or an inline, reasoned suppression does not cover,
# and on any project function Slither cannot lift to its IR: it logs those, skips their bodies and still exits 0.
# It reads a build of its own: left to compile, its foundry mode runs `forge clean` on the shared out/, and a shared
# cache would race a concurrent forge run. `--self-test` checks the IR gate against fixtures.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# OpenZeppelin's EIP712 bodies the portal inherits, which Slither 0.11.6 cannot lift. Each still marks the portal
# incorrectly constructed, and Slither then builds no SSA (so no data dependency) for any portal function.
OZ_EIP712=node_modules/@openzeppelin/contracts/utils/cryptography/EIP712.sol
ALLOWED_IR_FAILURES=(
	"TokenPortal.constructor $OZ_EIP712"
	"TokenPortal._EIP712Name $OZ_EIP712"
	"TokenPortal._EIP712Version $OZ_EIP712"
)

# ir_gate <slither status> <stderr file> <src contract names...>: names every IR failure in a src/ contract (an
# inherited body is logged under the inheriting contract and the dependency's file) or a src/ source that is not
# allow-listed, and fails on any, on an IR failure marker it cannot parse, on an allow-listed one Slither did not
# report, or on a non-zero Slither exit.
ir_gate() {
	local status=$1 log=$2 bad=0 fn src entry seen="" stripped parsed
	shift 2
	local project=" $* "
	stripped=$(sed 's/\x1b\[[0-9;]*m//g' "$log")
	# The line range is the last `#N[-M]` before the closing parenthesis: a `#` earlier belongs to the file name.
	parsed=$(sed -nE \
		-e 's/.*Impossible to generate IR for top level function ([^ ]+) \((.+)#[0-9]+(-[0-9]+)?\).*/\1 \2/p' \
		-e 's/.*Impossible to generate IR for ([^ ]+) \((.+)#[0-9]+(-[0-9]+)?\).*/\1 \2/p' <<<"$stripped")
	if (($(grep -o 'Impossible to generate IR for' <<<"$stripped" | wc -l || true) != $(grep -c . <<<"$parsed" || true))); then
		echo "slither: an IR failure line did not parse" >&2
		bad=1
	fi
	while read -r fn src; do
		[[ -n $fn ]] || continue
		[[ $project == *" ${fn%%.*} "* || $src == src/* ]] || continue
		if printf '%s\n' "${ALLOWED_IR_FAILURES[@]}" | grep -qxF "$fn $src"; then
			seen+="$fn $src"$'\n'
		else
			echo "slither: could not analyse $fn ($src)" >&2
			bad=1
		fi
	done <<<"$parsed"
	# An entry no longer reported is stale, or the log format changed and this filter now matches nothing.
	for entry in "${ALLOWED_IR_FAILURES[@]}"; do
		if ! grep -qxF "$entry" <<<"$seen"; then
			echo "slither: the allow-listed $entry was not reported" >&2
			bad=1
		fi
	done
	((status == 0)) || echo "slither: exited $status" >&2
	((status == 0 && bad == 0))
}

# src_contracts <build-info dir>: the name of every contract, library and interface the compiler saw in a src/ source.
src_contracts() {
	jq -r '.output.contracts | to_entries[] | select(.key | startswith("src/")) | .value | keys[]' "$1"/*.json
}

self_test() {
	local dir=$1 log=$1/stderr n=0 names
	mkdir -p "$dir/build-info"
	printf '%s' '{"output":{"contracts":{"src/TokenPortal.sol":{"TokenPortal":{}},"src/a/Router.sol":{"Permit2DepositRouter":{},"Wrapper":{}},"node_modules/x/src/Dep.sol":{"Dep":{}}}}}' \
		>"$dir/build-info/fixture.json"
	mapfile -t names < <(src_contracts "$dir/build-info")
	[[ ${names[*]} == "TokenPortal Permit2DepositRouter Wrapper" ]] || {
		echo "slither self-test: src_contracts found: ${names[*]}" >&2
		exit 1
	}
	local ir="ERROR:ContractSolcParsing:Impossible to generate IR for"
	local name="$ir TokenPortal._EIP712Name ($OZ_EIP712#1-2):" version="$ir TokenPortal._EIP712Version ($OZ_EIP712#3-4):"
	local allowed="$ir TokenPortal.constructor ($OZ_EIP712#68-77):\n 'NoneType' object has no attribute 'parameters'\n$name\n$version"
	local aztec="$ir FeeLib.initialize (node_modules/@aztec-foundation/l1-artifacts/l1-contracts/src/core/libraries/rollup/FeeLib.sol#170-215):\n x"
	check() {
		printf '%b\n' "$3" >"$log"
		local got=fail
		if ir_gate "$2" "$log" "${names[@]}" 2>/dev/null; then got=pass; fi
		[[ $got == "$1" ]] || {
			echo "slither self-test: expected $1, got $got for: $3" >&2
			exit 1
		}
		n=$((n + 1))
	}
	check pass 0 "$allowed\n$aztec"
	check pass 0 "\x1b[91m$name\x1b[0m\n$allowed"
	check fail 1 "$allowed"
	check fail 0 "$name\n$version"
	check fail 0 "$allowed\n$ir TokenPortal.withdraw (src/TokenPortal.sol#240-260):\n x"
	check fail 0 "$allowed\n$ir Permit2DepositRouter.constructor ($OZ_EIP712#68-77):"
	check fail 0 "$allowed\n$ir TokenPortal._EIP712Name (node_modules/@openzeppelin/contracts/utils/ShortStrings.sol#1-2):"
	check fail 0 "$allowed\n\x1b[91m$ir TokenPortal.deposit (src/TokenPortal.sol#1-2):\x1b[0m"
	check fail 0 "$allowed\n$ir top level function helper (src/Helpers.sol#1-2):"
	check fail 0 "$allowed\n$ir Wrapper.f (src/Wrapper.sol#3-4):\n x"
	check fail 0 "$allowed\n$ir Wrapper._EIP712Name ($OZ_EIP712#1-2):"
	check fail 0 "$allowed\n$ir TokenPortal._EIP712Name ($OZ_EIP712#Shadow.sol#3-4):"
	check fail 0 "$allowed\n$ir TokenPortal.deposit:"
	check fail 0 "$allowed\n$ir Wrapper.f (src/$ir TokenPortal._EIP712Name ($OZ_EIP712#1-2):"
	echo "slither self-test: $n cases"
}

mkdir -p "$HOME/.cache/inference-money/forge"
dir=$(mktemp -d "$HOME/.cache/inference-money/forge/slither-XXXXXX")
trap 'rm -rf "$dir"' EXIT
if [[ ${1:-} == --self-test ]]; then
	self_test "$dir"
	exit 0
fi
forge build src --out "$dir/out" --cache-path "$dir/cache" --force --build-info >/dev/null
status=0
slither . --config-file slither.config.json --foundry-ignore-compile --foundry-out-directory "$dir/out" --fail-pedantic \
	2>"$dir/stderr" || status=$?
cat "$dir/stderr" >&2
mapfile -t contracts < <(src_contracts "$dir/out/build-info")
((${#contracts[@]})) || {
	echo "slither: the build declares no src/ contract" >&2
	exit 1
}
ir_gate "$status" "$dir/stderr" "${contracts[@]}"
