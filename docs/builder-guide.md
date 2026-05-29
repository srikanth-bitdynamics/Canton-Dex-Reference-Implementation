# Builder Guide

For engineers who want to pick this reference up and extend it. Read
after `docs/quickstart.md` and `docs/architecture.md`.

## In scope

A runnable Canton DEX that:

- uses Token Standard V2 (CIP-0056) for every asset: base, quote, and
  LP all implement `V2.Holding`.
- uses iterated allocations from Splice's `token-standard-v2-upcoming`
  branch (originally splice#5333, since merged), so pool reserves and
  resting orders can be adjusted in place without re-funding round
  trips.
- ships an on-chain operator policy receipt (`PolicyReceipt`) for RFQ
  accepts, so dealer ranking is replayable after the fact.
- has a public testnet deployment with a working dApp pointed at it.

## Out of scope

See `docs/architecture-non-goals.md` for the full list. Short version:
no central limit-order-book matcher, no production order routing, no
oracle integration, no custody, no compliance/KYC layer. Those belong
in forks.

## Contract surface

```
DexPair                  pair listing, fee model, optional public observers
Pool                     constant-product pool, slice-local reserves
LPTokenPolicy            LP instrument supply ledger, accept-mint/burn gates
LPMintRequest            operator-issued; recipient + lpRegistrar jointly accept (first-pool funding)
LiquidityAllocationRequest  operator-issued; carries the add/remove-liquidity DvP allocation request
Order                    resting limit order backed by V2.Allocation
OrderAllocationRequest   trader-observed allocation request (V2 interface)
OrderMatchExecution      operator-driven match of two opposing allocations
MatchedTrade             bilateral block-trade carrier, optional PolicyReceipt
TradeAllocationRequest   per-authorizer allocation request for a matched trade
Rfq                      trader's request for quotes
RfqQuote                 dealer's quote against an Rfq
PolicyReceipt            on-chain record of operator ranking policy at accept time
Registry.V2.*            full CIP-0056 stack
```

The Daml package is `canton-dex-trading`. Current vetted version on the
public testnet: `v0.0.7`.

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
    wallet/         WalletConnect + mock provider
```

## Off-chain matcher

The on-chain `OrderMatchExecution` template adjusts and settles two
opposing allocations atomically. Orchestration (finding opposing
orders, computing fill quantity, picking fill price) lives in operator
code:

1. Operator scans active `Order` contracts via `/v1/orders`.
2. Pairs compatible orders: same `(baseInstrumentId, quoteInstrumentId)`,
   opposite `side`, `bid.limitPrice >= ask.limitPrice`.
3. Fill quantity = `min(bid.remainingQty, ask.remainingQty)`.
4. Fill price by operator policy (typically maker-priority or midpoint).
5. Creates `OrderMatchExecution` referencing both allocations and the
   fill numbers.
6. Exercises `OrderMatchExecution_Execute`, which:
   - calls `Allocation_Adjust` on each allocation with concrete legs
   - calls `SettlementFactory_SettleBatch` on the adjusted batch
   - returns `nextIterationAllocationCid` per side if any leftover
7. For the side with remainder, exercise `Order_RecordPartialFill`
   against the new next-iter allocation. For a fully-filled side,
   exercise `Order_Cancel` or let the allocation be archived by
   settlement.

The split is intentional: matchers change often, settlement primitives
do not. A fork can rewrite the matcher without touching any Daml
template.

## Wallet integration

The dApp does not sign as the trader. Trader-authority writes (place
order, add/remove-liquidity allocations via `AllocationFactory_Allocate`,
swap allocation creation, RFQ accept, LP-mint accept) go through the
connected wallet via CIP-0103
`canton_prepareExecute`. The operator-backend produces unsigned
command trees; the wallet signs and submits.

Read endpoints (`/v1/pools`, `/v1/trades` etc.) are operator-observed
and served from the backend's indexer cache.

See `docs/wallet-vs-dapp-boundary.md` for the per-choice contract.

## Extending the reference

| Goal | Read |
|---|---|
| Add a new trading pair (BTC/EUR, ETH/USDT, ...) | `guide-add-trading-pair.md` |
| Issue a new LP token or lifecycle-rich instrument (vested LP, dividend-bearing) | `guide-new-lp-or-instrument.md` |
| Add a different pricing curve (StableSwap, weighted) | See `examples/stable-pool/`. The Pool template is where you fork; the slice model is curve-agnostic. |
| Add a different RFQ policy (oracle-weighted, multi-tier) | `Rfq.applyPolicy` holds the sort chain. Bump `policyVersion` and mirror in `app/web/src/services/rfq-policy.ts`. |
| Add a new admin role | Update the party model in `operator-notes.md`. Add observer entries on the relevant templates (smart-upgrade allows adding observers as Optional fields at the end of the record). |
| Talk to a different participant | Set `CANTON_LEDGER_URL`, `CANTON_LEDGER_TOKEN`, `CANTON_SYNCHRONIZER`. See `docs/run-testnet.md`. |

## Smart-upgrade discipline

Once a contract template ships on-chain, future versions must be
binary-compatible. Rules enforced by the participant's upload check:

1. New fields must be `Optional` and at the end of the record.
2. Choices cannot be removed. Keep them as deprecated stubs that
   `abort`.
3. Choice input field types cannot change. To switch a type, add a
   new field instead.
4. Result-type fields cannot change. Define a new result variant for
   the new behaviour.
5. Field reordering is forbidden.

To break these you must rename the package, which abandons upgrade
lineage on testnet. Existing contracts from the old name remain
queryable but cannot be upgraded.

## Testing

```bash
cd trading-tests
daml test            # 26 in-script tests
```

Testnet smoke:

```bash
node --import tsx scripts/testnet-v2registry-trade.ts   # real V2-standard trade
```

## Likely next moves

Captured in `docs/architecture-non-goals.md`. Some items there are
deliberate non-goals; others are "not yet". The file separates the
two.
