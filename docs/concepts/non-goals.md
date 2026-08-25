# What this reference does not include

This is a reference implementation, not a product. Several things a production
DEX would carry are left out on purpose — either because they are an operator's
deployment choice rather than a settlement-pattern concern, or because including
them would obscure the one thing the reference exists to show: that spot trading
on Canton can be built entirely on Token Standard V2 (CIP-0112) allocations, with
the ledger enforcing custody and conservation.

Each item below is a deliberate choice, not an unfinished edge. Where a boundary
is visible in the code, the section names the template or choice that draws it,
and points at the guide or contract where the excluded work would live.

## What is out of scope, and where it belongs

| Excluded | Why it is out of scope | Where it belongs |
|---|---|---|
| A generic settlement engine | The templates encode one DEX's rules — constant-product pricing, price-time order priority, RFQ ranking — not a parameterisable framework | A fork that reuses the allocate-then-`SettleBatch` pattern for its own flows |
| Cross-registry pairs (two admins) | App-layer templates key each pair on a single `admin : Party`; the settlement spine already allows more | A scoped schema change — [registry integration](../guides/registry-integration.md#known-limitation-one-registry-admin-per-pair) |
| A production matching engine | The batch matcher shows only the Canton-specific part: a fill re-checked and settled atomically on-ledger | A fork's off-ledger matcher (pro-rata, iceberg, continuous auction) |
| A rich instrument lifecycle | Token Standard V2 standardizes the holding, not lifecycle; the DEX needs only a holding | The registry that administers the `InstrumentId` — [add an instrument](../guides/add-lp-or-instrument.md) |
| A privileged reference registry | `Registry.V2` is a convenience so the DEX runs standalone, not the mechanism value settles through | Any conforming TSv2 registry (Amulet, or another) |
| Self-custody onboarding | The hosted relay is a testnet convenience, not a production wallet integration | The user's own compatible wallet or a deployment-specific delegation/co-submission flow |
| Trustless LP emergency redemption | Reserve slices are operator-authored and removal is co-controlled by the operator and LP registrar | A production pool-governance and emergency-exit design |
| Operational hardening | HA, secrets management, and a rate-limited gateway are an operator's deployment decisions | Whoever runs an instance — [operator runbook](../guides/operator-runbook.md) |
| Production off-ledger services | The on-ledger contracts are the specification; the backend and indexer are one implementation of the surface around them | The integrator's own service — [architecture](architecture.md#off-ledger-services-what-they-may-and-may-not-do) |

## Not a generic settlement engine

The Daml models a DEX — pools, orders, RFQ. It is not a configurable settlement
framework that a caller parameterises into arbitrary flows. The settlement
pattern — allocate, then settle a batch atomically through the registry's
`SettlementFactory_SettleBatch` — is meant to be read and reused, but the
templates encode the DEX's own rules: constant-product pricing, price-time order
priority, best-execution RFQ ranking. Lifting that pattern into a general engine
is a fork's job, not a configuration flag. See [architecture.md](architecture.md).

## One registry admin per pair

A trading pair carries a single `admin : Party` covering both its base and quote
instruments (`trading/CantonDex/Dex/Order.daml`, `Pool.daml`):

```daml
template Order with
    ...
    admin : Party
      -- ^ Registry admin for the base + quote instruments.
    baseInstrumentId : Text
      -- ^ `id` component of the base instrument, under `admin`.
    quoteInstrumentId : Text
      -- ^ `id` component of the quote instrument, under `admin`.
```

Under Token Standard V2 an instrument is identified by `(admin, id)`, so this
reference cannot list a pair whose two assets come from different registries —
Canton Coin quoted against a third-party stablecoin, for instance. The limitation
is app-layer, not settlement-layer: a single Daml transaction can settle one batch
per admin, and the LP path already does exactly that, calling
`SettlementFactory_SettleBatch` once for the base/quote admin and once for the LP
registrar. Lifting it is a scoped schema change — a second-admin field on the four
pair-keyed templates and one allocation specification per `(authorizer, admin)`,
written up in
[registry-integration.md](../guides/registry-integration.md#known-limitation-one-registry-admin-per-pair).

## Not a production matching engine

Order matching is a batch process the operator runs (`runMatching` in
`services/operator-backend/src/order/index.ts`), not a continuous in-ledger
matching loop. It clears crossing orders best-price-then-time, settles each match
atomically through the on-ledger `OrderMatchExecution_Execute` choice, and applies
simple self-trade prevention — a party's own bid and ask are never paired
(`services/operator-backend/src/order/matching.ts`). It does not implement
pro-rata allocation, iceberg or hidden orders, matching priority tiers, or a
continuous auction; a production venue would layer those on off-ledger.

What the reference does show is the part specific to Canton: a match settles
atomically against both traders' funding allocations, and
`OrderMatchExecution_Execute` re-checks the fill against both orders' own limit
prices, quantities, instruments, and bound allocations — so a buggy or malicious
off-ledger matcher cannot settle a fill the traders never agreed to. Proven by
[EndToEndTests.daml](../../trading-tests/CantonDex/Tests/EndToEndTests.daml):
`testMatchedTradeFullSettle` (two trader allocations settle in one operator batch)
and `testOrderMatchEnforcesLimitPrice` (`OrderMatchExecution_Execute` refuses a
fill outside either order's limit price).

## A minimal instrument model

The standard holding model is kept intentionally small. The reference issues
exactly one lifecycle-bearing instrument — the LP token — as a token-standard
instrument with its own registrar and DvP mint/burn
(`trading/CantonDex/Lp/Instrument.daml`). Token Standard V2 standardizes the
holding, not lifecycle: it does not mandate an instrument-configuration or rich
lifecycle, and the reference does not assume one exists for every registry.
Anything richer — a bond's maturity and coupon, a vested or dividend-paying token
— is attached by the registry that administers the `InstrumentId`, not by DEX
templates. A guide for issuing a lifecycle-richer instrument is included
([add-lp-or-instrument.md](../guides/add-lp-or-instrument.md)); the DEX itself
stays at the minimum it needs.

## The reference registry is one option, not the mechanism

`CantonDex.Registry.V2` is a self-contained reference registry so the DEX can run
end to end without depending on an external one. It is not the settlement
mechanism, and it is not privileged. The dApp and operator reach any conforming
TSv2 registry through its factories, choice context, and disclosure; the reference
does not assume its own registry is present, nor that every registry exposes the
same conveniences. [architecture.md](architecture.md#what-settles-value-the-token-standard-v2-spine)
and [registry-integration.md](../guides/registry-integration.md) set out exactly
what a registry must provide. On the public testnet the pair's assets happen to be
issued by this registry. Integrating another conforming registry also requires
its factory discovery, choice context, disclosures, and metadata endpoint.

## The hosted testnet is a demo surface, not a wallet

The public deployment lets a visitor with no wallet trade, by minting a hosted
demo party and relaying its signatures through a fixed, allowlisted set of choices
under per-IP and daily caps. This is explicitly a testnet convenience, not
self-custody: the walletless connect options are marked **DEV** and are never
preselected in a testnet or production build
([using-the-dapp.md](../guides/using-the-dapp.md#connecting-a-wallet)). A real user
brings their own wallet (PartyLayer or the dapp-sdk) and signs for themselves; the
hosted relay exists only so the reference flows can be exercised from a browser
without one. The `/v1/testnet/*` relay surface and the faucet's per-IP party
quota are documented in
[ecosystem-feedback.md](../reference/ecosystem-feedback.md).

**Current deployment status.** On the public testnet at
`testnet-dex.bitdynamics.cc`, every tester is onboarded as a hosted party on the
operator's (BitDynamics) validator, and every traded asset (`dBTC`, `dUSD`, and the
pool's LP token) is issued locally by the deployment's own Token Standard V2
registry. This deployment choice does not change the application boundary:
self-custodial users connect through a compatible wallet and registry, while a
hosted party authorizes only the allowlisted demo operations exposed by the
relay. Registry choice context and disclosures still determine whether a given
external instrument can participate in a settlement.

## LP redemption has an explicit liveness dependency

LP holders own the LP-token claim, not the reserve allocations referenced by
`PoolSlice`. A routine removal exercises
`PoolLiquidityRules_SettleRemoveLiquidity`, which requires both the pool
operator and LP registrar. If either party becomes unavailable, this reference
has no unilateral holder choice that redeems LP tokens against reserve slices.
The reserves remain represented on-ledger, but the holder cannot complete the
redemption workflow alone.

That is a deliberate single-operator reference boundary, not a claim of
trustless custody. A production design must choose its own liveness mechanism,
such as governed or threshold-controlled execution plus a separately audited
emergency redemption path. Adding such a path changes pool authority and
failure semantics and is therefore not hidden inside the reference settlement
flow.

## Operational hardening is out of scope

The reference includes an operator runbook covering deployment, recovery, and
observability ([operator-runbook.md](../guides/operator-runbook.md)), but it is not
a hardened production service. There is no HA, no rate-limited public gateway
beyond the testnet caps, no secrets-management integration, and the operator's
authority is a single party. These are an operator's deployment decisions,
deliberately left to whoever runs an instance rather than baked into the reference
— the runbook's own [out-of-scope
list](../guides/operator-runbook.md#out-of-scope-for-this-document) draws the same
line.

## Off-ledger services are illustrative

The operator backend and indexer are a working reference, not a prescription. The
indexer is a single-writer SQLite projection sized for a testnet; the backend is
one Node process. They show what an integrator needs to read and relay, not the
only way to build it. The on-ledger contracts are the specification; the off-ledger
services are one implementation of the surface around them
([architecture.md](architecture.md#off-ledger-services-what-they-may-and-may-not-do)).

---

**Where to read next:** [Architecture](architecture.md) · [Workflows](workflows.md) · [Registry Integration](../guides/registry-integration.md) · [All docs](../README.md)
