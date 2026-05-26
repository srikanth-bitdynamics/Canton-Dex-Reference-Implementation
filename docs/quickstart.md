# Canton-Dex Quickstart

This is the M1 builder onboarding path. It gets a new evaluator from a fresh
clone to a passing local test run in under 10 minutes, then walks the four
runnable workflows they can read and adapt.

## Prerequisites

- macOS or Linux
- [Daml SDK 3.4.x](https://docs.digitalasset.com/getting-started/installation.html)
  - install via `curl -sSL https://get.daml.com/ | sh -s 3.4.11`
  - verify: `daml version` reports `3.4.11`
- `bash` (any recent version)
- `git` (only if you need to refresh `vendor/splice` or `vendor/splice`)

The Daml CLI emits a "DPM" deprecation warning on each build. It is informational;
the existing `daml build` flow is the supported path for this repo today.

## Two stacks, one repo

The repo carries two co-existing Daml projects against two different token-standard
snapshot:

| Path | Daml package | Token-standard surface | What it proves |
| --- | --- | --- | --- |
| `trading/` | `canton-dex-trading` | V2 standard (`vendor/splice/token-standard/`) | Matched-trade settlement, RFQ with policy receipts, pools + swaps, LP token, registry flows |

## One-command build + test

```bash
bash scripts/build-vendored-token-standard.sh
bash scripts/build-trading-surface.sh
( cd trading-tests && daml test )
( cd examples/stable-pool && daml test )
```

A successful run prints 31 test results in `trading-tests` and 3 in
`examples/stable-pool` — all marked `ok`. Any `failed` line means
something broke.

## What the four runnable workflow families look like

These are the four families called out in PR 108. Each one corresponds to a
specific test in `trading-tests/CantonDex/Tests/EndToEndTests.daml` and an
optional `src/`-stack analog.

### A. Pair / instrument listing

- `trading/CantonDex/Dex/DexPair.daml` — listing record with base + quote
  instrument id, fee model, trading mode (`OrderBook`, `Pool`, `Both`),
  and an `active` flag.
- `trading/CantonDex/Instrument/InstrumentConfiguration.daml` — registry-side
  `InstrumentConfiguration` with holder/issuer credential requirements and
  optional ISIN / CUSIP.
- Test: `InstrumentTests.daml::testInstrumentConfigCreate`.

### B. Matched-trade OTC / RFQ settlement (TradingAppV2 pattern)

- `trading/CantonDex/Dex/MatchedTrade.daml` — V2-only adaptation of
  `TradingAppV2`. `MatchedTrade_RequestAllocations` creates one request per
  authorizer; `MatchedTrade_Settle` groups by admin and calls
  `SettlementFactory_SettleBatch`; `MatchedTrade_Cancel` mirrors the cleanup.
- `trading/CantonDex/Dex/Rfq.daml` + `PolicyReceipt.daml` — the bilateral
  block-trade flow: trader RFQ, dealer quotes, joint `Rfq_Accept` that emits a
  `MatchedTrade` carrying an operator-signed `PolicyReceipt` folded into
  `SettlementInfo.meta`.
- Tests: `EndToEndTests.daml::testMatchedTradeFullSettle`,
  `testRfqAcceptProducesMatchedTradeWithReceipt`,
  `testTradeAllocationRequestAccept`.
- Vendored upstream reference: see
  `vendor/splice/token-standard/examples/splice-token-test-trading-app-v2/`.

### C. Resting orders backed by V2.Allocation

- `trading/CantonDex/Dex/OrderFundingRequest.daml` — trader-signed intent.
- `trading/CantonDex/Dex/Order.daml` — operator-bound `Order` plus
  `OrderAllocationRequest`. Funding requires the trader to accept the allocation
  request AND compose `AllocationFactory_Allocate` in the same submission, so
  the trader's authority drives the holding movement (the operator cannot move
  trader holdings on their own).
- `trading/CantonDex/Dex/OrderMatchExecution.daml` — applies the V2
  prefunded-trade pattern: both prefunded allocations get `Allocation_Adjust`-ed
  with the concrete match legs, then batch-settled; next-iteration CIDs roll
  forward onto partial fills.
- Tests: `EndToEndTests.daml::testOrderFundingFlow`,
  `testAllocationAdjustConservation`.

### D. Constant-product pool with committed allocations

- `trading/CantonDex/Dex/Pool.daml` — `Pool_Initialize`,
  `Pool_AddLiquidity`, `Pool_RemoveLiquidity` (slice-local), `Pool_Swap`
  (iterated-settlement roll-forward of the head slice), plus
  `Pool_ComputeSwapOut`, `Pool_Pause`, `Pool_Resume`, `Pool_RecordLPSupply`.
- `trading/CantonDex/Dex/LPToken.daml` — `LPTokenPolicy` owned by an
  `lpRegistrar` party (distinct from the DEX `operator`), plus
  `LPMintRequest` and `LPBurnRequest`. Accept exercises produce registry-side
  `Holding` records, so the LP token is a real token-standard-native instrument.
- `trading/CantonDex/Dex/SwapExecution.daml` — trader-facing `SwapRequest`.
- `trading/CantonDex/Dex/LiquidityRequest.daml` — LP-initiated deposit and
  withdraw intents (traffic-cost split: LP pays for their own funding actions).
- Tests: `EndToEndTests.daml::testPoolFullLifecycle`, `testPoolSwapEndToEnd`,
  `testPoolRemoveLiquidityConsolidates`, `testPoolRemoveLiquiditySliceLocal`.

## What to read first

Approach the repo in this order; each layer references only the four pinned
upstream sources:

1. `docs/architecture.md` — system model and the four-layer separation.
2. `docs/workflows.md` — the ten workflows, with which ones run today vs. need V2 surface support.
3. `trading/CantonDex/Dex/Pool.daml` — read top-to-bottom to see the
   slice-local invariant and the iterated-settlement pattern in one place.
4. `trading-tests/CantonDex/Tests/EndToEndTests.daml` — the same workflows
   exercised against the mock registry.

## How to adapt the reference

The repo is meant to be read AND copied. Common adaptations:

| Goal                                  | Files to copy or extend                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Add a new trading pair                | Create a `DexPair`; optionally a `Pool` if the pair runs pool-mode                                |
| Use a different instrument family     | Create a new `InstrumentConfiguration` (different `admin`, different credential requirements)     |
| Swap out the mock registry            | Replace `CantonDex.Testing.MockRegistry` with the real registry's `AllocationFactory` + `SettlementFactory` |
| Add a fee policy                      | Extend `Pool.feeBps` / `DexPair.feeModel` and the `Pool_ComputeSwapOut` math                      |
| Change RFQ ranking policy             | Modify `Rfq.applyPolicy` and bump the `PolicyReceipt.policyVersion` / `policyHash`               |

The boundary that must NOT move:

- DEX contracts own market structure (orders, trades, pools, LP issuance).
- Token-standard contracts own reservation and settlement.
- Registry contracts own asset semantics.

Any change that blurs these is going against the design and will surface as
duplicated state or authority confusion in the workflows.

## Where to ask for help

- File issues against this repo.
- For upstream questions on the token-standard or V2 semantics, follow
  the canonical references linked at the top of [README.md](../README.md).
