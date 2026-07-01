# Builder Guide

For engineers who want to pick this reference up, read it, and extend it. Read
after [Getting Started](../getting-started.md) (which gets the stack running)
and the [Overview](../concepts/overview.md) + [Architecture](../concepts/architecture.md)
(which explain the design).

## In scope

A runnable Canton DEX that:

- uses Token Standard V2 (CIP-0112) for every asset: base, quote, and LP are
  represented by contracts implementing `V2.Holding`.
- uses iterated allocations from Token Standard V2 (CIP-0112), now merged into
  `canton-network/splice` `main`, so pool reserves and resting orders can be
  adjusted in place without re-funding round trips.
- ships an on-chain operator policy receipt (`PolicyReceipt`) for RFQ accepts,
  so dealer ranking is replayable after the fact.
- has a public testnet deployment with a working dApp pointed at it.

## Out of scope

Short version: no central limit-order-book matcher, no production order routing,
no oracle integration, no custody, and no compliance/KYC layer. Those belong in
forks or deployment-specific services.

## A guided tour of the workflow families

The four workflow families below are the ones the Daml test suite exercises.
Each corresponds to tests under `trading-tests/CantonDex/Tests/`. Read them in
this order to understand the venue end-to-end.

### A. Pair / instrument listing
- `trading/CantonDex/Dex/DexPair.daml` — listing record: base + quote instrument
  id, fee model, trading mode (`OrderBook`, `Pool`, `Both`), and an `active` flag.
- `trading/CantonDex/Instrument/InstrumentConfiguration.daml` — the reference
  registry's instrument config (holder/issuer credential requirements, optional
  ISIN/CUSIP). This is **not** a Token Standard V2 template; other registries can
  use different config contracts.
- Test: `InstrumentTests.daml::testInstrumentConfigCreate`.

### B. Matched-trade OTC / RFQ settlement (TradingAppV2 pattern)
- `trading/CantonDex/Dex/MatchedTrade.daml` — a V2 adaptation of TradingAppV2.
  `MatchedTrade_RequestAllocations` creates one request per authorizer;
  `MatchedTrade_Settle` groups by admin and calls `SettlementFactory_SettleBatch`;
  `MatchedTrade_Cancel` mirrors the cleanup.
- `trading/CantonDex/Dex/Rfq.daml` + `PolicyReceipt.daml` — the bilateral
  block-trade flow: trader RFQ, dealer quotes, joint `Rfq_Accept` emitting a
  `MatchedTrade` that carries an operator-signed `PolicyReceipt` folded into
  `SettlementInfo.meta`.
- Tests: `EndToEndTests.daml::testMatchedTradeFullSettle`,
  `testRfqAcceptProducesMatchedTradeWithReceipt`.

### C. Resting orders backed by a V2 allocation
- `trading/CantonDex/Dex/OrderFundingRequest.daml` — trader-signed intent.
- `trading/CantonDex/Dex/Order.daml` — the operator-bound `Order` plus its
  `OrderAllocationRequest`. Funding requires the trader to author the allocation
  via `AllocationFactory_Allocate`, so the trader's own authority moves the
  holding — the operator cannot move trader holdings on its own.
- `trading/CantonDex/Dex/OrderMatchExecution.daml` — the prefunded-trade pattern:
  concrete match legs are supplied as `FinalizedAllocation.extraTransferLegSides`
  at batch-settlement time; next-iteration cids roll forward onto partial fills.
- Tests: `EndToEndTests.daml::testOrderFundingFlow`,
  `testFinalizedAllocationFundingConservation`.

### D. Constant-product pool with committed allocations
- `trading/CantonDex/Dex/Pool.daml` + `PoolState.daml` + `PoolSlice.daml` — the
  split pool: immutable config, the hot reserves/supply/status **state**, and one
  committed allocation per **slice** (each slice is its own contract, passed by
  cid).
- `trading/CantonDex/Dex/PoolRules.daml` — the swap-side choices:
  `PoolRules_RequestSwap`, `PoolRules_Swap`, `PoolRules_Pause`, `PoolRules_Resume`.
- `trading/CantonDex/Dex/PoolLiquidityRules.daml` + `LiquidityAllocationRequest.daml`
  — the delivery-versus-payment add/remove path: `_RequestAddLiquidity` /
  `_SettleAddLiquidity` and `_RequestRemoveLiquidity` / `_SettleRemoveLiquidity`,
  co-controlled by `operator` + `lpRegistrar`.
- `trading/CantonDex/Lp/Policy.daml` + `Instrument.daml` — the LP-token component.
  `LPTokenPolicy` is owned by `lpRegistrar`, keyed by a `V2.InstrumentId`, and
  knows nothing about pools or orders.
- Tests: `EndToEndTests.daml::testPoolFullLifecycle`, `testPoolSwapEndToEnd`;
  `PoolLiquidityRulesTests.daml` (DvP add, remove-to-holder, boundary slice).

## Contract surface

```
DexPair                     pair listing, fee model, optional public observers
Pool                        constant-product pool config, slice-local reserves
PoolState / PoolSlice       hot reserves+supply+status; one committed allocation per slice
PoolRules                   swap + pause/resume choices over pool state
PoolLiquidityRules          DvP add/remove-liquidity settle choices
LPTokenPolicy               LP instrument supply ledger, record-mint/burn policy
LiquidityAllocationRequest  operator-issued; carries the add/remove DvP allocation request
Order                       resting limit order backed by a V2 allocation
OrderAllocationRequest      trader-observed allocation request (V2 interface)
OrderMatchExecution         operator-driven match of two opposing allocations
MatchedTrade                bilateral block-trade carrier, optional PolicyReceipt
TradeAllocationRequest      per-authorizer allocation request for a matched trade
Rfq / RfqQuote              trader's request for quotes; dealer's quote
PolicyReceipt               on-chain record of operator ranking policy at accept time
Registry.V2.*               reference registry implementing Token Standard V2 interfaces
```

