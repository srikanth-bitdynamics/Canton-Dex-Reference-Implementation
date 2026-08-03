# What this reference does not include

This is a reference implementation, not a product. Several things a production
DEX would carry are left out on purpose, either because they are an operator's
choice rather than a settlement-pattern concern, or because including them would
obscure the one thing the reference exists to show: that spot trading on Canton
can be built entirely on Token Standard V2 allocations, with the ledger enforcing
custody and conservation.

Each item below is a deliberate choice. Where a boundary is visible
in the code, the module is named.

## Not a generic settlement engine

The Daml models a DEX: pools, orders, RFQ. It is not a configurable settlement
framework that a caller parameterises into arbitrary flows. The settlement
pattern (allocate, then settle a batch atomically through the registry's
`SettlementFactory`) is meant to be read and reused, but the templates encode
the DEX's own rules (constant-product pricing, price-time order priority,
best-execution RFQ ranking) rather than exposing a general engine.
See [architecture.md](architecture.md).

## One registry admin per pair

A trading pair carries a single `admin : Party` covering both its base and quote
instruments (`trading/CantonDex/Dex/Order.daml`, `Pool.daml`). Under Token
Standard V2 an instrument is identified by `(admin, id)`, so this reference cannot
list a pair whose two assets come from different registries — for example Canton
Coin quoted against a third-party stablecoin. The settlement layer itself does
not require this (a single Daml transaction can settle one batch per admin, and
this repository already does so on the LP path); the limitation is in the app-layer
templates. Lifting it is a scoped design change, written up separately.

## Not a production matching engine

Order matching is a batch process the operator runs (`runMatching` in
`services/operator-backend/src/order/index.ts`), not a continuous in-ledger
matching loop. It clears crossing orders best-price-then-time, settles each match
atomically, and applies simple self-trade prevention (a party's own orders are
not paired). It does not implement pro-rata allocation, iceberg or hidden orders,
matching priority tiers, or a continuous auction. A production venue would layer
those on; the reference shows that the settlement of a match is atomic and
allocation-backed, the part specific to Canton.

## A minimal instrument model

The vendored standard holding model is kept intentionally small. The reference
issues exactly one lifecycle-bearing instrument, the LP token, as a
token-standard instrument with its own registrar and DvP mint/burn
(`trading/CantonDex/Lp/`). Token Standard V2 does not mandate
`InstrumentConfiguration` or a rich lifecycle, and the reference does not assume
one exists for every registry. A guide for issuing a lifecycle-richer instrument
is included ([../guides/add-lp-or-instrument.md](../guides/add-lp-or-instrument.md)),
but the reference itself stays at the minimum the DEX needs.

## The reference registry is one option, not the mechanism

`CantonDex.Registry.V2` is a self-contained reference registry so the DEX can be
run end to end without depending on an external one. It is not the settlement
mechanism. The dApp and operator reach any conforming TSv2 registry through its
factories, choice context and disclosure. The reference does not assume its own
registry is present, and does not require every registry to expose the same
conveniences (`architecture.md`, "Dependency Boundary"). On the public testnet
the pair's assets happen to be issued by this registry; the flows are written to
work against Amulet or any other conforming registry.

## The hosted testnet is a demo surface, not a wallet

The public deployment lets a visitor with no wallet trade, by minting a hosted
demo party and relaying its signatures through a fixed, allowlisted set of
choices under per-IP and daily caps. This is explicitly a testnet convenience,
not self-custody: the two connect options are marked **DEV**. A real user brings
their own wallet (PartyLayer or the dapp-sdk) and signs for themselves; the hosted
relay exists so the milestone flows can be exercised from a browser without one.
The hosted onboarding routes and their caps are documented in
[../guides/operator-runbook.md](../guides/operator-runbook.md).

**Current deployment status.** On the public testnet at
`testnet-dex.bitdynamics.cc`, every tester is onboarded as a hosted party on the
operator's (BitDynamics) validator, and every traded asset (`dBTC`, `dUSD`, and
the pool's LP token) is issued locally by the deployment's own Token Standard V2
registry. This is a bridge: external participants cannot yet bring their own
Token Standard V2 party and assets because the general-purpose validator and
wallet tooling (DA Utilities) does not yet support Token Standard V2. When that
support ships, users connect their own participant's party and trade their own V2
assets through PartyLayer or the dapp-sdk, and the hosted onboarding is retired.
The code path for that is already the intended one. The hosted relay is the only
piece specific to this interim.

## Operational hardening is out of scope

The reference includes an operator runbook covering deployment, recovery and
observability, but it is not a hardened production service. There is no HA, no
rate-limited public gateway beyond the testnet caps, no secrets-management
integration, and the operator's authority is a single party. These are an
operator's deployment decisions, deliberately left to whoever runs an instance
rather than baked into the reference.

## Off-chain services are illustrative

The operator backend and indexer are a working reference, not a prescription. The
indexer is a single-writer SQLite projection sized for a testnet; the backend is
one Node process. They show what an integrator needs to read and relay, not the
only way to build it. The on-ledger contracts are the specification; the
off-chain services are one implementation of the surface around them
(`architecture.md`, "Off-Chain Services").
