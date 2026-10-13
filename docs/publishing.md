# Publishing to npm

One package is published: `@galactica-net/inference-money-core`, built from `packages/bridge-core`. Every other
workspace stays private.

| Subpath | Contents |
|---|---|
| `.` | The protocol SDK, the three Aztec artifacts (`contracts/aztec/*/target`), the L1 ABIs |
| `./deployments` | `deployments/testnet.json` as `TESTNET_MANIFEST`, and `DEPLOYMENTS` by network |
| `./deploy` | `deployBridge`, `deployTestBridge`, the admin and merchant calls, the L1 bytecode (`BRIDGE_EVM_ARTIFACTS`), the testnet pins |
| `./manifest`, `./rules`, `./types`, `./networks` | Leaf modules that load no Aztec SDK |

**Why one package.** `contracts/evm` and `contracts/aztec` are Foundry and Noir projects with no JavaScript entry; what
a dependent needs from them is their compiled output, which the package carries. One version therefore always pairs
the SDK, the artifacts and the addresses those artifacts derive: `deployments.test.ts` fails a package whose artifacts
do not land on a shipped address, and `deploy/evm-artifacts.test.ts` one whose L1 bytecode is not a fresh build's.
`packages/deployer` is the operator CLI (forge, git, keyed runs, a local network); its network-agnostic half lives in
`packages/bridge-core/src/deploy` and ships as `./deploy`.

**No key is published.** The testnet admin's secret stays in its keyed run (`docs/operations.md`). A dependent that
needs a merchant list of its own deploys an instance with `deployTestBridge`, whose deployer keeps both admin roles
(`docs/integration.md`, "Deploying your own test instance").

## What gets built

`packages/bridge-core/package.json` is `private` and exports its TypeScript sources, so the workspace needs no build
and the source layout cannot be published by accident. `bun run release:pack` writes the real package into
`packages/bridge-core/publish/` (gitignored): `dist/` (tsup bundles, declarations from `tsc -p tsconfig.build.json`),
the package README, the LICENSE, and a generated `package.json` without `private`, scripts and devDependencies, its
exports pointing at `dist/`, and `gitHead` naming the commit. It refuses a dirty tree; `PACK_ALLOW_DIRTY=1` is for dry
runs only. It then checks the result as npm would ship it: only built files, no `workspace:` dependency, every subpath
export loading under Node. CI runs the same on every bridge-core PR.

## A release

1. **Contracts changed?** Run the testnet sequence (`docs/operations.md`, "Testnet, in order") and commit
   `deployments/testnet.json`, `testnet-demo.json` and `testnet-tour.json`. A change to `contracts/evm` also needs
   `bun run --cwd packages/bridge-core embed:evm`, committed. An SDK-only release skips this step.
2. `bun run bridge verify deployments/testnet.json`: the deployment matches its manifest and this commit's code.
3. Bump `version` in `packages/bridge-core/package.json`, then `bun install` so `bun.lock` follows. Merge through the
   usual `dev` PR; release from the merged commit.
4. `bun run release:check`: lint, typecheck, bridge-core's tests (they build `contracts/evm` first), pack, smoke.
5. Publish, from a machine holding the npm login, never from a keyed run or from Actions:

   ```sh
   npm login && npm whoami          # a member of the @galactica-net organization, 2FA on
   cd packages/bridge-core/publish
   npm publish --dry-run            # the file list and the version, once more
   npm publish                      # public: publishConfig.access
   ```

   The generated manifest has no `workspace:` dependency, so plain `npm publish` is correct here.
6. `git tag core-v<version> && git push origin core-v<version>`.

npm versions are immutable: a broken release is fixed by the next version, and `npm deprecate` marks the bad one.

## Versions

- `0.x` while only testnet is shipped. A new deployment, a new `PROTOCOL_VERSION` or an Aztec release bump is a minor
  version; anything a dependent can take without changing code or addresses is a patch.
- The `@aztec-labs/*` dependencies are exact pins (`toolchain.json`'s `aztecJs`). A dependent on another Aztec release
  gets two copies of the SDK, whose classes do not mix: release a matching version instead.
- A dependent pins an exact version too: a minor can move the testnet addresses.

## Mainnet, later

Add `"mainnet"` to the manifest schema's `network`, commit `deployments/mainnet.json`, add it to `DEPLOYMENTS`
(`packages/bridge-core/src/deployments.ts`) and its pins beside `TESTNET` (`src/deploy/networks.ts`), and release
`1.0.0`. `deployments.test.ts` then holds the mainnet addresses to the shipped artifacts as well, so testnet and mainnet
must run the same contract code in any one version; a testnet-only contract change waits on a pre-release
(`npm publish --tag next`).

Publishing by hand needs no stored token. If releases become frequent, npm trusted publishing (OIDC) from a
tag-triggered workflow does the same without one, but it would be the first workflow here with a write permission
(`docs/ci-pipeline.md`).
