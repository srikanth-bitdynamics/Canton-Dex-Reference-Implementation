# Wallet-flow conformance gap: LP DvP vs. the canonical `AllocationRequest_Accept` path

> **Trigger.** Splice PR #5697 ("Support iterated settlement in Splice Amulet
> Wallet"), merged into `token-standard-v2-upcoming` on 2026-06-02, makes the
> Amulet wallet's **`AllocationRequest_Accept`** flow iterated-settlement-aware
> (a checkbox + amount field to set next-iteration funding at accept time). The
> Amulet wallet ships on every LocalNet validator. So the practical question is:
> **which of our flows can a real Amulet wallet actually drive end-to-end on
> LocalNet?** This note answers that, anchored to
> `vendor/splice/.../AllocationRequestV2.daml` and our own source.

## TL;DR

| Flow | dApp intent | Drives `AllocationRequest_Accept`? | Amulet can drive it on LocalNet? |
|---|---|---|---|
| OTC / order settlement | `accept-allocation-request` | **Yes** (`commands.ts` calls `AllocationRequest_Accept` + `AllocationFactory_Allocate`) | **Yes** |
| LP add liquidity | `add-liquidity` → `composeAddLiquidity` | **No** — dApp composes `AllocationFactory_Allocate` directly | **No** (structurally blocked — see below) |
| LP remove liquidity | `remove-liquidity` → `composeRemoveLiquidity` | **No** — same | **No** |
| Swap | `request-swap` / `PoolRules_RequestSwap` | *verify* | *verify* |

The LP DvP flow is **structurally incompatible** with the stock-wallet accept
path — and our own code says so on purpose.

## The structural block (our code is explicit about it)

`trading/CantonDex/Dex/LiquidityAllocationRequest.daml`:

```daml
-- `AllocationRequest_Accept` is standard V2 behavior, but the main
-- liquidity flow reads the view and creates allocations directly.
-- If accept is called first the later settle fails to fetch the
-- request, which is a deliberate fail-safe.
allocationRequest_acceptImpl = \self _arg -> do
  archive self                                   -- <-- archives the request
  pure V2.AllocationRequest_AcceptResult with meta = emptyMetadata
```

Two problems for a stock Amulet wallet, which discovers any `AllocationRequest`
(we implement the interface; `availableActions = [(ARA_Accept,[[lp]]), …]`) and
on user approval calls `AllocationRequest_Accept`:

1. **Accept archives the request.** Our `/settle` (`LpDvpRules_Settle*`) binds to
   the **live** `LiquidityAllocationRequest` by `requestCid` (the DEX-54
   request-bound validation). Amulet calling accept archives it first → settle
   can no longer `fetch` it → **the LP flow breaks.** Our comment calls this a
   "deliberate fail-safe," i.e. the design *assumes the wallet never calls accept*.

