# DEX-91 PartyLayer probe spike

A throwaway Vite app that completes the DEX-91 live probe: connect a Canton
wallet via PartyLayer, submit a DEX command tree, and recover the created
`Allocation` + `LiquidityAllocationAcceptance` cids by `updateId`. **Isolated
from `app/web`** — its own `package.json`, never part of the app build.

> Everything resolvable from source is already in `docs/partylayer-probe.md`
> (GO for DvP via operator-discovery). This spike confirms the **last live
> items**: which adapter signs our `canton-dex-trading` command, the exact
> `submitTransaction` param shape, and the recover-by-`updateId` round-trip.

## What you need (human-gated — inherent to any wallet probe)

- A target network PartyLayer supports: **devnet**, testnet, or mainnet
  (PartyLayer has **no `localnet`** mode — for LocalNet you'd pass a
  `registryUrl` override and likely the `adapter-starter` template).
- A real Canton wallet to approve in (Console / Nightly / Send / Cantor8),
  funded on that network, with our `canton-dex-trading` DAR reachable.
- The operator backend running (for the `/request` payload in step 2).

## Run

```bash
cd spike/partylayer
npm install                 # pulls @partylayer/* (blocked in the agent sandbox; runs fine locally)
# optional env:
#   VITE_PL_NETWORK=devnet
#   VITE_API_BASE=http://localhost:8080
#   VITE_PROBE_HOLDING_CID=<a Holding cid the connected party owns>
npm run dev                 # http://localhost:5191
```

## Procedure (record each raw result)

1. **Connect** — click ConnectButton, pick an adapter, approve in the wallet.
   Note the `partyId`. Repeat per adapter to fill the matrix.
2. **Submit harmless** (button 1) — exercises `Holding_Split` on
   `VITE_PROBE_HOLDING_CID`. **Record the raw receipt** — confirm it is
   `updateId`-only (the DEX-91 prediction). If the wallet rejects the param
   shape, record the error (that resolves live item #3: `SubmitTransactionParams`).
3. **Submit add-liquidity** (button 2) — paste the operator's
   `POST /v1/pools/add-liquidity/request` JSON into the textarea (add
   `probeBaseHoldingCids` / `probeQuoteHoldingCids` arrays for the deposit
   legs). Builds the canonical `AllocationRequest_Accept` + 3×
   `AllocationFactory_Allocate` and submits. **Record the receipt.**
4. **Recover by updateId** (button 3) — calls `ledgerApi` GET
   `/v2/updates/transaction-tree-by-id/{updateId}` and classifies created
   events. **Confirm** the 3 `Registry.V2:Allocation` cids and the
   `LiquidityAllocationAcceptance` cid come back — this proves the
   operator-discovery recovery the DEX-92 provider relies on.

## Then

- Paste the raw receipts + the filled capability matrix into
  `docs/partylayer-probe.md` ("Live-run results" / "Capability matrix").
- If step 4 succeeds, **DEX-94** (live DvP) is unblocked: the backend already
  does this recovery server-side (`json-api.ts` tree walk + `discoverAcceptance`).
- Wire the real client into `app/web` (DEX-92 sub-step 1): implement the
  `PartyLayerClient` seam in `registry.ts` with `createPartyLayer(...)`.

## Caveat

Written against the API read from the published `@partylayer/*` type
declarations; **not compile-verified in the agent sandbox** (the `@partylayer`
install is blocked there). `npm install` locally resolves the types; the one
genuinely-uncertain spot (the `submitTransaction` param wrapping) is marked in
`src/Spike.tsx` and is itself a probe outcome to record.
