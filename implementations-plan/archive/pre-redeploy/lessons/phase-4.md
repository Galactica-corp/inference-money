# Phase 4: the demo merchants' salt

- The null salt reproduces the old derivation exactly: galactica's address from HEAD's `castMember` and from the new
  one with `merchantsSalt: null` both came out `0x2b388c…8152` (scratch script, deleted), and alice's is unchanged.
  `files.test.ts` pins that v1 address and a v2 one.
- `verify` keeps checking the unsalted merchant addresses with no demo published, and adds a published v2 demo's
  salted ones: the unsalted keys are derivable for any deployment, so dropping them on "none published" would have
  weakened the mainnet rule. The plan's "none published passes" holds: nothing is listed there.
- `keptSalt` runs whenever a demo is published, not only on `--rotate`: a stored plan resuming over a v1 demo
  predates the salt too, and its plan has no salt to resume with.
- `demo fund` no longer derives a cast key at all: its Fee Juice claim goes through `sponsorClaimer`
  (`ensureAccount`, sponsored deploy), so it runs before `demo setup` as the runbook orders it.
- The committed testnet demo is v1, so `build:testnet` exercises the null path: it embeds `merchantsSalt: null`.
- Gate: lint exit 0; typecheck exit 0; `bun run test` (cold transpiler cache) bridge-core 201, local-network 16,
  demo 15, deployer 90, showcase 99 passed and 5 skipped, all exit 0; `build:testnet` exit 0 with its 7 bundle checks.

LESSONS_FILE=implementations-plan/pre-redeploy/lessons/phase-4.md
