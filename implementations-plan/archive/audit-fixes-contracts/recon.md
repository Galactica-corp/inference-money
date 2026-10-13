# Recon: audit-fixes-contracts

Base: `dev` at `ad77d10`. One batched reuse sweep (Sonnet) plus direct reads of the token, the bridge, the pinned aztec-nr v6.0.0-rc.1 delivery sources and the rc.1 PXE.

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| Self-delivery primitive | aztec-nr rc.1 `MessageDelivery::onchain_unconstrained().via_address_derived_secret()` (`messages/delivery/builder.nr`; `TagDerivation::address_derived`, `tag_derivation.nr`) | reuse-as-is |
| Precedent for an unconstrained self-delivery | `contracts/aztec/token_bridge/src/main.nr:180` (binding note, `onchain_unconstrained()` unpinned) | reuse the pattern |
| The delivery sites | token `_decrease_private_balance` (`main.nr:916-924`), `_increase_private_balance` (`:929-934`), `_mint_to_private` (`:1046-1049`); callers `:241,267,302,333,1067` and `:304,369,1047` | adapt (the only three sites) |
| Minter identity in private | `self.storage.minter.read()` (`PublicImmutable`, already read in `mint_to_private`, `:576`) | reuse-as-is |
| Proxy surface into the token | `token_minter_proxy/src/main.nr:69-93`: `mint_to_public`, `burn_public`, `mint_to_private`, `burn_private`, each `assert_bridge`-gated | facts only |
| Integration harness, actors | `packages/integration/test/{harness,actors,token}.ts`: `harness()`, `INTEGRATION`, `l1Actor`, `merchantActor`, `deposit`, `claimable`, `claimFor`, `l2Balances`, `payFor`, `as` | reuse-as-is |
| An account whose secret the spec keeps | `newSponsoredAccount(wallet, m, secret)` (`packages/deployer/src/local-actors.ts:11`); `l2Actor()` drops the secret | reuse-as-is |
| A second wallet on the same keys | `openBridgeWallet(node, {prove:false})` + `registerBridgeContracts` + `createSchnorrAccount(secret, Fr.ZERO, signingKeyFor(secret))` + `stop()`; precedent `operator.test.ts:246-255` | adapt (inline in the spec) |
| Private exit helper | `exitToL1(intent, wallet, node, manifest, {fee: payFor(kind)})`, wrapped in `exits.test.ts:23` | reuse-as-is |
| Querying private logs by tag | `packages/bridge-core/src/payments.ts:116-127` (`SiloedTag`, `node.getPrivateLogsByTags`); the registry's announcement-tag formula (`computeLogTag` + `computeSiloedPrivateLogFirstField`) | adapt: a spec-local `handshakeTag` |
| HandshakeRegistry address | none in the repo (searched `HandshakeRegistry`, `0x1d6c`, `standard_addresses`): aztec-nr `STANDARD_HANDSHAKE_REGISTRY_ADDRESS` | build new (one spec constant, value from aztec-nr) |
| CSPRNG secret | `randomSecret()` (`packages/bridge-core/src/random.ts`) | reuse-as-is |
| TXE merchant helpers | `contracts/aztec/token/src/test/merchants.nr:1-23` (`status`, `roles`, `at`, `DAY`, `HOUR`), `utils::setup_merchant_world` | reuse-as-is |
| TXE pin of a delivery mode or tag | none (searched `tag|delivery|onchain_|discover|announce|handshake` in both crates' `src/test`) | not possible: TXE runs no registry; integration only |
| `registerSender` | zero code uses (only `follow-ups.md:25`, an archived plan) | nothing to change |

## Collisions and dependents

- `merchants.nr:200-205` `sync_merchant_delay_is_admin_only` fails once the check goes: delete it and its manifest line (`txe-manifest.txt`, 183 names, floor 181 in `run-txe-tests.sh`).
- `contracts/aztec/PROPERTIES.md` GL-22 (`:258-270`) lists `sync_merchant_delay` as admin-only; SP-23 (`:795-802`) covers the no-op. `docs/assurance-map.md` A20 names `sync_merchant_delay_is_admin_only`.
- `packages/deployer/src/admin.ts:115` (`merchants delay`) syncs as the admin: unaffected. bridge-core `rules.ts` `notAdmin` stays (other functions).
- `abi-superset.test.ts` lists `sync_merchant_delay` by name only; selectors and signatures do not change. Its public-bytecode ceiling (2700 fields) only shrinks.
- `check-sole-consumer.sh`, `check-stamp-constraint.sh`: no pattern on any touched line.
- No doc says where notes are announced: `docs/integration.md` "What each action makes public" (`:114-120`) is the place.
- `docs/assurance-map.md` has cells A1-A30; other batches may add cells too (renumber at rebase).

## Absence trail

- Restored-wallet spec: none. `binding.test.ts` [A23] reads the binding from the wallet that claimed; `exits.test.ts` [A5] never rediscovers.
- Repo use of `sendMessagesAs` / `registerSender`: none (`grep -rn` over `packages`, `apps`).
