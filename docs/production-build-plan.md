# Canton-Dex Production Build Plan

Last updated: 2026-05-06

## Goal

Build a production-shaped reference implementation of:

- a token-standard-native settlement pattern
- a reference DEX built from that settlement pattern

## Guardrails

The implementation must stay source-driven.

Primary source workflows:

1. `TradingAppV2`
   - `OTCTradeAllocationRequest`
   - `OTCTrade_RequestAllocations`
   - `OTCTrade_Settle`
   - `OTCTrade_Cancel`
   - `SettlementFactory_SettleBatch`
   - `TradeSettlementAgreement` helpers only where the source workflow still
     requires them

2. Registry workflows
   - `InstrumentConfiguration` creation
   - Mint request / accept / reject / cancel
   - Burn request / accept / reject / cancel
   - Transfer offer / accept / reject
   - direct transfer via preapproval

3. PR 5333 allocation extensions
   - iterated settlement
   - `nextIterationFunding`
   - committed allocations
   - `Allocation_Adjust`
   - `nextIterationAllocationCid`

Implementation rules:

- do not invent new settlement abstractions
- do not create parallel market workflows that are not compositions of the
  source workflows above
- do not introduce `Lockable`-style or wrapper-first fallback architecture
- use the three user-provided source documents as the main implementation
  reference

## Interface Posture

Trader-facing support should include both:

- token standard wallet support for holdings, LP-token balances, allocation
  requests, and standard accept / reject / withdraw style actions
- a custom DEX dApp UI for market-specific workflows such as pair discovery,
  RFQ creation and quote comparison, order book placement, pool statistics,
  slippage preview, LP position management, and admin/operator flows

Implementation rule:

- do not force the token standard wallet to be the exclusive trader interface
  for DEX-specific workflows
- do not build a custom UI that bypasses token-standard-native approval and
  custody flows where the wallet is the right UX

## Operator Backend Posture

The reference implementation requires an operator backend.

That backend is responsible for the DEX operator's actions, including:

- RFQ intake, ranking, and policy-receipt production
- binding order and liquidity requests into live DEX state
- driving `Allocation_Adjust` and `SettlementFactory_SettleBatch`
- order-match execution and pool-swap execution
- expiry and cancellation cleanup
- registry context / disclosure retrieval where needed
- observability, replay protection, and recovery automation

## Current Status

Overall status: stable V2 source-wiring complete, local matched-trade baseline
complete; PR-5333-compatible allocation wiring, executable Daml coverage,
operator backend JSON-API driver, and a buildable mockup-shaped dApp are all
in place

Completed today:

- created a living production plan file
- created the initial repo structure for `daml/`, `services/`, and `app/`
- narrowed the build plan so future implementation stays aligned with the
  source workflows
- created a buildable Daml package scaffold with source-aligned module anchors
- validated the bootstrap with `daml build`
- vendored the upstream Splice `token-standard` subtree locally via sparse
  checkout
- built the local upstream base packages needed for the V2 path:
- built the full locally vendored source stack required by the stable
  `TradingAppV2` path
- added repeatable build scripts for the vendored source stack and the local
  package
- wired the local package to the built token-standard DARs
- replaced the `OTCTradeV2` placeholder with a source-derived local
  implementation of the upstream matched-trade workflow
- resolved the local buildability issue in
  `splice-api-token-transfer-events-v2` by applying a build-metadata-only SDK
  compatibility patch
- added a source-alignment check for the local `OTCTradeV2` workflow body
- folded the source-alignment check into the main source-stack build path
- added a source-derived local backend query helper from the upstream
  `TradingAppV2_Backend` test support
- added executable Daml Script coverage for request, query, and cancel slices of
  the local matched-trade workflow
- added a source-alignment check for the local backend query helper
- added a standalone local test runner for the executable Daml Script tranche
- split the production Daml package from the Daml Script test package so the
  main reference DAR no longer depends on `daml-script`
- fetched PR 5333 into a parallel vendored Splice worktree
- mapped the exact `AllocationV2` delta between stable local V2 and PR 5333
- added a dedicated local script for building the PR-5333 token-standard core
  package set
- added a separate `pr5333-tests/` Daml Script package for PR-side DEX
  workflow coverage
- added a separate local `pr5333/` Daml package that compiles directly against
  the branch-only `AllocationV2` surface
