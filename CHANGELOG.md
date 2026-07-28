# Changelog

All notable changes to this reference implementation are documented here.
This project loosely follows [Keep a Changelog](https://keepachangelog.com)
and versions the repository release independently of the on-ledger
`canton-dex-trading` Daml package identity, which moves only when a choice
body changes. Smart upgrading keeps the lineage: contracts created under an
earlier version execute the newer choice, and contract ids are preserved.

## Unreleased

### Added

- `POST /v1/pools/add-liquidity/request` reports what a deposit actually
  buys: `matchedBaseAmount` / `matchedQuoteAmount` (the part of each leg the
  minted LP tokens represent) and `donatedBaseAmount` / `donatedQuoteAmount` /
  `donationBps` (the off-ratio excess, which the settle refunds instead of
  taking into the reserves). An optional `maxDonationBps` refuses a request
  above a caller-chosen ceiling before any contract is created; omitting it
  keeps the previous unbounded behaviour.

### Fixed

- `canton-dex-trading` 0.1.2 → 0.1.3. An off-ratio add-liquidity deposit no
  longer donates its excess to the pool. LP tokens are minted against the
  limiting side, but both legs used to enter the reserves in full, so the
  unmatched remainder accrued to the existing holders and was unrecoverable —
  and refusing the deposit off-ledger left every other caller of the choice
  exposed. `PoolLiquidityRules_SettleAddLiquidity` now takes only the
  ratio-matched amount into the slices and refunds the rest to the provider in
  the same batch, and reports what it took as `baseAdded` / `quoteAdded`. The
  deposit allocations the request asks the provider to author are
  iterated-enabled, which is what lets the settle add the refund side.

- `canton-dex-trading` 0.1.1 → 0.1.2. Pool payouts now really round down.
  `floorDecimal10` was the identity function — `Decimal` is `Numeric 10`, so
  its round trip through `1e10` returned its argument unchanged — which left
  the constant-product output and the pro-rata redemption on the half-even
  rounding of `*` and `/`. A swap could therefore pay out more than the exact
  quotient and lower `x*y`. `PM.floorMul` / `PM.floorDiv` replace it and floor
  at each step; the operator's advisory quote floors identically.
- `OrderMatchExecution_Execute` now asserts that the supplied allocation cids
  are the ones the fetched orders are bound to, and that both orders are
  funded. Without the binding check a fill could consume the collateral of a
  different resting order of the same trader — batch conservation still holds,
  so nothing downstream rejected it — leaving that order pointing at an
  archived allocation; without the status check a never-funded `OS_Pending`
  order could be recorded as filled.

### Changed

- `canton-dex-trading` 0.1.0 → 0.1.1. `AllocationFactory_Allocate` now locks
  the allocation notional and returns the remainder through
  `authorizerChangeCids` instead of locking each input holding whole. A party
  funding a small allocation from one large holding keeps the difference
  spendable. Participants must vet 0.1.1 before their users can co-sign
  holdings created under it.

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
