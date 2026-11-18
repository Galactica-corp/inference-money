# Phase 4 lessons: the PR Medusa job and the nightly fork suite

## Fork suite through PublicNode

| Attempt | Result | Why |
|---|---|---|
| PublicNode, fork at the head | failed in `setUp` after 6 s: `failed to get account … block not found: 0xb5e52b` | `createSelectFork(rpc)` took the head from one backend; the next read hit a backend that did not have that block yet (a head read straight afterwards returned `0xb5e52c`) |
| `https://1rpc.io/sepolia` (diagnosis only) | failed at `createSelectFork`: `cu limit exceeded; Request too fast per second` | a keyless rate limit; tells nothing about the suite |
| Director's call (QUESTION → A) | `vm.rollFork(block.number - 8)` right after `createSelectFork`, test code only | 8 blocks is well inside a full node's recent-state window, and every backend has it |
| PublicNode, rolled back 8 blocks, three runs | 12/12 each, 9 s, 3 s and 2 s of wall clock (the suite itself 1.3 s, 1.3 s, 0.2 s) | — |

Lesson: a load-balanced public RPC is a set of nodes with their own heads, so a fork at `latest` races them. Fork a few blocks back.

## Workflows

- `bun run lint:actions` passes on `contracts.yml`, `_contracts.yml`, `fuzz-contracts.yml` and the new `fork-contracts.yml`.
- `fork-contracts.yml` cannot be dispatched before it is on the default branch (F8); the default branch is `dev`, so its first run is the nightly after this PR merges, or a dispatch then.
- The PR's `medusa` job measures I3 on its first run (this PR touches `contracts/evm/**`).

## Codex fix loop (`gpt-6.1-sol`, `high`)

Round 1, session `01a13fbc`. Verdict: request changes, with two coverage gaps and one parser escape, and no production regression. Each claim was checked against the code:

| # | Finding | Verdict | Fix |
|---|---|---|---|
| 1 | A `src/` contract other than the two named ones that inherits an unliftable OZ body is logged with the dependency's file, so the gate ignored it | real (any new `src/` contract inheriting `EIP712`) | `slither.sh` derives the contract names from the declarations under `src/`; new fixture `Wrapper._EIP712Name` from `EIP712.sol` |
| 2 | `adv_depositLiveness` required the 1 % surcharge margin in Normal mode too, skipping funded deposits at the supply cap | real (a coverage loss, no false pass) | the margin applies only under `SenderSurcharge` |
| 3 | A `#` inside a file name cut the source at the first `#`, so `EIP712.sol#Shadow.sol` matched the allow-list | real, but needs a crafted file name under `node_modules` | the line range is parsed as the last `#N[-M]`; an IR failure line that does not parse fails the gate; two fixtures |
| 4 | A handler comment restated its call; the fork comment claimed more than eight blocks guarantee | fair | comment deleted; the fork comment now says "well past that lag" |

Round 2 (resumed): round-1 #2 and #4 confirmed closed, #3 closed for its reproducer; two escapes remained, both in `slither.sh`:

| # | Finding | Verdict | Fix |
|---|---|---|---|
| 1 | The declaration grep missed `/* c */ contract X`, two declarations on a line and a name on the next line | real (layouts forge fmt does not produce today, but a grep is the wrong source) | names come from the build's own `build-info` (`output.contracts` keyed by `src/` sources) through `jq`; the self-test checks the discovery against a fixture build-info |
| 2 | Lines were counted, not markers, so a line holding the marker twice parsed as its last occurrence | real only with a crafted `src/` file name, but a one-word fix | markers counted with `grep -o … \| wc -l`; fixture added |

Round 3 (resumed, final): approve, no new findings; both round-2 fixes verified closed, the doubled-marker fixture shown non-vacuous (passes on the old count, fails on the new).