- added a branch-native PR-5333 helper layer for moved admin and
  next-iteration funding semantics
- added branch-native workflow constructors for prefunded allocation creation,
  committed pool-fund allocation creation, batch settlement, and rolled-forward
  allocation cancellation
- added a repeatable probe for the unchanged upstream PR-5333
  `TradingAppV2` example and utility-layer build status

Not started yet:

- testnet or production deployment assets

## Workstreams

### 1. Source-aligned dependency wiring

Status: in progress

Tasks:

- [x] decide the exact local dependency strategy for the token-standard sources
- [x] wire the local Daml package to the stable `TradingAppV2` surface
- [x] wire the local Daml package to the PR 5333 surface
- [x] prove which PR-5333 packages remain buildable unchanged versus which need
      local source-derived adaptation
- [x] decide whether branch-specific local helpers should replace the stable
      token-standard utility layer for PR-5333 DEX modules
- [x] record which parts are available on stable upstream versus branch-only

Notes:

- local dependency strategy now uses a vendored sparse checkout at
  `vendor/splice/token-standard`
- plain local builds emit versioned DARs, while upstream package references
  expect `*-current.dar`; local wiring currently mirrors those filenames by
  copying the built DARs
- the stable local V2 core is buildable end to end
- the snapshot SDK mismatch in `splice-api-token-transfer-events-v2` has been
  handled locally as a build-metadata patch
- PR 5333 semantics are still pending as the next distinct wiring tranche
- the PR branch is now locally available under `vendor/splice-pr5333`
- the exact branch-only API delta is recorded in
  `docs/pr5333-allocation-surface.md`
- a separate local branch package now exists under `pr5333/` to compile
  directly against the PR-5333 API DARs
- the branch package now includes `CantonDex.Pr5333.Utils`, which intentionally
  replaces only the helper slice invalidated by the moved admin and
  next-iteration funding semantics
- the branch package now also includes `CantonDex.Pr5333.WorkflowConstructors`
  so local PR-side order and pool preparation can stay on existing token
  standard choice arguments
- `bash scripts/probe-pr5333-tradingappv2-build.sh` now gives a repeatable
  answer on whether the unchanged upstream example can build unchanged

### 2. TradingAppV2 baseline

Status: in progress

Tasks:

- [x] implement the matched-trade baseline around `OTCTrade`
- [x] keep request / settle / cancel choices source-aligned
- [x] validate request, query, and cancel behavior with executable tests
- [ ] validate admin-grouped batch settlement as in the source example with
      executable tests

Notes:

- the local `OTCTradeV2` module now compiles against the built token-standard
  DARs
- `bash scripts/check-tradingappv2-alignment.sh` passes against the vendored
  upstream workflow body
- the local `TradingAppV2_Backend` query slice is now mirrored under
  `tests/CantonDex/Testing/OTCTradeV2Backend.daml`
- `daml test` now covers the source-derived request grouping and cancel
  archival behavior without inventing extra workflow steps
- the current executable tests now live in a separate Daml package under
  `tests/`, while production modules live under `src/`
- the upstream `splice-token-standard-test-v2` validation path requires
  additional non-token-standard DAR inputs beyond the current vendored subset

### 3. Registry-backed instrument layer

Status: done

Tasks:

- [x] integrate `InstrumentConfiguration` assumptions into the local model
      ([CantonDex/Instrument/](../pr5333/CantonDex/Instrument/))
- [x] document mint, burn, and transfer prerequisites from the registry docs
      ([registry-prerequisites.md](./registry-prerequisites.md))
- [x] wire choice-context and disclosure retrieval requirements into the service
      plan ([choice-context-spec.md](./choice-context-spec.md);
      registry-client uses `disclosure` on every operator submit)

### 4. PR 5333 allocation extensions

Status: in progress

Tasks:

- [x] build the PR-5333 core token-standard stack locally
- [x] verify the local `pr5333/` package against the built PR-5333 API DARs
- [x] prove that the upstream `TradingAppV2` source itself is unchanged on the
      PR branch
- [x] add constructor support for iterated settlement semantics on the PR
      surface
- [x] add constructor support for committed allocations for pool-fund
      representation
- [x] use allocation adjustment only where the source surface supports it
- [x] build DEX reference contracts consuming the PR-side constructors
- [x] verify all DEX modules build against the PR 5333 allocation surface
- [x] add Daml Script coverage for the prefunded-order funding flow
- [x] add Daml Script coverage for the RFQ accept -> MatchedTrade ->
      PolicyReceipt path
