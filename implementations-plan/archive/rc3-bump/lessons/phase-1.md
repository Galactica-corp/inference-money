# Phase 1 — pins, locks, Noir deps, artifacts

## Supply chain (young set)

- **Resolution.** `bun install --ignore-scripts` in the root and both toolchains under temporary exact-name
  `minimumReleaseAgeExcludes` (root 42 names, toolchains 60). Nothing executed before the checks below.
- **The young set is exactly the new lock entries.** 61 `name@version#integrity` entries are new across the three
  locks; all 61 are under 7 days old. No non-Aztec entry was added or removed, and no package name appeared or
  disappeared: only `@aztec-labs/*` (rc.3) and `@aztec-foundation/*` (rc.6; aztec-standards rc.3) versions moved.
- **Registry integrity.** Every lock integrity equals the registry's `dist.integrity`.
- **npm audit signatures over the same set.** The 61 specs installed as direct deps (scripts off, `--force`) in an
  empty scratch dir: 1008 registry signatures and 258 attestations verified; all 61 on disk; every Bun lock integrity
  equals npm's package-lock integrity for that spec (61/61, 0 problems).
- **Provenance.** Every `@aztec-foundation/*` young package carries an SLSA v1 attestation from
  `AztecProtocol/aztec-packages` `refs/tags/v6.0.0-rc.6` at `0df91ba1…`, aztec-standards from
  `AztecProtocol/aztec-standards` `refs/tags/v6.0.0-rc.3` at `f7bf63d5…`; each attested sha512 equals the locked
  integrity. **`@aztec-labs/*` carry no provenance attestation**, at rc.3 or at rc.1: they are token-published by the
  same maintainer account as rc.1, with two registry signatures each. So their evidence is registry signature +
  integrity + unchanged publisher, not a source binding; the plan's expected aztec-node attestation does not exist.
  Not a regression.
- **The excludes are gone.** Removed from all three bunfigs; `git grep -n '^minimumReleaseAgeExcludes' -- '*.toml'`
  prints nothing. The plan's unanchored grep would have matched the root bunfig's comment, which names the key.

## I1 — frozen installs without excludes

- Copied only manifests, locks and bunfigs into an empty dir; `bun install --frozen-lockfile --ignore-scripts` with
  an empty `BUN_INSTALL_CACHE_DIR` in the root and both toolchains: all exit 0 (Bun 1.4.2 locally).
- Negative control: the same toolchain copy without its lock fails with `blocked by minimum-release-age: 604800
  seconds`, so the gate was live and only resolution consults it.
- CI runs Bun 1.4.0 (`toolchain.json`); the CI run confirms I1 there.

## Noir deps

- Clean-cache `HOME=<tmp> nargo check` of token, token_bridge and keystone (nargo 1.0.0-rc.3) fetched exactly six
  checkouts; each HEAD equals the tag's peeled commit from `git ls-remote`: aztec-nr v6.0.0-rc.3 `694af4de…`,
  aztec-packages v6.0.0-rc.6 `0df91ba1…`, aztec-standards v6.0.0-rc.3 `f7bf63d5…`, poseidon v0.3.0, sha256 v0.3.0,
  keccak256 v0.1.3 (the last three unchanged).
- keystone: `DOM_SEP__CONTRACT_ADDRESS_V2` → `_V3`; aztec-nr's crate-private `DOM_SEP__NOTE_RANDOMNESS`
  (2943528854) joins the distinctness list (75 → 76). Upstream's own separator test changed in exactly those two
  places between rc.1 and rc.3.
