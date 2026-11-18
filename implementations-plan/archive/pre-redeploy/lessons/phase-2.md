# Phase 2: #57, sinks refused

- `/opt/foundry/bin/forge` on PATH is 1.4.1; `toolchain.json` pins 1.7.1 (`~/.cache/inference-money/foundry-1.7.1`).
  `forge fmt` under 1.4.1 reflowed an untouched function: run every forge command with the pinned binary.
- halmos caught a fixture gap forge did not: `check_deposit_rejectsStaleRollup` assumes a valid refund address
  (`_assumeValidRefund`) and the guard runs first, so a symbolic depositor equal to the token, Inbox or Outbox now
  reverted `InvalidDepositor`. Extended the assumption; did the same for the fuzzed depositor in
  `PortalRoundtripFuzz` (forge's dictionary seeds deployed addresses).
- Gas: `test_gas_depositPublicDirect` 273 607 → 279 447 (+2.13 %, over the 2 % tolerance; forge isolates each call,
  so each pays a cold `outbox` read). The plan's < 2 % inference was wrong; snapshot regenerated (router public path
  +5 840 too, 0.94 %).
- Slither 0.11.6: 0 results (its EIP712 IR errors are pre-existing noise).
- Gate: test:evm 130/130 (badRefund canary trips); halmos-gate exactly the 15 expected proofs; gas check after
  regeneration exit 0; bridge-core 201/201; Medusa 300 s: 73 properties passed, exit 0.

LESSONS_FILE=implementations-plan/pre-redeploy/lessons/phase-2.md
