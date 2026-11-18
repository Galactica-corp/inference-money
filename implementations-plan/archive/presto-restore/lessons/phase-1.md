# Phase 1: pin Presto 6.0.0-rc.3 (2026-10-14)

- Published 16:54:13Z (npm `time`); the poller saw it at 16:56Z. No install-time scripts.
- Dependency check: `@aztec-labs/{stdlib,bb-prover,foundation}` 6.0.0-rc.3, `@aztec-foundation/{bb.js,noir-acvm_js,noir-noirc_abi}` 6.0.0-rc.6, `@alejoamiras/presto-core` 1.2.1, `@logtape/logtape` ^2.3.2 (unchanged range): as planned.
- **The age gate blocks re-resolution of young packages already in the lock.** With only `@alejoamiras/presto` excluded, `bun install` refused 15 names whose locked rc.3/rc.6 versions are under 7 days old (`@aztec-labs/{accounts,aztec.js,bb-prover,constants,ethereum,foundation,noir-contracts.js,pxe,simulator,standard-contracts,wallets}`, `@aztec-foundation/{bb.js,l1-artifacts,noir-acvm_js,noir-noirc_abi}`). A changed lock re-resolves their edges. Adding those exact names to the temporary exclude resolved it; `bunfig.toml` was restored right after (`git diff --exit-code` 0).
- Young set: the only added spec is `@alejoamiras/presto@6.0.0-rc.3`; 31 specs left (the SDK's own rc.1 subtree); no package name appeared or disappeared. No `bb.js@6.0.0-rc.1` or `stdlib@6.0.0-rc.1` remains.
- Scratch-dir `npm audit signatures --json --include-attestations` (npm 11.19.0) over Presto's tree: 90 verified, 0 invalid, 0 missing.
- Provenance: SLSA v1 from `github.com/alejoamiras/presto`, `.github/workflows/release-sdk.yml`, `refs/heads/main` at `b842a532`, run `38599643298`. `b842a53` is presto #105's merge `d24465a` plus #108, which changes only Rust `Cargo.lock` files and plan docs.
- Integrity `sha512-P++0W/nt…YLA==` is equal in the registry, npm's lock, the attestation subject and `bun.lock`.
- Clean frozen install (every workspace `node_modules` deleted): exit 0, 738 packages (762 before).
- Gate: typecheck, every unit suite, showcase components 99 passed / 5 skipped.
