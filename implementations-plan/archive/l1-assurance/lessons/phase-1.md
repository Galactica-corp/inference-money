# Phase 1 lessons: real Permit2 in the fizz harness

## Tooling

- The Slither venv's shebangs pointed at its old path after the tools directory moved. Fix: recreate it from CI's hash lock (`python3 -m venv`, `pip install --require-hashes --no-deps --only-binary :all: -r .github/actions/setup-toolchains/slither-0.11.6.requirements.txt`) under `~/.cache/inference-money-audit-tools/slither`.
- `forge` on the default PATH is 1.4.1; the pinned 1.7.1 is under `~/.cache/inference-money/foundry-1.7.1/bin`.
- Medusa's `--timeout` bounds the fuzzing loop, not shrinking: a 120 s campaign with two failing properties ran 733 s, shrinking each failure for 5000 attempts. Local runs need a hard wall clock (`timeout -k 10 <s>`), and compiling alone takes about 58 s.

## Medusa failures after the switch to the real Permit2

1. **GL-13 (supply accounted)**: a harness regression. The unclamped `tokenPortal_depositToAztecPublic` gained a free refund address, so a return paid USDC to an address outside the actors GL-13 sums. Fix: the public handler refunds to the calling actor; only the clamped one draws another actor's address (`_depositToAztecPublic`, internal).
2. **GL-34 (foreign signature refused)**: the router leg got an empty revert, not `SignerIsNotTheCaller`. It reproduced only under Medusa; forge ran the same call cleanly on chain ids 31337, 1 and 11155111.
   - Coverage showed the cause was wider than GL-34: the router entered `permitDigest` 28 123 times, never reached `_requireSigner`, and never reached the line after the pull. No router deposit succeeded in the campaign. Handlers that read the nonce bitmap reverted wholesale, which fails no property, so only GL-34, whose leg uses nonce 0 without reading Permit2 first, exposed it.
   - Ruled out: Permit2's code went missing (a probe read 9152 bytes at the address mid-campaign; setting its nonce to 1 changed nothing).
   - Diagnosis: a temporary `assert` in the handler on an empty revert made Medusa print that call's trace. The router's `DOMAIN_SEPARATOR()` staticcall into the etched code failed with `vm error: stack underflow (0 <=> 1)`.
   - Fix: deploy the vendored runtime with `CREATE` behind a 12-byte init stub (`Base._deployRuntime`). The keccak pin still holds and no `etch` is needed. On any chain id but Sepolia's, Permit2 rebuilds its domain separator from its own address, and SP-23 checks that separator against the harness's own.
3. **GL-21 (boundary refused)**: once router deposits ran, the routed over-field probe could be refused before the portal's field rule. Two gaps:
   - a non-Normal token mode or a switched rollup;
   - an actor left unfunded at the mock supply cap, which fails the Permit2 pull.

   Fix: the probe returns unless `_depositEnvClean()` and `_ensureFunds` both hold, like the other deposit probes. The guard alone did not clear the failure when the corpus replayed.

Lesson: after replacing a dependency in a fuzz harness, check in coverage that the line past the replaced call is reached, not only that properties pass.
