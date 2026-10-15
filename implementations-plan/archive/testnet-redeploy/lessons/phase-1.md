# Phase 1: KEYED 0, the rc.3 admin address (2026-10-14)

| Attempt | Result | Consequence |
|---|---|---|
| Host check before filing | No keyed run running; six other requests pending. | — |
| KEYED 0 `admin-address-61aa93ed`: `bun run bridge admin address` under `deployments/testnet-admin.env.example`, keyed tree at 8606c81 | Exit 0. Printed `0x17ff77f710f7f3a1795919a89a6eae38a6e18ac9da211a3c68e09804efd99490` (rc.1 derivation: `0x094fe37a…6915`). Scan `found=false files=3991 skipped=0 walletDirs=0`. | `TESTNET_ADMIN_ADDRESS` set to it in `deployments/testnet-deploy.env.example`. |
