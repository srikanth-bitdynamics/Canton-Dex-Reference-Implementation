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
| Fair ordering and MEV resistance | The operator privately observes orders and chooses match timing and submission order | A production sequencing, auction, or independently attested matching design |
| A rich instrument lifecycle | Token Standard V2 standardizes the holding, not lifecycle; the DEX needs only a holding | The registry that administers the `InstrumentId` — [add an instrument](../guides/add-lp-or-instrument.md) |
| A privileged reference registry | `Registry.V2` is a convenience so the DEX runs standalone, not the mechanism value settles through | Any conforming TSv2 registry (Amulet, or another) |
| Self-custody onboarding | The included signing relay is a development diagnostic, not a production wallet or public onboarding service | The user's own compatible wallet or a deployment-specific delegation/co-submission flow |
| Trustless LP emergency redemption | Reserve slices are operator-authored and removal is co-controlled by the operator and LP registrar | A production pool-governance and emergency-exit design |
| Operational hardening | HA, secrets management, and a rate-limited gateway are an operator's deployment decisions | Whoever runs an instance — [operator runbook](../guides/operator-runbook.md) |
| Production off-ledger services | The on-ledger contracts are the specification; the backend and indexer are one implementation of the surface around them | The integrator's own service — [architecture](architecture.md#off-ledger-services-what-they-may-and-may-not-do) |

## Not a generic settlement engine

The Daml models a DEX — pools, orders, RFQ. It is not a configurable settlement
framework that a caller parameterises into arbitrary flows. The settlement
pattern — allocate, then settle a batch atomically through the registry's
`SettlementFactory_SettleBatch` — is meant to be read and reused, but the
templates encode the DEX's own rules: constant-product pricing, price-time order
priority, and deterministic RFQ eligibility ranking. Lifting that pattern into a general engine
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
[TradeWorkflowTests.daml](../../trading-tests/CantonDex/Tests/TradeWorkflowTests.daml)
proves that two trader allocations settle in one operator batch.
[OrderWorkflowTests.daml](../../trading-tests/CantonDex/Tests/OrderWorkflowTests.daml)
proves that `OrderMatchExecution_Execute` refuses a fill outside either order's
limit price.

## Fair ordering and private MEV

The operator sees submitted orders and RFQs, chooses when to run matching, and
chooses the order in which eligible settlements reach the ledger. The reference
matcher applies deterministic best-price-then-time ordering to the snapshot it
is given, but the ledger cannot prove that the snapshot contained every order or
that its timestamps reflect a fair public arrival sequence.

The on-ledger checks therefore prevent an invalid fill, not operator censorship,
front-running, delayed inclusion, or private reordering among otherwise valid
fills. This is an explicit trust boundary. Production designs can reduce it with
commit-reveal intake, fixed-window batch auctions, independently witnessed
sequencing, matcher attestations, threshold-controlled submission, or a public
append-only order-intake log. Each changes the market and liveness model and is
outside this settlement-pattern reference.

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

`CantonDex.Registry.V2` is a self-contained reference registry so the DEX can
run a complete local settlement flow without depending on an external one. It
is not the settlement mechanism, and it is not privileged. The dApp and
operator reach any conforming TSv2 registry through its factories, choice
context, and disclosure; the reference
does not assume its own registry is present, nor that every registry exposes the
same conveniences. [architecture.md](architecture.md#what-settles-value-the-token-standard-v2-spine)
and [registry-integration.md](../guides/registry-integration.md) set out exactly
what a registry must provide. A deployment may issue its demo assets through
this registry; integrating another conforming registry also requires its factory
discovery, choice context, disclosures, and metadata endpoint.

## The development relay is not a wallet

The repository includes `POST /v1/wallet/submit` only for local developer
diagnosis. It is disabled by default, requires `DEX_DEV_WALLET_RELAY=1`, is
registered by the dApp only in a development build, and restricts submissions
to `DEX_DEV_RELAY_PARTIES`. The production-oriented testnet server does not
enable it. It does not create parties, mint faucet assets, impose public-user
quotas, or implement a `/v1/testnet/*` surface.

That relay is not self-custody: the backend forwards commands with its ledger
credential and therefore needs permission to act for every requested party. A
real deployment must instead use a compatible wallet (PartyLayer or a
CIP-0103 provider), or deliberately design and secure its own delegation or
co-submission service. The repository neither provisions nor promises a public
hosted deployment. See [connecting a wallet](../guides/using-the-dapp.md#connecting-a-wallet)
and the [historical ecosystem feedback](../reference/ecosystem-feedback.md).

The separately named `DEX_HOSTED_RFQ_RELAY` option is narrower: it can enable
the existing RFQ create/cancel/accept routes in `testnet-server.ts`, with
mandatory caller-JWT binding. It still does not create or fund parties, publish
a hostname, or add a `/v1/testnet/*` API. Whoever enables it owns the custodial
authority, identity, abuse-prevention, and operations design.

## LP redemption has an explicit liveness dependency

LP holders own the LP-token claim, not the reserve allocations referenced by
`PoolSlice`. A routine removal exercises
`PoolLiquidityRules_SettleRemoveLiquidity`, which requires both the pool
operator and LP registrar. If either party becomes unavailable, this reference
has no unilateral holder choice that redeems LP tokens against reserve slices.
The reserves remain represented on-ledger, but the holder cannot complete the
redemption workflow alone.

The reserve allocation shape makes the consequence concrete:
`committed = true` and `settlementDeadline = None`, with the operator as both
authorizer and settlement executor. Under the V2 withdrawal rule, even the
authorizer cannot use `Allocation_Withdraw`; the operator can still cancel as
executor. An LP holder can do neither. The missing deadline is therefore not a
hidden holder lock timeout: it is the reference's deliberate long-lived
operator-custody model.

That is a deliberate single-operator reference boundary, not a claim of
trustless custody. A production design must choose its own liveness mechanism,
such as governed or threshold-controlled execution plus a separately audited
emergency redemption path. Merely adding a deadline is insufficient: it would
give the operator authorizer a future withdrawal path and require a safe slice
renewal protocol, but it would not give LP holders redemption authority. These
changes alter pool authority and failure semantics and are not hidden inside the
reference settlement flow.

## Operational hardening is out of scope

The reference includes an operator runbook covering deployment, recovery, and
observability ([operator-runbook.md](../guides/operator-runbook.md)), but it is not
a hardened production service. There is no HA, rate limiting, public gateway or
faucet, secrets-management integration, and the operator's
authority is a single party. These are an operator's deployment decisions,
deliberately left to whoever runs an instance rather than baked into the reference
— the runbook's own [out-of-scope
list](../guides/operator-runbook.md#out-of-scope-for-this-document) draws the same
line.

## Off-ledger services are illustrative

The operator backend and indexer are a working reference, not a prescription. The
indexer is a single-writer SQLite projection sized for a testnet; the backend is
one Node process. They show what an integrator needs to read and orchestrate, not the
only way to build it. The on-ledger contracts are the specification; the off-ledger
services are one implementation of the surface around them
([architecture.md](architecture.md#off-ledger-services-what-they-may-and-may-not-do)).

---

**Where to read next:** [Architecture](architecture.md) · [Workflows](workflows.md) · [Registry Integration](../guides/registry-integration.md) · [All docs](../README.md)
