# Phase 3: #59, initialize checks the expected rollup version

- The check is a virtual guard (`_requireRollupVersion`) like the others, so `PortalWithoutVersionCheck` deletes one
  rule and the canary runs `proveRejectsVersionMismatch` against it.
- Solidity cannot read a contract's constant as `FakeRollup.VERSION` from outside it (error 9582, "not visible after
  argument-dependent lookup"); existing tests read `rollup.VERSION()` on an instance. Added a file-level
  `FAKE_ROLLUP_VERSION` in `AztecFakes.sol` for the call sites (one is a free function in `MockPortal.sol`).
- The prank trap again (`lessons.md`, Foundry): `vm.prank(stranger); fresh.initialize(..., rollup.getVersion())`
  spent the prank on the argument's read, so the initializer called and SP-15 reported "a stranger initialized a
  fresh portal". Every pranked `initialize` now takes the constant.
- Negative control: with the guard call commented out, `test_initializeRefusesACanonicalRollupOfAnotherVersion`
  fails ("next call did not revert as expected"); restored.
- The deploy passes the node's `info.rollupVersion`, the value the manifest records, so `portal.rollupVersion` equals
  `m.l2.rollupVersion` by construction; testnet's `probeNetwork` already pinned that to `TESTNET.rollupVersion`.
- Gate: test:evm 132/132; halmos-gate exactly 16 proofs; gas check exit 0 (initialize is not snapshotted); Slither 0;
  typecheck exit 0; deployer 89/89; lint exit 0.

LESSONS_FILE=implementations-plan/pre-redeploy/lessons/phase-3.md
