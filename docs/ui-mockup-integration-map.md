# UI Mockup Integration Map

Last updated: 2026-05-06

## Summary

The frontend mockups in `/Users/srikanth/Downloads` are **not imported
as-is**, but they are also no longer just a loose inspiration.

The current `app/web` implementation now contains a **substantial port /
reimplementation** of the mockup surface:

- route / screen naming: **implemented**
- visual system: **mostly ported**
- shared primitives: **mostly ported**
- RFQ screen: **implemented in the live app**
- pool detail / LP portfolio UX: **implemented**
- demo tweak tooling: **intentionally not ported** (per scoping decision)
- live ledger / operator wiring: **mostly complete** (RFQ live,
  remove-liquidity live + LP-burn handoff staged, swap live; remaining
  gap is a real wallet binding for the handoff intents)

The right way to describe the current state is:

- the mockups are **integrated by reimplementation and selective porting**
- the remaining gaps are mostly about **live backend wiring** and a few
  **internal-demo affordances**, not missing product screens

## High-level verdict

### Integrated directly or near-directly

- [RfqPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/RfqPage.tsx)
- [PolicyReceiptModal.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/primitives/PolicyReceiptModal.tsx)
- [toasts.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/primitives/toasts.tsx)
- [PoolDetail.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/components/PoolDetail.tsx)
- [Portfolio.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/components/Portfolio.tsx)
- [index.css](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/index.css)

### Implemented as a port-shaped rework

- [App.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/App.tsx)
- [TradePage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/TradePage.tsx)
- [PoolsPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/PoolsPage.tsx)
- [OrdersPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/OrdersPage.tsx)
- [PortfolioPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/PortfolioPage.tsx)
- [AdminPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/AdminPage.tsx)

### Still missing or partial

- `TweaksPanel` / `useTweaks` style internal demo controls
  (intentionally out of scope)
- a UI test path that runs against a live Canton / token-standard stack
- a concrete wallet binding for the handoff intents (the dApp builds
  them; no production wallet is wired up yet)
- a live event-stream subscription on `RfqPage` (currently react-query
  polls every 10s)

## File-by-file mapping

### `cdex-app.jsx`

Mockup role:

- top-level app shell
- nav with `Trade`, `Pools`, `Orders`, `RFQ`, `Portfolio`, `Admin`
- demo toasts and tweak hooks

Repo equivalent:

- [App.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/App.tsx)
- [Layout.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/components/Layout.tsx)

Status:

- **mostly integrated by reimplementation**

What carried over:

- full route set including `RFQ`
- app shell and page separation
- query-client wiring

What is still missing:

- tweak controls
- the original mock demo-state orchestration layer

### `cdex-trade.jsx`

Repo equivalent:

- [TradePage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/TradePage.tsx)
- [SwapCard.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/components/SwapCard.tsx)
- [SwapCardWired.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/components/SwapCardWired.tsx)

Status:

- **integrated in production-shaped form**

What carried over:

- swap composition
- quote display
- slippage controls
- wallet handoff boundary for trader-authority actions

### `cdex-pools.jsx`

Repo equivalent:

- [PoolsPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/PoolsPage.tsx)
- [PoolCard.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/components/PoolCard.tsx)
- [PoolDetail.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/components/PoolDetail.tsx)

Status:

- **substantially integrated**

What carried over:

- pool list
- pool detail
- add / remove entry points
- LP-oriented reserve and share presentation

What is still missing:

- live completion of the remove-liquidity wallet-handoff path

### `cdex-orders.jsx`

Repo equivalent:

- [OrdersPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/OrdersPage.tsx)
- [OrderBook.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/components/OrderBook.tsx)

Status:

- **substantially integrated**

What carried over:

- order entry
- order-book presentation
- cancel flow

### `cdex-rfq.jsx`

Repo equivalent:

- [RfqPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/RfqPage.tsx)
- [services/rfq-adapter.ts](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/services/rfq-adapter.ts)

Status:

- **fully integrated against the live operator backend**

What carried over:

- RFQ board
- compose flow (`POST /v1/rfq`)
- quote ranking surface
- accept (`POST /v1/rfq/accept`) / cancel (`POST /v1/rfq/:cid/cancel`)
- policy receipt drill-down sourced from the on-ledger receipt the
  `Rfq_Accept` choice produces

What is still missing:

- live event-stream subscription (the page currently uses a 10s
  react-query refetch plus the existing 1Hz local sweeper; an
  event-stream subscription would make state changes instant)

### `cdex-portfolio.jsx`

Repo equivalent:

- [PortfolioPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/PortfolioPage.tsx)
- [Portfolio.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/components/Portfolio.tsx)

Status:

- **substantially integrated**

What carried over:

- holdings
- LP positions
- activity feed
- policy receipt modal integration
- allocation breakdown

### `cdex-admin.jsx`

Repo equivalent:

- [AdminPage.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/pages/AdminPage.tsx)

Status:

- **fully integrated**

What carried over:

- pair listing and pool listing
- create-pair form posting to `/v1/admin/pairs`
- create-pool form posting to `/v1/admin/pools`
- per-pair activate / deactivate via `/v1/admin/pairs/:cid/active`

### `cdex-data.jsx`

Repo equivalent:

- typed contract shapes in
  [contracts.ts](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/types/contracts.ts)
- service-layer access in
  [ledger.ts](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/services/ledger.ts)

Status:

- **replaced rather than ported**

Note:

- static demo data is no longer the main architecture; the app now prefers
  typed service access, with RFQ as the last major page still seeded locally

### `cdex-primitives.jsx`

Repo equivalent:

- [Glyph.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/primitives/Glyph.tsx)
- [StatusBadge.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/primitives/StatusBadge.tsx)
- [PolicyReceiptModal.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/primitives/PolicyReceiptModal.tsx)
- [toasts.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/primitives/toasts.tsx)
- [Modal.tsx](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/primitives/Modal.tsx)

Status:

- **mostly integrated**

### `tweaks-panel.jsx`

Repo equivalent:

- none

Status:

- **not integrated**

### `cdex-bundle.jsx`

Repo equivalent:

- none directly

Status:

- **not integrated as a single-file artifact**

Note:

- its design system and page patterns have been broken apart and reused
  across `app/web`

### `Canton DEX.html`

Repo equivalent:

- [index.css](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/src/index.css)
- [index.html](/Users/srikanth/Downloads/Canton-Dev-Implementations/Canton-Dex/app/web/index.html)

Status:

- **visually ported in large part**

What carried over:

- IBM Plex Sans / IBM Plex Mono stack
- CSS token naming
- card / badge / status-pill treatment
- dark product direction and top-level visual language

## Current app vs mockup

### What is now true

- the mockup screen map is present in the live app
- the RFQ surface is no longer missing
- the visual system is no longer missing
- the shared policy-receipt and toast primitives are no longer missing
- pool detail and richer portfolio views are no longer missing

### What is still not true

- the mockups are not imported literally as source files
- the entire UI is not yet fully live against the operator backend
- the UI is not yet tested end to end on a live Canton / token-standard stack

## Remaining integration checklist

- bind the handoff intents (including `AcceptLpBurnIntent`) to a real
  Canton wallet (Daml Hub or third-party token-standard wallet)
- add UI-level live integration coverage against the Canton-backed operator path
- swap the RfqPage 10s polling for a live ledger event-stream subscription
