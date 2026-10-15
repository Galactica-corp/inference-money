# @galactica-net/inference-money-core

The inference-money USDC bridge between Ethereum and Aztec, as one package: the protocol SDK, the three Aztec contract
artifacts, the L1 ABIs and bytecode, the testnet deployment, and a deploy library for instances of your own.

```sh
bun add @galactica-net/inference-money-core   # or npm install
```

It is ESM only, and its `@aztec-labs/*` dependencies are pinned to the exact Aztec release the contracts were compiled
for: use the same one in your own package.

| Import | What |
|---|---|
| `@galactica-net/inference-money-core` | Deposit, claim, pay, exit and withdraw flows, the rules and their refusals, `tokenArtifact`, `tokenBridgeArtifact`, `tokenMinterProxyArtifact`, `TOKEN_PORTAL_ABI`, `PERMIT2_DEPOSIT_ROUTER_ABI` |
| `…/deployments` | `TESTNET_MANIFEST`, `DEPLOYMENTS`: every address and instance record of the deployments this version ships |
| `…/deploy` | `deployTestBridge`, `deployBridge`, `addMerchants` and the other admin calls, `BRIDGE_EVM_ARTIFACTS`, the `TESTNET` pins, the local-network helpers (`installCanonicalPermit2`, `startBlockHeartbeat`) |
| `…/manifest`, `…/rules`, `…/types`, `…/networks` | Leaf modules that load no Aztec SDK: the manifest schema, the refusal strings, shared types, the testnet pins |

## The testnet deployment

```ts
import { registerBridgeContracts, registerSponsor } from "@galactica-net/inference-money-core"
import { TESTNET_MANIFEST } from "@galactica-net/inference-money-core/deployments"

await registerSponsor(wallet, TESTNET_MANIFEST)
await registerBridgeContracts(wallet, TESTNET_MANIFEST) // refuses an artifact that does not derive the recorded address
console.log(TESTNET_MANIFEST.l2.token.address, TESTNET_MANIFEST.l1.portal)
```

Its merchant list is curated by an admin whose key is not published. To list merchants of your own, deploy an instance.

## An instance of your own

```ts
import { addMerchants, deployTestBridge, l1Signer, TESTNET } from "@galactica-net/inference-money-core/deploy"

const { manifest, admin } = await deployTestBridge({
	network: "testnet",
	node,
	nodeUrl: TESTNET.nodeUrl,
	wallet, // an EmbeddedWallet with proving enabled
	l1: l1Signer(sepoliaRpcUrl, TESTNET.l1ChainId, privateKeyToAccount(key)), // needs Sepolia ETH
	deployerSecret, // your own Fr: its account deploys, and stays bridge owner and merchant admin
	usdc: "mock", // a freely mintable stand-in; or TESTNET.usdc for Circle's
	permit2: TESTNET.permit2,
	registry: TESTNET.registry,
})
await addMerchants({ wallet, m: manifest, node }, admin, [merchant])
```

Keep the returned manifest (it is plain JSON) and reuse it across runs: a deploy proves and sends about ten
transactions. Test deployments only: one key holds every role, and nothing is verified against a fresh build.

On a local network (anvil and the Aztec local network) Permit2 is not deployed, and a block is built only when a tx
arrives:

```ts
import { registerSponsor } from "@galactica-net/inference-money-core"
import { deployTestBridge, installCanonicalPermit2, l1Signer, startBlockHeartbeat } from "@galactica-net/inference-money-core/deploy"

const l1 = l1Signer(anvilUrl, 31337, anvilAccount)
const { manifest } = await deployTestBridge({
	network: "local",
	node,
	nodeUrl,
	wallet,
	l1,
	deployerSecret,
	usdc: "mock",
	permit2: await installCanonicalPermit2(l1), // anvil_setCode: the vendored Sepolia runtime, at the canonical address
})
await registerSponsor(beatWallet, manifest) // a second wallet, so the beats never share an account with your txs
const stop = await startBlockHeartbeat(beatWallet, manifest) // without it a deposit never becomes claimable
// deposit, claim, pay
await stop()
```

Who may do what, every refusal and the message formats:
[docs/integration.md](https://github.com/Galactica-corp/inference-money/blob/main/docs/integration.md).
