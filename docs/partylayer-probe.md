# DEX-91 — PartyLayer execution-capability probe

> Validate PartyLayer against the **exact** DEX wallet requirements before
> wiring it into the main UI (DEX-92/93) or live-testing DvP (DEX-94).
> PartyLayer is a wallet **connector** (CIP-0103), not a wallet and not a
> protocol layer — it cannot fix command shape (that is DEX-90) and cannot
> override a connected wallet's DAR allowlist.

## Questions to answer (from the ticket)

1. Does PartyLayer `prepareExecute` route trader signing **through the wallet**,
   not the operator backend?
2. Does the execute result expose enough transaction data to recover created
   `CantonDex.Registry.V2:Allocation` cids?
3. Can we recover the `LiquidityAllocationAcceptance` evidence cid (DEX-90) from
   the **same** result?
4. How are `pending` / `signed` / `executed` / `failed` / user-rejected states
   surfaced?
5. Which wallet adapters support the required submit/ledger capabilities on
   LocalNet / testnet?

## What the docs answer now (no live run needed)

| # | Finding (from partylayer.xyz docs + code review) | Confidence |
|---|---|---|
| 1 | CIP-0103 `prepareExecute` is documented as "prepare and submit a Daml command"; `txChanged` exposes `pending → signed → executed/failed`, i.e. wallet-mediated execution, **not** an operator relay. Consistent with "writes go through the wallet." | High (doc) |
| 1 | A generic `ledgerApi()` pass-through (POST `/v2/commands/submit-and-wait` with an arbitrary `ExerciseCommand`) exists — so PartyLayer is **not** allowlist-locked the way Loop is. It can carry our `AllocationRequest_Accept` + `AllocationFactory_Allocate` trees. | High (doc) |
| 2/3 | **Unknown from docs** — the docs do not specify whether the execute result returns the transaction tree / created events / cids, or only a status + `updateId`. **This is the load-bearing question and requires a live run.** | — |
| 4 | Lifecycle states named (`pending/signed/executed/failed`); user-rejected mapping unconfirmed. | Med (doc) |
| 5 | Connectors listed: Console, Loop, Cantor8, Nightly, Send. **Splice/Amulet (our LocalNet target) coverage unconfirmed.** Loop is known to refuse third-party DARs (see `Plan F`), so Loop is out for our DAR regardless of PartyLayer. | Med (doc) |

## The one decisive question → and why it is NOT a hard blocker

**Q2/Q3 — does the execute result expose created `Allocation` (and the
`LiquidityAllocationAcceptance`) cids?** Two outcomes, both already supported by
the DEX-90 design:

- **Result exposes created events** → `PartyLayerProvider.submit()` parses them
  into `WalletResult.createdAllocationCids` (filter `Registry.V2:Allocation`) and
  `auxiliaryCids.liquidityAcceptanceCid` (filter
  `LiquidityAllocationRequest:LiquidityAllocationAcceptance`) — exactly what the
  existing `extractCreatedAllocationCids` / `extractLiquidityAcceptanceCid`
  helpers do for the other providers. Clean.
- **Result exposes only an `updateId`/status** → fall back to **operator-side
  discovery**: the operator reads the transaction tree (`updateId →
  /v2/updates/transaction-tree-by-id`, already implemented in
  `services/operator-backend/src/ledger/json-api.ts`) **or** discovers the
  `LiquidityAllocationAcceptance` by its stable correlation key (`lp` +
  `settlement.id`, which DEX-90's evidence carries) and binds `/settle` to that.
  This is *more* aligned with "reads/settle via operator" and removes the dApp's
  dependence on the wallet result shape.

**So "created cids not in the wallet result" is not a no-go for DvP** — it only
decides *where* cid recovery happens (dApp-return vs operator-discovery). A true
no-go would require BOTH: the result exposes nothing usable AND the operator
cannot correlate the acceptance/allocations on-ledger (it can, via the
settlement id). Record the actual outcome below.

## Spike procedure (live — run on LocalNet from the TSv2 branch)

Prereqs: Splice LocalNet up on `token-standard-v2-upcoming` with the Amulet
wallet, our `canton-dex-trading` DAR uploaded, a seeded pool + funded trader
(reuse `scripts/localnet-dvp-e2e.ts` for setup).

1. Add `@partylayer/react` + mount `PartyLayerKit` + `ConnectButton` on a throwaway
   spike route (do **not** touch the main wallet registry yet).
2. Connect; capture `party_id` / account from the provider.
3. Submit a **harmless** command first (e.g. a `Holding_Split` exercise the trader
   is authorized for) via `prepareExecute` / `ledgerApi`. Log the **raw** result
   object verbatim.
4. Submit a real **`add-liquidity`** batch (`AllocationRequest_Accept` + 3×
   `AllocationFactory_Allocate`) the operator `/request` produced. Log the raw
   result.
5. Record, against the questions above:
   - exact result field names (tree? `createdEvents[]`? `updateId` only?);
   - whether `Registry.V2:Allocation` cids and the `LiquidityAllocationAcceptance`
     cid are present;
   - the `txChanged` state sequence, including a user **reject**;
   - whether signing happened in the wallet (no operator `actAs: [trader]`).
6. Repeat connect-only against each available adapter (Console, Nightly, Send,
   Cantor8) to fill the capability matrix; note which sign our third-party DAR.

## Capability matrix (fill from the live run)

| Adapter | Connects | Signs 3rd-party DAR cmd | Result exposes created cids | Lifecycle states clean | DvP-ready |
|---|---|---|---|---|---|
| Amulet / Splice (LocalNet) | ? | ? | ? | ? | ? |
| Console | ? | ? | ? | ? | ? |
| Nightly | ? | ? | ? | ? | ? |
| Send | ? | ? | ? | ? | ? |
| Cantor8 | ? | ? | ? | ? | ? |
| Loop | n/a | **No** (utility-* allowlist, see Plan F) | n/a | n/a | **No** |

## Go / no-go (decide after the run)

- **GO (dApp-return cids):** result exposes created events → implement
  `PartyLayerProvider` parsing them; DEX-92 proceeds as-is.
- **GO (operator-discovery):** result is status-only → implement
  `PartyLayerProvider` returning the `updateId`; add the operator-side acceptance/
  allocation discovery in `/settle` (keyed on `settlement.id`). DEX-92 + a small
  backend discovery helper.
- **NO-GO (only if):** the chosen wallet won't sign our DAR command at all (then
  it's a wallet-allowlist problem, not a PartyLayer problem — pick a different
  adapter; Amulet on LocalNet is the reference target).

## Live-run results (to be filled in)

> _Pending the LocalNet run. Paste the raw result objects from steps 3–4 and the
> filled capability matrix here, then set the go/no-go above._