- [x] add Daml Script coverage for constant-product pool init / add / remove
      lifecycle behavior
- [x] extend PR-side Daml Script coverage to the `Pool_Swap` happy path
- [x] add PR-side Daml Script coverage for the full matched-trade settlement
      happy path (`MatchedTrade_RequestAllocations` -> accepts ->
      `MatchedTrade_Settle`)
- [x] add Daml Script coverage for the registry workflows
      (`InstrumentConfiguration`, `MintRequest`, `BurnRequest`,
      `TransferOffer`, `TransferPreapproval`)
- [x] add stable-side coverage for admin-grouped batch settlement
      precondition (`splitLegsByAdmin` correctness across two admins)
- [x] wire `LPTokenPolicy_AcceptMint` / `_AcceptBurn` to produce real
      registry-side LP holdings under `lpRegistrar`'s admin authority
      instead of just updating supply
- [ ] refactor the pool withdrawal / rebalance path so routine liquidity
      actions do not have to cancel and recreate every reserve allocation
      at once
- [x] make the executor-control constraint explicit in the Daml state model:
      iterated / committed funds may only be used through app-validated
      workflows
      ([MockRegistry.daml](../pr5333/CantonDex/Testing/MockRegistry.daml)
      `allocation_adjustImpl` enforces funding conservation in Daml; see
      `testAllocationAdjustConservation` in
      [EndToEndTests.daml](../pr5333-tests/CantonDex/Tests/EndToEndTests.daml)
      and the "What the registry MUST enforce in `Allocation_Adjust`"
      section of [registry-prerequisites.md](./registry-prerequisites.md))

Notes:

- the dedicated PR-side executable test package now lives under
  `pr5333-tests/`
- `daml test` passes in `pr5333-tests/` (21 tests) and in `tests/` (3 tests)
- verified PR-side passing tests currently include:
  - `testOrderFundingFlow`
  - `testPoolFullLifecycle`
  - `testPoolRemoveLiquidityConsolidates`
  - `testPoolSwapEndToEnd`
  - `testRfqAcceptProducesMatchedTradeWithReceipt`
  - `testMatchedTradeFullSettle`
  - `testTradeAllocationRequestAccept`
  - `PolicyReceiptTests` (10 tests)
  - `InstrumentTests` (6 tests covering mint/burn/transfer/preapproval)
- verified stable-side passing tests include:
  - `test_request_allocations_groups_by_authorizer`
  - `test_request_allocations_supports_multiple_admins` (the admin-grouping
    precondition)
  - `test_cancel_archives_trade_and_requests`
- architectural follow-up from the executor-control review:
  - orders are already close to the desired shape because one order owns one
    prefunded allocation reference
  - pool swaps are close because they replace only the touched reserve slice
  - pool withdrawals are not there yet because `Pool_RemoveLiquidity` still
    cancels all reserve allocations before rebuilding the remainder

### 5. Services and operations

Status: in progress (scaffolding complete, not deployed)

Tasks:

- [x] registry client for disclosed context retrieval
      (`services/registry-client/`)
- [x] operator backend module structure for RFQ ranking, request
      binding, matching, swap execution, settlement orchestration,
      and cleanup (`services/operator-backend/src/{rfq,order,pool,
      matched-trade,settlement}/`)
- [x] worked end-to-end example: RFQ accept through the operator
      backend with InMemoryLedger harness (`test/rfq.test.ts` passes)
- [x] HTTP shim for dApp integration (`services/operator-backend/src/http/`)
- [x] source-driven guardrail expressed as the choice vocabulary in
      `services/operator-backend/src/index.ts` (auditable by grepping
      choice names across the modules)
- [x] production notes for observability, recovery, and deployment
      (`docs/production-notes.md`)
- [x] choice-context retrieval requirements
      (`docs/choice-context-spec.md`)
- [x] registry prerequisites doc
      (`docs/registry-prerequisites.md`)
- [x] wire the operator backend to a real Canton ledger via JSON API
      (`services/operator-backend/src/ledger/json-api.ts`)
- [ ] integration with the upstream token-standard
      `TradingAppV2`-style test harness once the upstream utility
      layer is unblocked
