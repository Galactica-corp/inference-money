# Phase 0: preparation (2026-10-14)

| Attempt | Result | Consequence |
|---|---|---|
| Brief step 1: keep the committed `TESTNET_ADMIN_ADDRESS` (`0x094fe37a…6915`, the old manifest's `l2.admin`) | Stale: #91 moved the pinned Schnorr address of a fixed secret (`cast.test.ts`, `0x0c5460e0…` → `0x19587f1d…`), and `admin address` derives through the same function. A deploy would propose both roles to an address no key controls on rc.3. | Director: KEYED 0 = keyed `admin address` first, its output committed into the deploy template. |
| `bun run probe:testnet` (keyless) | 19/19: node 6.0.0-rc.3, rollup 3409706519, inbox `0xb3b9…b209`, outbox `0x2551…a400`, SponsoredFPC published, 978.68 FJ. | — |
| L1 deploy key `0xFcc2238319aC360e985f1736aBB3df6251DAF6F5` (public RPC) | 4.257112 ETH, 40.657366 USDC: short of `demo fund`'s 50.02 USDC for a fresh cast. | Director: move the retired rc.1 cast's USDC to it. |
| Demo float: the rc.1 cast's USDC (public demo keys of bridge `0x1bcb…3f81`) → the deploy key | A_demo `0x6A66…D346` 12.71 USDC, tx `0xc826953cba8ed5064b489713ee9f429607897ddb05f8fc542bf86fdfb7dba2a2` (block 11915356, success); B_demo `0x94EB…548c` 9.20 USDC, tx `0xea5470d4491fb547afcce037fd8d7eea8f7c8ed8baad2c9b399a888a6ee2c4c7` (block 11915357, success). | Deploy key: 62.567366 USDC, 4.257112 ETH. |
| Keyless `secrets:scan` baseline | `found=false files=8915 skipped=3 walletDirs=0`, exit 1: the closed audit's Slither venv (`~/.cache/inference-money/audit-tools/slither/bin/python*` → `/usr/bin/python3.12`). | Director: `mv ~/.cache/inference-money/audit-tools ~/.cache/inference-money-audit-tools` (`mv` back restores it). Rescan: `found=false files=4008 skipped=0 walletDirs=0`. |
