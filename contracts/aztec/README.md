# contracts/aztec

Aztec.nr side of the USDC bridge, pinned to aztec-nr **v6.0.0-rc.3** (the `noir` entry in `toolchain.json`).

| Crate | Type | Role |
|---|---|---|
| `token` | contract | `merchant_token`: aztec-standards' Token plus a merchant list; private transfers, requests and payments need a merchant on one side. |
| `token_bridge` | contract | Consumes L1→L2 deposit messages: claims (public ones for merchants only) or returns to the depositor. Binds each account to the Ethereum address of its first private claim; burns + messages L1 on exit, a user's only to that address; owner pause. |
| `token_minter_proxy` | contract | Sole minter of the standards `Token`; only the bridge may mint or burn, fixed once at bootstrap. |
| `claim_secret` | lib | `derive_claim_secret(salt, recipient)`: binds a private deposit to its recipient. |
| `merchant_stamp` | lib | The token's request `stamp`/`pad` nullifiers and side-hint capsule slot, shared with the keystone. |
| `portal_messages` | lib | The L1↔L2 message contents `TokenPortal.sol` commits: deposits name their depositor, withdraw is canonical. |
| `keystone` | bin | Literal vectors pinning the Noir content hashes, claim-secret derivation and stamps to the Solidity and TS ones. |

The three contract artifacts in `*/target/` are committed: the SDK and deployer import them and CI does not rebuild them
to deploy.

## Commands

nargo comes from `aztec-up install 6.0.0-rc.3`, or `NARGO=<path>` to the noir-lang release (the scripts check it is `toolchain.json`'s `nargo`). The aztec CLI, bb and
the TXE server come from `toolchain/`, a committed lockfile installed with `--frozen-lockfile` on first use.

```sh
bash scripts/noir-deps.sh            # fetch + verify every Noir git dependency against its pinned commit
bash scripts/compile.sh              # rebuild the contract artifacts (nargo + AVM transpile + path scrub)
bash scripts/compile.sh --check      # fail unless the committed artifacts are exactly what the source builds
bun run test:noir                    # TXE suites for token, token_bridge and keystone, each gated by its txe-manifest.txt
bash scripts/check-sole-consumer.sh  # static guard: four consume sites and the bridge's rules (add --self-test to prove it bites)
bash scripts/check-stamp-constraint.sh # static guard: a stamped payment proves its stamp settled and caps at its deadline; a refund commitment is never stamped (--self-test)
```

Never run a bare `nargo compile`: it overwrites a committed artifact with an untranspiled one that aztec.js rejects.
`scripts/nargo.sh <crate> <args>` runs the pinned nargo for anything else.
