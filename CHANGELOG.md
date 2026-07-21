# Changelog

All notable changes to this reference implementation are documented here.
This project loosely follows [Keep a Changelog](https://keepachangelog.com)
and versions the repository release independently of the on-ledger
`canton-dex-trading` Daml package identity (which stays at `0.1.0` to
preserve upgrade lineage).

## [0.6.0] — 2026-07-21

First tagged release. Aligns the reference DEX with **Token Standard V2
(CIP-0112)** as shipped in **Splice 0.6.11** and now live on Testnet.

### Token Standard V2
- Vendored the V2 token-standard sources from `canton-network/splice`
  `main` and build them into local DARs; pinned in
  `vendor/splice/VENDOR_PIN.md`.
- Migrated the Daml core, registries, and TypeScript wire shapes to the
  V2 allocation / settlement / holding constructors.
- Reference `Registry.V2` with mint/burn accounts, an allocation factory,
  credentialed `InstrumentConfig`, and off-ledger choice-context /
  disclosure threading via `registry-client`.

### One-command wallet flows
- Adopted the standard **`Splice.Util.Token.Wallet.BatchingUtilityV2`**
  for add/remove-liquidity DvP: the wallet issues one CIP-0103 top-level
  command (`BatchingUtility_ExecuteBatch`) that accepts the request and
  authors every allocation, threading holdings through the utility's
  holding map. `Registry.V2` allocate returns unneeded holdings via
  `authorizerChangeCids` for that threading.
- Order funding and matched-trade settlement are single-command as well;
  `MatchedTrade_Settle` batches multi-leg DvP grouped by admin.

### dApp
- Rebuilt the frontend on the Bitdynamics design system: self-hosted
  Archivo + JetBrains Mono, dark console theme, ink neutrals with one
  cobalt accent, hairline structure, wide-caps micro-labels, tabular
  mono for all data values, dot-grid empty states.
- Full CIP-0103 provider set (Token Standard relay, PartyLayer,
  WalletConnect, SDK, Canton-direct); honest wallet toasts, order-recovery
  via updateId, readable wallet errors.

### Docs
- Diátaxis docs tree plus an Astro Starlight site deployed to GitHub
  Pages, themed to match the dApp.
- Full data-validity audit of the docs: 906 claims checked, 38 factual
  inaccuracies corrected (routes, symbols, ports, enums, counts, links).

### Known limitations
- The BatchingUtilityV2 add/remove-liquidity DvP is proven by the Daml
  test suite and unit tests but has **not yet been verified live against
  a Testnet participant** (tracked as a follow-up).
- The repo builds against **Daml SDK 3.4.11** (the legacy assistant);
  upstream `main` targets 3.5.2/DPM. The full 3.5.2 migration is deferred.

[0.6.0]: https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation/releases/tag/v0.6.0
