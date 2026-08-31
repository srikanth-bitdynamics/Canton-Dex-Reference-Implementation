# Changelog

Notable changes to this reference implementation are recorded here. The
repository release and the `canton-dex-trading-v2` Daml package have independent
versions. Package upgrades are checked against the deployed baseline in
`trading/upgrade-baseline/`.

## Unreleased

### Added

- `SettledTrade` records each completed order-book fill for indexing.
- Add-liquidity requests report matched and refunded amounts and support an
  optional maximum off-ratio tolerance.
- Portfolio holdings are consolidated by full instrument identity, and the RFQ
  page distinguishes quote acceptance from token settlement.

### Changed

- The trading package is renamed `canton-dex-trading` -> `canton-dex-trading-v2`
  and reset to 1.0.0, starting a fresh smart-contract-upgrade lineage: dropping
  the per-venue `admin`, `Rfq.pair`, and `SettlementBatchV2.transferLegs` fields
  is not a valid in-place upgrade.
- `canton-dex-trading-v2` 1.0.0 scopes each settlement batch to the transfer legs
  governed by that batch's registry admin.
- The reference registry validates exact allocation-to-leg coverage, positive
  leg amounts, unique leg ids, matching registry admins, and per-instrument
  conservation.
- Order matching validates funding bindings and performs settlement, partial
  remainder roll-forward, and trade recording atomically.
- Off-ratio liquidity deposits refund their unmatched amount in the same DvP
  transaction.
- Pool quote, swap, and redemption arithmetic use the same round-down helpers.
- Allocation creation locks only the requested amount and returns change as
  ordinary holdings.

## [0.6.0] - 2026-07-21

First tagged release of the Token Standard V2 (CIP-0112) reference DEX.

- Added RFQ/OTC, prefunded order, constant-product pool, liquidity, swap, and
  LP-token workflows.
- Added the reference V2 registry, per-admin choice-context threading, and
  one-command wallet composition through `BatchingUtilityV2`.
- Added the operator backend, React dApp, wallet-provider boundary, Daml and
  TypeScript test suites, documentation site, and operator runbooks.
- Pinned the released Token Standard V2 dependencies in
  `vendor/splice/VENDOR_PIN.md`.

[0.6.0]: https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation/releases/tag/v0.6.0