The Daml package is `canton-dex-trading` (current version `v0.1.0`).

## Off-chain layout

```
services/operator-backend/
  src/
    ledger/         JSON LAPI driver, LedgerSubmitter abstraction
    indexer/        SQLite indexer, idempotency cache, operator config kv
    http/           REST endpoints
    admin/          pair / pool / pricing administrative writes
    pool/, rfq/, order/, matched-trade/   per-flow modules
app/web/
  src/
    services/       HTTP client and wallet handoff boundary
    pages/          route-level React pages
    components/     Pool, Trade, Portfolio, Admin, Rfq views
    wallet/         wallet providers (CIP-0103 SDK, WalletConnect, mock, ...)
```

## Off-chain matcher

The on-chain `OrderMatchExecution` template adjusts and settles two opposing
allocations atomically. Orchestration (finding opposing orders, computing fill
quantity, picking fill price) lives in operator code:

1. Operator scans active `Order` contracts via `/v1/orders`.
2. Pairs compatible orders: same `(baseInstrumentId, quoteInstrumentId)`,
   opposite `side`, `bid.limitPrice >= ask.limitPrice`.
3. Fill quantity = `min(bid.remainingQty, ask.remainingQty)`.
4. Fill price by operator policy (typically maker-priority or midpoint).
5. Creates `OrderMatchExecution` referencing both allocations and the fill numbers.
6. Exercises `OrderMatchExecution_Execute`, which finalizes each allocation with
   the concrete match leg-sides, calls `SettlementFactory_SettleBatch` on the
   finalized batch, and returns a `nextIterationAllocationCid` per side if any
   leftover remains.
7. For the side with remainder, exercise `Order_RecordPartialFill` against the new
   next-iteration allocation; a fully-filled side's allocation is archived by
   settlement.

The split is intentional: matchers change often, settlement primitives do not. A
fork can rewrite the matcher without touching any Daml template.

## Wallet integration

The dApp does not sign as the trader. Trader-authority writes (place order,
add/remove-liquidity allocations via `AllocationFactory_Allocate`, swap allocation
creation, RFQ accept) go through the connected wallet over the **CIP-0103** dApp
standard (prepare → sign → execute). The operator backend produces unsigned
command trees; the wallet signs and submits.

Read endpoints (`/v1/pools`, `/v1/trades`, etc.) are operator-observed and served
from the backend's indexer cache. Keep trader-authority writes in the wallet path;
the operator backend should only orchestrate and settle flows it is authorized to
submit.

## Extending the reference

| Goal | How |
|---|---|
| Add a new trading pair (BTC/EUR, ETH/USDT, …) | Create a `DexPair`; add a `Pool` if the pair runs pool-mode. See [Add a Trading Pair](add-a-trading-pair.md). |
| Issue a new LP token or lifecycle-rich instrument (vested, dividend-bearing) | See [Add an LP or Instrument](add-lp-or-instrument.md). |
| Use a different registry | Replace `CantonDex.Testing.MockRegistry` with the real registry's `AllocationFactory` + `SettlementFactory`. See [Registry Integration](registry-integration.md). |
| Add a different pricing curve (StableSwap, weighted) | Fork the `Pool` template; the slice model is curve-agnostic. See `examples/stable-pool/`. |
| Add a different RFQ policy (oracle-weighted, multi-tier) | `Rfq.applyPolicy` holds the sort chain; bump `policyVersion`/`policyHash` and mirror in `app/web/src/services/rfq-policy.ts`. |
| Talk to a different participant | Set `CANTON_LEDGER_URL`, `CANTON_LEDGER_TOKEN`, `CANTON_SYNCHRONIZER`. See [Run on a Testnet](run-on-testnet.md). |

**The boundary that must not move:**

- DEX contracts own market structure (orders, trades, pools, LP issuance).
- Token Standard contracts own reservation and settlement.
- Registry contracts own asset semantics. The reference registry exposes
  `InstrumentConfiguration`, but the DEX boundary is the V2 holding / allocation /
  settlement surface plus registry-supplied choice context.

Any change that blurs these will surface as duplicated state or authority
confusion in the workflows.

## Upgrade discipline

Keep the reference templates as small as possible; do not carry compatibility
choices "just in case" — they add noise for readers. If an adopter deploys a
package and needs to preserve Daml smart-upgrade lineage, follow the participant's
upload-check rules: new fields `Optional` and at the end of the record, choices
kept (not removed), input/result field types stable, no field reordering. If you
intentionally break compatibility, rename the package and treat it as a fresh
lineage.

## Testing

```bash
cd trading-tests && daml test            # in-script Daml suites
```

Expected counts are listed in [Getting Started](../getting-started.md). Testnet
smoke:

```bash
node --import tsx scripts/testnet-v2registry-trade.ts   # real V2-standard trade
```

Keep deployment-specific responsibilities outside the reference core: custody,
KYC/compliance, oracle selection, production routing policy, and market
surveillance should be implemented by the adopter, not hardcoded into the shared
templates.

## Where to read next

- **Reference:** [HTTP API](../reference/http-api.md) · [Allocation Surface](../reference/allocation-surface.md)
- **Deeper design:** [Workflows](../concepts/workflows.md) · [Liquidity & Custody](../concepts/liquidity-and-custody.md)
- **Recipes:** [Add a Trading Pair](add-a-trading-pair.md) · [Add an LP or Instrument](add-lp-or-instrument.md)
