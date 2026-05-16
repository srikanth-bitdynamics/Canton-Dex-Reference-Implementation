# Source Dependency Status

Last updated: 2026-05-05

## Purpose

Track the exact upstream source dependency state for the source-driven
implementation.

## Upstream Source Base

Vendored source:

- `vendor/splice/token-standard`
- branch: `token-standard-v2-upcoming`
- `vendor/splice-pr5333/token-standard`
- branch: `pr-5333`

Primary source workflows consumed from that subtree:

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

Built successfully from the parallel PR-5333 source base:

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

Local package consuming the built DARs:

- `daml.yaml`
- `src/CantonDex/...`
- `tests/daml.yaml`
- `tests/CantonDex/...`
- `pr5333/daml.yaml`
- `pr5333/CantonDex/...`

Notes:

- the production package consumes the token-standard DARs directly
- executable Daml Script validation now lives in a separate test package under
  `tests/`
- the upstream `splice-token-test-trading-app-v2` DAR is built as a source
  validation artifact, but the local matched-trade flow is now implemented in
  `src/CantonDex/DexApp/OTCTradeV2.daml`
- PR 5333 is tracked as a parallel vendored worktree so branch-only allocation
  semantics can be wired without destabilizing the stable local V2 baseline
- the PR local package now includes:
  - `CantonDex.Pr5333.Utils`
  - `CantonDex.Pr5333.AllocationSurface`
  - `CantonDex.Pr5333.WorkflowConstructors`
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
  - `sdk-version` changed from
    `3.3.0-snapshot.20250502.13767.0.v2fc6c7e2`
  - to `3.4.11`
- `vendor/splice-pr5333/token-standard/splice-api-token-transfer-events-v2/daml.yaml`
  - `sdk-version` changed from
    `3.3.0-snapshot.20250502.13767.0.v2fc6c7e2`
  - to `3.4.11`

Reason:

- the snapshot SDK is not available locally
- the package source itself builds cleanly on `3.4.11`

This is a local compatibility patch, not a workflow change.

## Current Conventions

Upstream package files expect `*-current.dar` filenames in data-dependencies.

The local build scripts therefore:

- build the versioned DAR
- copy it to the matching `*-current.dar` filename

Scripts:

- [build-vendored-token-standard.sh](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/scripts/build-vendored-token-standard.sh)
- [build-vendored-token-standard-pr5333.sh](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/scripts/build-vendored-token-standard-pr5333.sh)
- [build-pr5333-surface.sh](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/scripts/build-pr5333-surface.sh)
- [probe-pr5333-tradingappv2-build.sh](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/scripts/probe-pr5333-tradingappv2-build.sh)
- [build-source-stack.sh](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/scripts/build-source-stack.sh)
- [run-local-daml-tests.sh](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/scripts/run-local-daml-tests.sh)
- [check-tradingappv2-alignment.sh](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/scripts/check-tradingappv2-alignment.sh)
- [check-tradingappv2-backend-alignment.sh](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/scripts/check-tradingappv2-backend-alignment.sh)

## Next Integration Step

The next source-aligned implementation step is:

- keep the remaining settlement-batch backend slice aligned with
  `TradingAppV2_Backend` as wider registry test dependencies are made locally
  available
- keep the parallel PR-5333 allocation work on the branch-native helper layer,
  then wire pool and prefunding work to that exact allocation surface
- keep composing PR-side order and pool preparation from the local workflow
  constructor layer instead of inventing new settlement steps
- keep the PR-side helper layer narrow and source-derived instead of assuming
  the stable token-standard utility layer carries over
- keep registry integration constrained to the documented workflow surface
- add Daml Script tests for the DEX modules where the PR 5333 test
  infrastructure supports it
- wire the DEX frontend to the on-ledger contract workflows via a JSON API
  or gRPC service layer