- [x] expand the InMemoryLedger and Canton-backed service tests beyond
      RFQ accept to RFQ list / create / cancel; pool swap, pool
      remove-liquidity, and order-funding e2e fixtures still pending

Notes:

- the operator backend's choice vocabulary IS the source-driven guardrail;
  adding a new orchestration verb requires either a new contract choice
  or a composition of existing ones
- the operator backend now has both:
  - fast Node coverage for RFQ accept on the `InMemoryLedger` harness
  - a Canton-backed JSON-API integration test path in
    `services/operator-backend/test/canton-e2e.test.ts`
- the Canton-backed test path is real but gated behind `CANTON_E2E=1`
  and a live local participant; the default `npm test` run still skips it
- this is still not equivalent to full token-standard application parity,
  because pool / order / wallet flows are not yet covered through the live
  service stack

### 6. Trader interfaces

Status: in progress (buildable and substantially integrated, not fully live)

Tasks:

- [x] document the wallet ↔ dApp boundary
      (`docs/wallet-vs-dapp-boundary.md`)
- [x] wallet-handoff helper for trader-authority actions
      (`app/web/src/wallet/handoff.ts`)
- [x] typed operator backend HTTP client
      (`app/web/src/services/operator-api.ts`)
- [x] worked example: swap card wired to operator backend +
      wallet handoff (`app/web/src/components/SwapCardWired.tsx`)
- [x] align the UI service contract to the operator backend `/v1/...`
      routes
- [x] install and wire the frontend dependencies so `npm run build`
      passes in `app/web`
- [x] port the major mockup surfaces into the live dApp
      (`Trade`, `Pools`, `Orders`, `RFQ`, `Portfolio`, `Admin`)
- [x] wire RfqPage to the live operator backend (10s react-query
      refetch over `/v1/rfq`; create / cancel / accept all live)
- [x] wire the trader-side LP-burn-accept handoff into the dApp
      remove-liquidity path (`AcceptLpBurnIntent` in
      [wallet/handoff.ts](../app/web/src/wallet/handoff.ts))
- [x] wire the remaining dApp pages (Pools list, Orders, Portfolio,
      Admin) to live operator backend reads; Admin write actions now
      hit `/v1/admin/pairs` and `/v1/admin/pools`
      ([AdminPage.tsx](../app/web/src/pages/AdminPage.tsx))
- [ ] integrate with a real Canton wallet (Daml Hub wallet, third-
      party token-standard wallet); the wallet handoff intents are
      defined but no concrete wallet is wired up
- [ ] production polish on the custom dApp UI (visual / interaction
      pass, not new functional surface)
- [x] document the boundary between wallet-native actions and dApp-native
      actions ([wallet-vs-dapp-boundary.md](./wallet-vs-dapp-boundary.md))

Notes:

- the current `app/web` package now builds successfully with `npm run build`
- the UI service contract is now substantially aligned with the operator
  backend HTTP surface under `/v1/...`
- the detailed mapping of the external mockup files to the current app surface
  now lives in `docs/ui-mockup-integration-map.md`
- remaining UI/backend gaps:
  - `RfqPage` is now live against `/v1/rfq` (list / create / cancel /
    accept); the local `rfq-mock.ts` is retained only as the source
    of `rankQuotes` / `whitelistedDealers` helpers
  - `/v1/pools/remove-liquidity` is wired to `Pool_RemoveLiquidity`;
    the dApp's `removeLiquidity` now also fires the
    `AcceptLpBurnIntent` wallet handoff so the round-trip is
    complete once a concrete wallet is plugged in
  - there is still no UI integration suite running against a live Canton /
    token-standard stack analogous to the full application-style
    `TradingAppV2` validation path

## Current Tranche

Tranche objective:
- move from empty scaffold to real source dependency wiring without introducing
  speculative contracts

Tranche tasks:

- [x] create repo structure
- [x] create living plan file
- [x] add source-aligned package and module scaffolding
- [x] validate bootstrap with the local toolchain

Next tranche tasks:

- [x] decide whether the first implementation branch should target the stable
      locally buildable V2 core or a PR-5333-compatible source checkout
- [x] build the remaining upstream packages required by `TradingAppV2`
- [x] replace the `OTCTradeV2` scaffold with a source-aligned real
      implementation
- [x] add a repeatable source-alignment check for the local matched-trade
      workflow body
- [x] validate the local matched-trade module against the upstream example with
      focused tests
