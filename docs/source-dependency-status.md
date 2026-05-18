# Source Dependency Status

Last updated: 2026-05-18

## Purpose

Track the exact upstream source dependency state for the source-driven
implementation.

## Upstream Source Base

Vendored source (single source of truth):

- `vendor/splice/token-standard`
- `vendor/splice/daml/` (subset: `splice-amulet`, `splice-util`, `splice-util-token-standard-wallet`)
- upstream: <https://github.com/canton-network/splice/tree/token-standard-v2-upcoming>
- branch: `token-standard-v2-upcoming`
- last refresh: 2026-05-18 (branch tip `a5b54c9`)

Per [Simon Meier (DA)][simon-slack] on 2026-05-18, we track the branch
tip rather than a specific PR commit so we pick up subsequent V2 work
beyond what PR-5333 introduced. PR-5333's content has been merged into
this branch upstream; the previously-parallel `vendor/splice/`
tree was retired (DEX-31 / DEX-35).

[simon-slack]: https://linear.app/bitdynamics/issue/DEX-31

The branch tip carries non-trivial API changes vs. the original PR-5333
shape (DEX-35 ticket has the full delta):

- `AllocationSpecification.transferLegs : [TransferLeg]` → `transferLegSides : [TransferLegSide]`
- `Allocation_Adjust` choice retired; iterated-settlement now flows through
  `SettlementFactory_SettleBatch` via `FinalizedAllocation.extraTransferLegSides`
  + `nextIterationFunding`.
- `Allocation_*Result` types unified into `AllocationResult { output, authorizerHoldingCids, meta }`.
- `HoldingV2.Account.owner : Party` → `Optional Party`.
- `AllocationView` gained `createdAt` + `numIterations`.
- `AllocationRequestView` reshaped: `transferLegs` → `allocations : [RequestedAllocation]` plus `requestedAt` + `settleAt`.
- `TransferEventsV2.TransferLeg` retired; `TransferLegSide` exported instead.
- `Splice.TokenStandard.Utils.splitLegsByAdmin` / `splitLegsByAuthorizer` retired;
  `accountParties` now takes admin Party as a first argument.

The DEX's `trading/` surface, `trading-tests/`, `src/` reference stack
and `tests/` Script suite are all migrated to the new API. The
operator backend's TypeScript surface continues to consume
`canton-dex-trading` and required no schema-level changes for this
migration.

Primary source workflows consumed from the subtree:

- `examples/splice-token-test-trading-app-v2`
- `splice-api-token-holding-v2`
- `splice-api-token-allocation-v2`
- `splice-api-token-allocation-request-v2`
- `splice-api-token-allocation-instruction-v2`
- `splice-token-standard-utils`

## Local Buildability

Built successfully from vendored source:

- `splice-api-token-metadata-v1`
- `splice-api-token-holding-v1`
- `splice-api-token-holding-v2`
- `splice-api-token-allocation-v1`
- `splice-api-token-allocation-v2`
- `splice-api-token-allocation-request-v1`
- `splice-api-token-allocation-request-v2`
- `splice-api-token-allocation-instruction-v1`
- `splice-api-token-allocation-instruction-v2`
- `splice-api-token-transfer-instruction-v1`
- `splice-api-token-transfer-instruction-v2`
- `splice-api-token-transfer-events-v2`
- `splice-token-standard-utils`
- `examples/splice-token-test-trading-app-v2`

Local packages consuming the built DARs:

- `daml.yaml` + `src/CantonDex/...` — V1 reference stack
- `tests/daml.yaml` + `tests/CantonDex/...` — V1-bridge Daml Script tests
- `trading/daml.yaml` + `trading/CantonDex/...` — the V2 surface package (production); name retained for git history continuity
- `trading-tests/daml.yaml` + `trading-tests/CantonDex/...` — V2-side Daml Script tests

