# V2 Token Standard Alignment Audit

A flow-by-flow audit confirming every DEX action composes V2 Token
Standard choices and uses the TradingAppV2 settlement pattern. Each row
notes what the DEX writes and the V2 surface it consumes.

## Reference

- TradingAppV2: `vendor/splice-pr5333/token-standard/examples/splice-token-test-trading-app-v2/`
- PR-5333 allocation extensions: `vendor/splice-pr5333/token-standard/splice-api-token-allocation-v2/`
- BatchingUtilityV2: `vendor/splice/daml/splice-util-token-standard-wallet/`

## Order flow

| Step | Owner | V2 surface |
|------|-------|------------|
| Trader signs `OrderFundingRequest` | trader | `V2.AllocationRequest` (committed flavour) |
| Operator binds: exercises `OrderFundingRequest_Bind` | operator | creates `OrderAllocationRequest : AllocationRequest` |
| Trader allocates: `AllocationFactory_Allocate` + `OrderAllocationRequest_Accept` | trader (wallet) | `V2.AllocationFactory` + `V2.AllocationRequest_Accept` |
| Match: operator pairs two orders | operator | constructs `OTCTrade` per TradingAppV2 |
| Settle: `OTCTrade_RequestAllocations` | operator | yields per-leg `TradeAllocationRequest`s |
| Each leg's allocation: trader-signed | traders | `AllocationFactory_Allocate` |
| Settle batch: `OTCTrade_Settle` | operator | `V2.SettlementFactory_SettleBatch` over `SettlementBatchV2` |

## Pool swap flow

| Step | Owner | V2 surface |
|------|-------|------------|
| Trader signs `SwapRequest` | trader (wallet) | `AllocationFactory_Allocate` (prefunded) → `V2.Allocation` |
| Operator exercises `Pool_Swap` | operator | composes a one-leg `SettlementBatchV2` against `V2.SettlementFactory` |
| Pool's own legs use `committedAllocations` per PR-5333 | pool | committed allocations + `nextIterationAllocationCid` |

## Add liquidity flow

| Step | Owner | V2 surface |
|------|-------|------------|
| Trader signs `AddLiquidityRequest` referencing two prefunded allocations | trader (wallet) | `AllocationFactory_Allocate` × 2 |
| Operator exercises `Pool_AddLiquidity` | operator | merges incoming allocations into pool's committed allocations |
| LP mint via `LPMintRequest` | operator → lpRegistrar | `MintRequest` (DEX-side) — lpRegistrar holds `LPTokenPolicy` |

## Remove liquidity flow

| Step | Owner | V2 surface |
|------|-------|------------|
| Trader requests remove (operator-driven) | operator | exercises `Pool_RemoveLiquidity` |
| Operator emits `LPBurnRequest` | operator | DEX-side |
| Trader's wallet exercises `LPTokenPolicy_AcceptBurn` against locked LP holding | trader (wallet) | uses BatchingUtilityV2 if combining with the holding-burn |

## RFQ flow

| Step | Owner | V2 surface |
|------|-------|------------|
| Trader signs `Rfq` | trader | DEX-side template |
| Dealers post `RfqQuote` | dealer (wallet) | DEX-side template |
| Operator + trader co-sign `Rfq_Accept` | both | produces `MatchedTrade` with `PolicyReceipt` |
| Settlement: `OTCTrade_RequestAllocations` → `OTCTrade_Settle` | operator + traders | TradingAppV2 pattern |

## What we deliberately don't do

- **Never mint/burn/transfer holdings directly.** All asset movement
  goes through registry-defined V2 choices via the AllocationFactory /
  SettlementFactory. The DEX-side `CantonDex.Instrument.*` templates
  are a local mirror of the registry's user guide, used in dev/test;
  in production the registry's own templates take over.
- **Never key on `ContractId` for fungible state.** Pool, Order, and
  RFQ all key on `InstrumentConfiguration.instrumentId`. ContractId
  rotates per archive/recreate; `instrumentId` is stable.
- **Never version the LP instrument.** See `docs/lp-token-versioning.md`.

## Verification checklist

- [x] Daml: every `Pool_*` / `Order_*` / `Rfq_*` choice that touches
      assets ultimately calls into a `V2.AllocationFactory` or
      `V2.SettlementFactory` choice (verified by reading
      `pr5333/CantonDex/Dex/*.daml`).
- [x] Frontend: every trader-authority intent in
      `app/web/src/wallet/types.ts` corresponds to a V2 choice the
      wallet provider composes (see DEX-4 Token Standard provider).
- [x] Backend: `services/operator-backend/src/order/`, `pool/`,
      `rfq/` services build the V2 batch shapes and pass through to
      the ledger. The DEX never constructs raw Daml commands for
      registry templates.
- [x] Tests: `pr5333-tests/CantonDex/Tests/EndToEndTests.daml`
      exercises the full V2 path end-to-end against the MockRegistry.

## Open items tracked separately

- **DEX-26**: switch from vendored PR-5333 to upstream V2 when V2
  ships on MainNet (EOM July 2026 per Simon Meier).
- **DEX-27**: expand Daml test coverage for edge cases (partial fills,
  expired RFQs, credential rejection).
- **DEX-30**: testnet deployment automation to validate against a live
  Canton participant.
