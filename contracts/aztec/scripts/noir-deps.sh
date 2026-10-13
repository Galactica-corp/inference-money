#!/usr/bin/env bash
# Fetches, then verifies, every Noir git dependency the crates resolve (transitive ones included) in nargo's cache.
# nargo fetches a missing entry on demand but never checks what an existing entry contains, so a retargeted tag or a
# stale or edited ~/nargo tree would compile silently. It relies on the entry's own git data, so it does not stand
# against a local attacker who can write the user's home (who could as well replace the toolchain binary). This
# script never compiles; compile.sh runs it first.
#
#   noir-deps.sh                    fetch missing entries, then verify every entry
#   noir-deps.sh --verify [--exact] verify only (no network); --exact also fails on any unpinned cache entry, which
#                                   after a build from a clean cache proves nargo fetched nothing outside the table
#   noir-deps.sh --self-test        prove fetch + verify against a local fixture repo in a scratch cache
#
# The table is the exact set a clean-cache `nargo check` of token, token_bridge and keystone fetches. Re-derive it when a
# Nargo.toml tag changes: resolve into an empty cache (HOME=<tmp> nargo check), then list <tmp>/nargo/**/.git.
set -euo pipefail

DEPS=(
  "https://github.com/aztec-labs-eng/aztec-nr v6.0.0-rc.3 694af4de4b196733819811c896867d5a9572a1b5"
  "https://github.com/AztecProtocol/aztec-packages v6.0.0-rc.6 0df91ba1799012435c62c6108a0926b357fef88c"
  "https://github.com/AztecProtocol/aztec-standards v6.0.0-rc.3 f7bf63d5041a8f0a082ac905e452befebbc10a21"
  "https://github.com/noir-lang/poseidon v0.3.0 0880c371e88e583d39515fd3f877538657ac41eb"
  "https://github.com/noir-lang/sha256 v0.3.0 9442e5b6856f98b2ec029882d7e90199ecff91ba"
  "https://github.com/noir-lang/keccak256 v0.1.3 f64ab3af714aa1a1e2699243037e0f11fe5bf706"
)

# nargo's layout: <cache>/<host>/<owner>/<repo>/<tag>
entry_dir() {
  local url="$1" tag="$2" path
  path="${url#*://}"
  path="${path#/}"
  echo "$cache/${path%/}/$tag"
}

fetch() {
  local url tag commit dir
  for d in "${DEPS[@]}"; do
    read -r url tag commit <<<"$d"
    dir="$(entry_dir "$url" "$tag")"
    [ -d "$dir" ] && continue
    echo "fetching $url@$tag"
    mkdir -p "$(dirname "$dir")"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$url" "$dir"
  done
}

# Returns non-zero (with reasons on stderr) unless every entry exists at its pinned commit with no local changes.
verify() {
  local url tag commit dir head bad=0
  for d in "${DEPS[@]}"; do
    read -r url tag commit <<<"$d"
    dir="$(entry_dir "$url" "$tag")"
    if [ ! -d "$dir/.git" ]; then
      echo "noir-deps: $url@$tag missing from $cache" >&2
      bad=1
      continue
    fi
    head="$(git -C "$dir" rev-parse HEAD)"
    if [ "$head" != "$commit" ]; then
      echo "noir-deps: $url@$tag is at $head, pinned $commit" >&2
      bad=1
    fi
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      echo "noir-deps: $url@$tag has local modifications in $dir" >&2
      bad=1
    fi
  done
  return "$bad"
}

# Returns non-zero unless every git checkout in the cache is a pinned entry.
exact() {
  local pinned=() url tag commit found bad=0
  for d in "${DEPS[@]}"; do
    read -r url tag commit <<<"$d"
    pinned+=("$(entry_dir "$url" "$tag")")
  done
  while IFS= read -r found; do
    found="$(dirname "$found")"
    if [[ " ${pinned[*]} " != *" $found "* ]]; then
      echo "noir-deps: unpinned entry $found" >&2
      bad=1
    fi
  done < <(find "$cache" -mindepth 2 -name .git -prune 2>/dev/null)
  return "$bad"
}

self_test() {
  local fixture first second fails=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  fixture="$tmp/src/fixture"
  mkdir -p "$fixture"
  git -C "$fixture" init --quiet
  echo 'fn a() {}' >"$fixture/lib.nr"
  git -C "$fixture" add lib.nr
  git -C "$fixture" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit --quiet -m one
  first="$(git -C "$fixture" rev-parse HEAD)"
  git -C "$fixture" -c tag.gpgSign=false tag v1
  echo 'fn b() {}' >>"$fixture/lib.nr"
  git -C "$fixture" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit --quiet -am two
  second="$(git -C "$fixture" rev-parse HEAD)"

  cache="$tmp/cache"
  DEPS=("file://$fixture v1 $first")
  local dir
  dir="$(entry_dir "file://$fixture" v1)"

  (fetch && verify) >/dev/null 2>&1 || { echo "SELF-TEST FAIL: empty cache did not end fetched + verified" >&2; fails=1; }
  echo 'fn evil() {}' >>"$dir/lib.nr"
  verify 2>/dev/null && { echo "SELF-TEST FAIL: a modified source was accepted" >&2; fails=1; }
  git -C "$dir" checkout --quiet -- lib.nr
  git -C "$dir" fetch --quiet origin "$second" && git -C "$dir" -c advice.detachedHead=false checkout --quiet "$second"
  verify 2>/dev/null && { echo "SELF-TEST FAIL: a wrong commit was accepted" >&2; fails=1; }
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "$first"
  git clone --quiet "file://$fixture" "$cache/src/stray/v9"
  verify 2>/dev/null || { echo "SELF-TEST FAIL: a plain verify rejected an unpinned sibling entry" >&2; fails=1; }
  exact 2>/dev/null && { echo "SELF-TEST FAIL: --exact accepted an unpinned entry" >&2; fails=1; }
  rm -rf "$cache/src/stray"
  exact 2>/dev/null || { echo "SELF-TEST FAIL: --exact rejected an exactly pinned cache" >&2; fails=1; }
  rm -rf "$dir"
  verify 2>/dev/null && { echo "SELF-TEST FAIL: a missing entry was accepted" >&2; fails=1; }

  [ "$fails" = 0 ] || exit 1
  echo "noir-deps self-test passed: empty cache fetched + verified; modified source, wrong commit, missing and" \
    "unpinned (--exact) entries rejected"
}

cache="${NARGO_CACHE:-$HOME/nargo}"
case "${1:-}" in
  --self-test) self_test ;;
  --verify)
    verify
    if [ "${2:-}" = --exact ]; then
      exact
      echo "noir-deps: ${#DEPS[@]} entries verified in $cache, and nothing else is cached"
    else
      echo "noir-deps: ${#DEPS[@]} entries verified in $cache"
    fi
    ;;
  "") fetch && verify && echo "noir-deps: ${#DEPS[@]} entries fetched + verified in $cache" ;;
  *) echo "usage: $0 [--verify [--exact] | --self-test]" >&2 && exit 2 ;;
esac