All four packages build clean against the refreshed vendored DARs
(verified 2026-05-18 after the DEX-35 migration).

Notes:

- the production package consumes the token-standard DARs directly
- executable Daml Script validation lives in `tests/` and `trading-tests/`
- the upstream `splice-token-test-trading-app-v2` DAR is built as a source
  validation artifact; the local matched-trade flow is implemented in
  `src/CantonDex/DexApp/OTCTradeV2.daml` and `trading/CantonDex/Dex/MatchedTrade.daml`
- the V2 surface (PR-5333 allocation extensions, plus the
  subsequent refactor towards V2 release) is upstream in
  `token-standard-v2-upcoming`, so no parallel vendor tree is needed
- the `trading/` package now includes:
  - `CantonDex.Trading.Utils`
  - `CantonDex.Trading.AllocationSurface`
  - `CantonDex.Trading.WorkflowConstructors`
  - `CantonDex.Dex.DexPair`
  - `CantonDex.Dex.MatchedTrade`
  - `CantonDex.Dex.Order`
  - `CantonDex.Dex.Pool`
  - `CantonDex.Dex.LPToken`
  - `CantonDex.Dex.SwapExecution`
  - `CantonDex.Dex.OrderMatchExecution`

## Local Compatibility Patch

One build-metadata compatibility patch is currently applied locally:

- `vendor/splice/token-standard/splice-api-token-transfer-events-v2/daml.yaml`
  - `sdk-version` pinned to `3.4.11` (matches our toolchain).

The package source itself builds cleanly on `3.4.11`. Re-applied on
every `vendor/splice/` refresh.

## Current Conventions

Upstream package files expect `*-current.dar` filenames in data-dependencies.

The local build scripts therefore:

- build the versioned DAR
- copy it to the matching `*-current.dar` filename

Scripts:

- `scripts/build-vendored-token-standard.sh` — builds the V2 surface from `vendor/splice/`
- `scripts/build-trading-surface.sh` — chains to the above, then `daml build` in `trading/`
- `scripts/build-source-stack.sh` — V1 reference stack (`src/`)
- `scripts/probe-trading-tradingappv2-build.sh` — sanity check against the upstream TradingAppV2 example
- `scripts/run-local-daml-tests.sh` — runs all local Daml Script tests
- `scripts/check-tradingappv2-alignment.sh` — verifies local `OTCTradeV2` stays aligned with upstream `TradingAppV2`
- `scripts/check-tradingappv2-backend-alignment.sh` — same for the backend slice

(`scripts/build-vendored-token-standard.sh` was removed when
`vendor/splice/` was retired in DEX-31 / DEX-35.)

## Next Integration Step

Major migrations queued:

- **V2 MainNet release (EOM July 2026 per [proposal M7][proposal-m7])**: once the
  V2 release artifacts ship on `splice/main`, drop the branch-tip dependency
  and point at release tags. Tracked in DEX-26.
- **V1 → V2 dual-implementation per CIP-0112 §5**: when Canton Coin and USDCx
  implement V2 interfaces alongside V1, our DEX can trade those assets natively.
  No DEX code change required at that point.

[proposal-m7]: https://github.com/canton-foundation/canton-dev-fund/blob/main/proposals/proposal-token-standard-v2.md#milestones-and-deliverables

Ongoing alignment work:

- keep the remaining settlement-batch backend slice aligned with
  `TradingAppV2_Backend` as wider registry test dependencies are made
  locally available
- keep composing PR-side order and pool preparation from the local
  workflow constructor layer instead of inventing new settlement steps
- keep registry integration constrained to the documented workflow surface
- add Daml Script tests for the DEX modules as the test infrastructure
  upstream stabilizes
- wire the DEX frontend to the on-ledger contract workflows via a JSON API
  or gRPC service layer
- rewrite `testAllocationAdjustConservation` against the iterated
  SettleBatch path (current stub; tracked on DEX-35 follow-up)
