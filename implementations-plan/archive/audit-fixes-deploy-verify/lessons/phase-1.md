# Phase 1: creation binding

- viem 2.56.7's `deployContract` returns `sendRawTransaction`'s result, i.e. the RPC's echo. The deploy now prepares the request as `deployContract` would (`prepareTransactionRequest`), signs with the local account, hashes the signed bytes and compares the echo and the receipt against that hash. `mined()` checks the receipt hash for every write.
- A fake EIP-1193 provider (`viem` `custom` transport, `pollingInterval: 10`) is enough to unit-test the prepare → sign → sendRaw → receipt path; the honest case asserts the parsed signed tx's nonce, `to` and data.
- Anvil returns a creation tx's `input` as exactly `encodeDeployData(...)`: the local deploy's own verify printed `ok` for both creation checks (gate below).
- `buildBridgeContracts` now strips inherited `FOUNDRY_*`/`DAPP_*` and pins `FOUNDRY_PROFILE=default`; `contracts/evm/foundry.toml`'s fuzz-profile comment updated to match.

## Gate (passed)
- `bun run lint`, `bun run typecheck`, `bun run test` (every workspace, showcase components included): exit 0.
- `RUN_ID=deploy-verify bun run net:up` → `deploy:local` → `verify:local`: exit 0; `ok` for the portal and router creation-tx checks; manifest carries `portalTx`, `routerTx`.