2. **Accept does not author the allocations.** The standard says the wallet, on
   accept, creates the allocations described in `view.allocations`
   (`AllocationRequestV2.daml:130`: *"The allocations that are requested to be
   authorized … as part of the settlement"*). Our `acceptImpl` does **not** create
   them — it only archives + returns empty meta. Our allocation authoring lives in
   the **dApp** (`composeAddLiquidity`/`composeRemoveLiquidity` emit one
   `AllocationFactory_Allocate` per spec via our provider), not in the wallet.

So our LP DvP flow only works with **our** provider, which (a) skips accept and
(b) composes the `Allocate` commands itself, then hands the created cids back to
`/settle`. A real Amulet wallet does the opposite on both counts.

## Why the OTC path is fine and LP isn't

`composeAcceptAllocationRequest` (the OTC/order path) **does** call
`AllocationRequest_Accept` (nonconsuming in the interface) alongside the
`Allocate`, so it matches the wallet's accept-driven model. The LP builders never
emit an `AllocationRequest_Accept` at all — they jump straight to `Allocate`. That
asymmetry is the gap.

## What #5697 adds on top

`AllocationRequestView.settleAt` is documented as *"For iterated settlements, this
is the expected time of the first iteration."* #5697 gives the wallet UI to set
`nextIterationFunding` at accept time. Our pool roll-forward sets
`nextIterationFunding` **operator-side** at settle (DEX-74), which is correct for
the operator-authored pool slices. But it underlines the direction: **the wallet
is the driver of accept + funding configuration.** Our LP flow routes around the
exact surface #5697 is enriching.

## Impact

- **We cannot exercise LP add/remove with a real Amulet wallet on LocalNet.**
  Only the custom token-standard/SDK provider can drive it. Any "test all flows on
  Amulet" plan covers OTC settlement but silently skips LP DvP.
- This is the same tension as the earlier DEX-54 review finding ("accept archives
  the request before settle can bind"). We resolved it by **bypassing accept**.
  #5697 confirms accept *is* the canonical, wallet-native path — so the bypass is
  the divergence, not a fix.
- Not a correctness bug in isolation: our flow is tested green with our provider.
  It's an **interoperability + reference-fidelity** gap — a TSv2 reference DEX
  should be drivable by the reference wallet.

## Target model: DEX-first, wallet-approved (Model 2)

Chosen UX: the user stays in our DEX UI; the **dApp** composes the exact Token
Standard V2 command tree from operator-computed specs; the wallet only **approves
and signs** it. The user never touches the wallet's low-level allocation-builder
screen. This is CIP-0103 `prepareExecute` — *not* wallet-side request discovery
(which would push the user into the Amulet allocation page). #5697's manual
iterated-funding UI is part of that low-level surface and is **not** used — pool
roll-forward sets `nextIterationFunding` operator-side (DEX-74).

## Spec constraint that shapes the fix

`AllocationRequest_Accept` is declared `nonconsuming`, but the interface doc is
explicit: *"implementations MUST ensure that the allocation request is consumed by
the body of this choice."* So `acceptImpl` archiving the request is **required**,
not a bug. The bug is that our `/settle` binds to the (now mandatorily-consumed)
request. The canonical `OTCTrade_Settle` never binds settlement to the request —
it binds to the venue/trade contract + allocation cids and archives leftover
requests only as cleanup. DEX-54 made the request the settlement anchor; that's
what collides with the stock-wallet accept path.

## What alignment requires (acceptance-evidence design — for the scoping ticket)

1. **LP composer emits the canonical pair**: `AllocationRequest_Accept` +
   `AllocationFactory_Allocate` × specs (mirror `composeAcceptAllocationRequest`).
   Today the LP composer emits allocate-**only**.
2. **`acceptImpl` consumes/archives the request** (spec-mandated) — keep it.
3. **Before archiving, create operator-visible acceptance evidence**: a new
   `LpAllocationAcceptance { signatory operator; observer lp }` (authority is
   available in the accept body: request signatory `operator` + controller `lp`).
   It carries `settlement`, the expected specs (or their hash), the `settleAt`
   deadline, the accepting party — and, if the wallet result surfaces them, the
   created `Allocation` cids. This is the durable anchor that survives accept.
4. **`/settle` dual-binds**: validate against the **live request** (legacy
   direct-allocation flow that never calls accept) OR the **acceptance evidence**
   (stock-wallet flow where accept consumed the request). Deadline + spec
   validation move to the evidence in the stock-wallet path; DEX-54's
   ledger-anchored-deadline guarantee is preserved via the evidence.
5. **Created-allocation cids for settle**: with the Model-2 composed batch
   (`accept` + `allocate×N` in one tx), evidence and allocations materialize
   together. Source the cids from the wallet result if it exposes created events,
   else operator-discover (`updateId → transaction-tree-by-id`, already built in
   `json-api.ts`). This is the live probe to run against any CIP-0103 wallet
   (Amulet, or a PartyLayer-connected wallet).
6. Keep the OTC path as the working template — it already emits accept + allocate.

## Connector note (PartyLayer)

PartyLayer is a wallet-connector SDK (CIP-0103 `prepareExecute` / `ledgerApi`),
not a wallet and not a protocol layer. It now sits behind our `WalletProvider`
interface as a real SDK-backed `PartyLayerProvider`, lazily loading
`@partylayer/sdk` and trying installed submit-capable wallets (Console, Nightly,
Send by default; override with `VITE_PARTYLAYER_WALLET_IDS`). It does **not**
abstract registry factory-cid / choice-context fetching (stays app-side), and
cannot override a wallet's DAR allowlist (Loop still refuses third-party DARs;
Amulet/Console on LocalNet is the realistic hosted-E2E target). PartyLayer is the
wallet transport; DvP depends on the lower acceptance-evidence and
operator-discovery changes, and is not fully proven until a real wallet signs and
returns an `updateId` the operator can discover.

## Open items to verify before scoping

- **Swap path** (`PoolRules_RequestSwap`): does it route through an
  `AllocationRequest` the wallet accepts, or a direct dApp-composed allocate? Same
  question as LP.
- **Will Amulet sign a raw dApp-composed `AllocationFactory_Allocate`** handed via
  CIP-0103 `prepareExecute` at all (bypassing its request UX)? If yes, LP is
  *submittable* but not *request-legible* and loses the #5697 iterated UX; if no,
  LP is fully blocked. Needs a LocalNet probe.
- Whether `OTCTradeAllocationRequest`'s `acceptImpl` creates allocations (the
  template to mirror) vs. relies on the dApp like LP does.

## Source references

- `vendor/splice/token-standard/splice-api-token-allocation-request-v2/daml/Splice/Api/Token/AllocationRequestV2.daml`
  — `AllocationRequest_Accept` (nonconsuming, `:37`), `view.allocations` (`:130`),
  `settleAt` iterated-settlement note (`:138`).
- `trading/CantonDex/Dex/LiquidityAllocationRequest.daml` — `acceptImpl` archives
  (the fail-safe).
- `app/web/src/wallet/commands.ts` — `composeAcceptAllocationRequest` (calls
  accept) vs. `composeAddLiquidity`/`composeRemoveLiquidity` (skip accept).
- Splice PR #5697 — iterated-settlement UI for the Amulet wallet accept flow.
