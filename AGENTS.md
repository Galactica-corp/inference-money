# inference-money

A USDC-only bridge between Ethereum (L1) and Aztec (L2), so users can hold USDC privately on Aztec and pay for private inference (x402).

## Layout

| Path | What |
|---|---|
| `contracts/evm` | Foundry: `TokenPortal` (L1 escrow, Aztec messaging) and `Permit2DepositRouter` |
| `contracts/aztec` | Aztec.nr: `token` (the merchant fork of aztec-standards' Token), `token_bridge`, `token_minter_proxy`, `claim_secret`, `merchant_stamp`, `portal_messages` (the L1↔L2 message contents), `keystone` (cross-toolchain vectors) |
| `packages/bridge-core` | Framework-agnostic protocol logic: hashes, secrets, Permit2 typed data, deposit/claim/exit/withdraw, the manifest schema, the merchant list and payment requests; `src/deploy`: the network-agnostic deploy and admin calls and the committed L1 bytecode. The one package published to npm, as `@galactica-net/inference-money-core` (`docs/publishing.md`) |
| `packages/local-network` | Per-run anvil + Aztec local network (`toolchain.json`'s node): registry-claimed ports, owned process groups |
| `packages/deployer` | The operator CLI (`bun run bridge`): deploy, admin handover, merchants, pause, verify, export, the demo and the acceptance run; keyed-run plumbing |
| `packages/demo` | The demo cast (public keys derived from a deployment), its flows (deposit, claim, send), the recorded tour's schema and the world-view decoder; browser-safe, shared by the deployer and the showcase |
| `packages/integration` | bridge-core flows end to end against a per-run local network with the bridge deployed |
| `apps/showcase` | The demo showcase (React): "Try it yourself" (the default; `#live` too) drives one embedded Aztec wallet holding the demo cast, proving through Presto once the visitor connects it, and "Watch a recorded run" (`#recorded`) replays the recorded run; a build-embedded manifest, users' tag and recording; `e2e/` holds the browser suite and the proving harness (`#proving`) |
| `implementations-plan/` | Plans: `index.md` lists the active ones, `lessons.md` and `follow-ups.md` are the curated layer, closed plans live under `archive/` |

## Commands

```sh
bun install
bun run lint          # biome + sort-package-json + shellcheck
bun run typecheck     # tsc --noEmit per workspace
bun run test          # every workspace's unit tests
bun run lint:actions  # actionlint
bun run probe:testnet # keyless: pins, L1 wiring, assets, fee faucet budget

# RUN_ID (default "default") names the run; concurrent runs in any checkouts never share ports, processes or state
RUN_ID=a bun run net:up        # anvil + the pinned aztec local network, detached; net:status / net:down
RUN_ID=a bun run deploy:local  # deploy, verify every read-back, then write deployments/local/<run>/manifest.json
RUN_ID=a bun run verify:local  # re-verify the manifest against a fresh forge build --force
bun run test:integration      # own network + deploy, every spec, teardown; then the clock specs on a network of their own
                                # attach to a running network (NET_L1_RPC + NET_NODE_URL): bun run --cwd packages/integration test:specs
bash packages/local-network/scripts/install-node.sh <dir>  # CI's node: frozen lock + sha-pinned Foundry; AZTEC_NODE_HOME=<dir> selects it

bun run --cwd apps/showcase test:components      # vitest: components, build target, bundle check, proving decision
BRIDGE_MANIFEST=<file> bun run --cwd apps/showcase build   # a deployed manifest with its published demo; build:testnet pins deployments/testnet.json
bun run test:e2e [-- tour.spec.ts]                # own network + deploy + sidecar + demo setup + build + Playwright, then reap
bun run test:e2e:presto [-- presto.spec.ts]      # own network + deploy + demo setup + real-proof build + pinned presto-server behind an HTTPS proxy
bun run --cwd apps/showcase test:proving         # real proofs in the browser, unconstrained and on 2 CPUs → test-results/proving.json
SHOWCASE_URL=<url> bun run --cwd apps/showcase test:testnet   # the served showcase, live on testnet (a Workers preview, or production)

bun run bridge <command>                         # the operator CLI; every command and the keyed-run recipe: docs/operations.md
bun run bridge verify deployments/testnet.json   # keyless strict read-back (--node/--l1-rpc: your own endpoints)
RUN_ID=a bun run bridge demo setup local && RUN_ID=a bun run bridge smoke local   # the demo cast, then the acceptance run
bash scripts/keyed-worktree.sh sync              # the checkout keyed runs execute from (installs with --ignore-scripts)
bun run release:pack     # the npm package into packages/bridge-core/publish, then checked as npm would ship it
bun run release:check    # lint, typecheck, bridge-core's tests, release:pack; the release steps: docs/publishing.md
bun run --cwd packages/bridge-core embed:evm   # after a contracts/evm change: rebuild, rewrite src/deploy/evm-artifacts.json
bun run secrets:scan     # yes/no only: any of this environment's secrets in the checkout or the caches, any wallet store left on disk

bun run test:evm        # forge fmt --check, forge lint src, unit + fuzz + invariant (hermetic)
bun run test:evm:formal # halmos, strict: exact proof names and counts (scripts/halmos-gate.sh)
bun run test:evm:gas    # .gas-snapshot --check --tolerance 2
bun run test:evm:slither # Slither over src/ from its own build; any finding fails (slither.config.json, inline reasons)
bun run test:evm:fuzz [-- <seconds>]  # Medusa over test/fizz (default 3600 s; nightly in CI); properties: contracts/evm/PROPERTIES.md
SEPOLIA_RPC_URL=… bun run test:evm:fork  # real Permit2, Circle USDC, Aztec registry + Inbox; refuses to run unset

bun run test:noir                                     # TXE suites (token, token_bridge, keystone), manifest-gated
bash contracts/aztec/scripts/noir-deps.sh             # fetch + verify the pinned Noir git deps (--self-test)
bash contracts/aztec/scripts/compile.sh [--check]     # rebuild artifacts; --check: committed == source (class id + ABI)
bash contracts/aztec/scripts/check-sole-consumer.sh   # static guard: the four consume sites and the bridge's rules (--self-test)
bash contracts/aztec/scripts/check-stamp-constraint.sh  # static guard: a stamped payment's settled check and deadline cap; the published side proven (--self-test)
```

## Rules

- **Branches:** `main` is what Galactica sees, deployed to production by Workers Builds; every other branch gets a preview. Fixes target `dev` and are squash-merged; `dev` reaches `main` only through a `dev`→`main` PR merged with a merge commit, never a squash, so the two never diverge. A stack's trunk is `dev` (`gh stack init --base dev <branch>`). Both branches take changes only through a PR with every `*-status` check green (`docs/ci-pipeline.md`, Branches).
- **One source of truth for versions:** `toolchain.json` (Aztec node/JS/Noir, nargo, Foundry, halmos, Slither, solc, Bun, the e2e's presto-server, whose digest `apps/showcase/e2e/run/` pins). `@aztec-labs/*` npm packages are pinned exactly to `aztecJs`, except `contracts/aztec/toolchain` (the Noir scripts' aztec CLI, bb and TXE), pinned to `noir`; `@aztec-foundation/*` ones exactly to what `@aztec-labs/aztec.js@<aztecJs>` itself pins (their own release numbers: 6.0.0-rc.6 for 6.0.0-rc.3), except `aztec-standards`, at the `noir` tag the Nargo.toml files name. Never bump one without the others it couples to (`docs/ci-pipeline.md`, Bumping Aztec).
- **Secrets:** testnet keys reach only the environment of one owner-approved keyed run (`env-exec`, from the keyed worktree, whose install skips scripts), are read in-process, and are never printed, logged, passed on argv or written anywhere (the CLI re-runs itself as a redacted child whenever its environment holds one). The CLI's entry point never imports the Aztec SDK, whose import spawns a native bb with the process environment: it moves the secrets out of `process.env` first, then loads the handlers. It starts only under `bun --no-env-file` (its package scripts and its redacted child pass the flag), so a `.env` in the working directory never reaches it. While a keyed run is live, nothing is installed, built, tested or committed on the host. Aztec wallet/PXE stores (LMDB temp files even when "ephemeral") run inside `withOwnedTmpDir` (deployer).
- **No agent generates operational keys**, with one owner-authorized exception: the disposable testnet fallback (`bridge disposable`), drawn in-process into a 0600 file outside every checkout, never printed, logged or passed on argv, and destroyed after the admin switch.
- **Demo keys are not secrets:** derived in `packages/demo` from the deployment and a published users' tag and merchants' salt, demo funds only, never an admin or minting role, merchant-listed only on local and testnet. Agents may use them without a keyed run.
- **Secrets come from the platform CSPRNG, never `Fr.random()`:** with `SEED` in the environment the Aztec SDK draws every value from a 32-bit counter. Draw with `randomSecret` (bridge-core); the CLI refuses to run while `SEED` is set.
- **Complexity budgets:** cognitive complexity ≤ 15 everywhere; ≤ 80 non-blank lines per production function. Never suppress complexity rules in new code.
- **Comments** say what the code can't (invariants, external gotchas, non-obvious whys); never narrate, never reference plans or reviews.
- **Solidity deps come from npm** (`@openzeppelin/contracts`, `@aztec-foundation/l1-artifacts`, remapped to the `@aztec/` import prefix) and forge-std from a pinned GitHub commit (the npm `forge-std` is an unofficial repackage). `foundry.toml` remaps through `contracts/evm/node_modules` with relative targets so build metadata reproduces across machines, and sets `bytecode_hash = "none"` so a comment edit never changes deployed bytecode (`verify` compares against a fresh build). Foundry and halmos move together: a newer Foundry breaks halmos 0.3.3. CI installs halmos and Slither from hash locks of their whole trees (`.github/actions/setup-toolchains/<tool>-<version>.requirements.txt`): a bump of either regenerates its lock.
- **Formal canaries:** every halmos `check_` delegates to a public `prove*` body, and a forge canary runs that body against a one-rule-deleted mutant (`test/mocks/Mutants.sol`) and requires it to fail on that rule's assertion (`ProofCanary`). A new proof needs its mutant, its canary, and its (contract, name) pair in `scripts/halmos-gate.sh`.
- **The published package is generated, never hand-edited:** `packages/bridge-core/package.json` stays `private` with source exports; `scripts/pack.ts` derives the published manifest from it, and a new subpath export needs its entry in `tsup.config.ts` under the same name. The committed L1 bytecode (`src/deploy/evm-artifacts.json`) must equal a fresh forge build, and the shipped manifests must be derived by the committed Noir artifacts; bridge-core's tests check both. `src/deploy/networks.ts` stays a leaf file.
- **Noir artifacts are committed and must equal their source:** rebuild only through `contracts/aztec/scripts/compile.sh` (a bare `nargo compile` writes an untranspiled artifact and skips the pinned-dependency check compile.sh runs first), and run `compile.sh --check` before committing a `.nr` change. A new Noir git dependency, direct or transitive, goes into `noir-deps.sh`'s pinned table or CI's `--exact` step fails.
- **The token stays an ABI superset of aztec-standards' Token, upstream storage first:** every upstream function keeps its selector, signature and attributes, new storage appends after upstream's, and `contracts/aztec/scripts/abi-superset.test.ts` lists every addition, so integrations written against upstream keep working.
- **Request stamps expire:** a stamp carries its opening's hour and is live 25 hours; a private payment through one caps its tx at the stamp's deadline, and clients send it only while that cap is above the standard 82 800 s expiry (`STANDARD_TX_LIFETIME`). `paid(c)` makes a request take one payment. The clock specs (`packages/integration/clock`) move their network's clock, so they never attach to another run's.
- **Rule checks are private reads, never public calls:** a merchant check proves the register and the switch-off entry at the tx's anchor block. A public call would publish both accounts of every private transfer.
- **Private rule checks never go public:** a private function checks merchant status with `try_prove_merchant` and a binding through its owner's notes, never by enqueueing a public call, which would publish the checked address.
- **TXE manifests:** every new Noir test gets its name in the crate's `txe-manifest.txt`; `run-txe-tests.sh` fails on a listed test that did not pass or a count under the crate's floor.
- **One network per bundle:** a showcase build embeds exactly one manifest and its published users' tag and merchants' salt at build time and has no runtime override; it builds keyless (a keyed variable in its environment fails the build), and `build:testnet` refuses every override.
- **The showcase's build config loads under Node:** what `build/target.ts` imports stays a leaf module (no extensionless relative import, nothing that loads the Aztec SDK, which starts bb on import): `bridge-core/manifest`, `demo/files`, `deployer/networks`, `local-network/handle`.
- **bun test and the Aztec SDK:** a cold `bun test` injects its `expect` into `@aztec-labs/foundation`, which then calls Jest's `expect.addEqualityTesters`; every bun test script that loads `@aztec-labs/*` passes `--preload ../../test-preload.ts`. A warm transpiler cache hides a missing preload locally (`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` reproduces CI).
- **bb.js does not run under jsdom** (its msgpack rejects jsdom's cross-realm typed arrays): showcase tests that hash through real bridge-core use `// @vitest-environment node`; jsdom component tests fake the wallet layer.
- **One viem:** bridge-core and web read L1 through canonical `viem`; `@aztec-labs/ethereum` is banned there (biome `noRestrictedImports`).
- **Run isolation:** local networks claim ports from `~/.agents/ports.md`, spawn detached, and tear down only the process groups they prove they own (leader pid and start time, or once the leader exits a member carrying the group's `INFERENCE_MONEY_OWNER` marker; unprovable means untouched); data dirs live on real disk under `~/.cache/inference-money/`. Deploys build forge output into a per-run dir, never the shared `contracts/evm/out`.
- **Standard contracts:** a local network seeds only AuthRegistry and testnet none of the standard contracts aztec-nr reaches in public; the deploy publishes whichever the node lacks.
