# Phase 3 lessons: Slither's IR gate and what the portal's missing SSA hides

## The gate on the real tree

`bun run test:evm:slither` (Slither 0.11.6, forge 1.7.1): the self-test passes 10 cases; the real run reports exactly the three allow-listed `TokenPortal` lines from OZ's `EIP712.sol` (constructor, `_EIP712Name`, `_EIP712Version`), none for the router or a `src/` source, and 0 findings. The other IR failures it logs are Aztec's rollup libraries under `node_modules/`, outside the filter.

## Measuring the known limit

Every allowed failure marks `TokenPortal` incorrectly constructed, and Slither then skips `add_ssa_ir` for each of its functions (`function_contract.py:138`). Data dependency is built from the SSA IR, and its non-SSA view is converted from that (`data_dependency.py`, `compute_dependency_contract`), so a portal function has no dependency facts at all, whichever variant a detector reads.

The probe: the same function, added locally to both contracts, run through `slither.sh`, then removed with `git checkout`:

```solidity
function ssaProbe(address from, uint256 amount) external {
    if (TOKEN.balanceOf(address(this)) == amount) revert(); // `underlying` in the portal
    address payer = <variant>;
    TOKEN.safeTransferFrom(payer, address(this), amount);
}
```

| Variant | `incorrect-equality` (reports when a balance flows into `==`) | `arbitrary-send-erc20` (reports when `from` does not flow from `msg.sender`) |
|---|---|---|
| `from` passed directly | router: reported; portal: **missed** | router: reported; portal: reported |
| `payer = from` | router: reported; portal: **missed** | router: reported; portal: reported |
| `payer = msg.sender` | router: reported; portal: **missed** | router: not reported (correct); portal: **reported, a false positive** |

So in the portal, a detector that reports when a dependency exists goes silent, and one that reports when a dependency is missing reports even correct code. 14 detector modules in 0.11.6 call `is_dependent`, `is_dependent_ssa` or `is_tainted` (among them `incorrect-equality`, `timestamp`, `arbitrary-send-eth`, `controlled-delegatecall`, `reentrancy-balance`, `missing-zero-check`, `encode-packed-collision`); only the two above were measured. The router has full SSA: every one of its functions lifts.

The false-positive side surfaces itself: any finding fails the gate, and someone reads it. The silent side is the limit worth recording: a new strict balance equality, or another dependency-shaped pattern, in a portal function would pass Slither. The forge, halmos and Medusa suites still cover the portal's behaviour; what is lost is Slither's dependency-based detectors on that one contract. Removing it needs Slither to lift OZ's `EIP712` bodies, or the portal to stop inheriting `EIP712`, a `src/` change outside this work. Filed at close-out as a `known-limit` issue, to be reopened when a Slither release lifts `EIP712.sol` (the gate then fails on the stale allow-list, which is the prompt to look).

## Tooling

- `slither.sh` exits 255 when Slither reports findings: the IR gate's `slither: exited 255` line confirms it keeps Slither's own status.