- [x] start a separate PR-5333-compatible allocation wiring tranche for orders
      and pools
- [x] probe the upstream `TradingAppV2` example against the PR-5333 core stack

## Update Log

### 2026-05-05

- Started the production implementation track.
- Added repo structure for `daml/`, `services/`, and `app/`.
- Recorded the explicit constraint that implementation must follow the existing
  `TradingAppV2`, registry workflow, and PR 5333 workflow surfaces.
- Added a buildable Daml package scaffold with canonical module paths under
  `daml/CantonDex/...`.
- Validated the bootstrap with `daml build`, producing
  `.daml/dist/canton-dex-0.0.1.dar`.
- Vendored the upstream Splice `token-standard` subtree locally and confirmed
  the real package layout for the source-driven implementation.
- Added repeatable scripts for building the vendored source stack and the local
  package.
- Built the full stable local source stack, including the upstream
  `splice-token-test-trading-app-v2` example.
- Patched the vendored `splice-api-token-transfer-events-v2` package metadata so
  it builds on the local SDK without changing its workflow semantics.
- Wired the local package to the built token-standard DARs.
- Replaced the `OTCTradeV2` scaffold with a source-derived local implementation
  of the upstream matched-trade flow.
- Added and passed a source-alignment check for the local `OTCTradeV2`
  workflow body against the vendored upstream `TradingAppV2` source.
- Added a local source-derived backend query helper for
  `queryTradesWithAllocations` based on the upstream `TradingAppV2_Backend`
  module.
- Added executable Daml Script tests for request grouping, trade query, and
  cancel archival on the stable local `TradingAppV2` baseline.
- Added a source-alignment check for the local backend query helper.
- Added a standalone local test runner for the executable Daml Script tranche.
- Split production and test packages so the main `canton-dex` DAR builds
  without a direct `daml-script` dependency.
- Fetched Splice PR 5333 into `vendor/splice-pr5333` as a parallel source base
  so the stable local V2 path remains intact.
- Recorded the exact `AllocationV2` API delta for PR 5333 and added a
  dedicated build script for the PR-5333 core token-standard package set.
- Added a separate local branch package under `pr5333/` for compiling against
  the branch-only `AllocationV2` API surface.
- Added a branch-native helper module under `pr5333/` for PR-5333 funding
  deltas and prefunded/committed allocation construction.
- Added `CantonDex.Pr5333.WorkflowConstructors` so the exact PR-5333 prefunding
  flow steps can be assembled from existing token-standard choice arguments.
- Added a repeatable local probe for the unchanged upstream PR-5333
  `TradingAppV2` example and the current utility-layer blocker.
- Verified that the PR-5333 core API build and the local `pr5333/` package both
  build successfully after the helper-layer additions.
- Built the full DEX reference implementation on the PR 5333 surface:
  - `CantonDex.Dex.DexPair` for trading pair listing
  - `CantonDex.Dex.MatchedTrade` for PR-5333-native OTC settlement (V2-only)
  - `CantonDex.Dex.Order` for prefunded resting orders with partial fill
    roll-forward
  - `CantonDex.Dex.Pool` for constant-product AMM backed by committed
    allocations with iterated settlement
  - `CantonDex.Dex.LPToken` for pool share issuance
  - `CantonDex.Dex.SwapExecution` for trader swap request lifecycle
  - `CantonDex.Dex.OrderMatchExecution` for atomic order matching
- Verified the full PR 5333 package builds with all DEX modules.
- Added a separate `pr5333-tests/` Daml Script package for PR-side executable
  workflow coverage.
- Verified `daml test` passes in `pr5333-tests/`.
- Confirmed executable PR-side coverage for:
  - prefunded-order funding
  - RFQ accept -> MatchedTrade -> PolicyReceipt
  - pool init / add / remove lifecycle
  - PolicyReceipt / MatchedTrade receipt invariants
- Recorded the remaining PR-side executable-test gaps explicitly:
  - full `MatchedTrade_Settle` happy path
  - `Pool_Swap` happy path
- Verified the operator backend Node tests pass on the in-memory ledger harness.
- Verified the frontend is not yet runnable as a live integrated UI in this
  workspace:
  - `app/web` dependencies are not installed locally
  - `npm run build` fails with `tsc: command not found`
  - the UI API contract is not yet aligned with the backend HTTP routes
  - there is no token-standard-infrastructure-backed UI integration test
    harness yet
