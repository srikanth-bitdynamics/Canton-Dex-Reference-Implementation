# End-to-End Demo Plan

## Goal

Record a single walkthrough that explains the reference DEX in
terms of real user roles and real ledger-backed state, rather than
isolated unit tests.

The demo should answer:

- how a trader connects and uses the app
- how the operator/admin configures the venue
- how RFQ / matched-trade settlement works
- how the pool / LP surface works
- how the prefunded-order surface works
- what is currently UI-native, wallet-native, or CLI-proof-only

## Stack (verified base, 2026-05-24)

Splice Canton LocalNet + splice-wallet-kernel + our dApp + operator
backend. Same Canton version external builders get from
`splice@token-standard-v2-upcoming`.

| Component | Port | Purpose |
|---|---|---|
| Canton 3.5.1-snapshot.20260423.18760 | `:5003` | JSON Ledger API |
| splice-wallet-kernel gateway | `:3030` | CIP-0103 dApp Standard |
| mock-oauth2 IDP | `:8889` | OAuth client-credentials |
| operator-backend (this repo) | `:8090` | indexer + reads + relay |
| dApp preview (this repo, `VITE_ENABLE_SDK=1`) | `:8081` | Vite-built UI |

Daml package: `canton-dex-trading 0.1.0` →
`9e7bcabde7293eedf6e667261e2b528d1a09f2b2a2ebfb34fac4f25641f1d9c7`

Vendored Splice packages (8 DARs) under `vendor/splice/token-standard/`.

Bring-up: see `docs/demo-walkthrough.md` Prerequisites section.
Sanity-check: `bash scripts/demo-preflight.sh` must end "Demo-ready".

## Personas + parties

| Persona | Party id (`::1220d44f…c61424`) | Role |
|---|---|---|
| Admin / Operator | `dexOperator`, `dexLpRegistrar`, `dexAdmin` | venue / LP registrar / instrument issuer |
| Trader Alice | `alice` | RFQ initiator, order placer, swap taker |
| LP Bob | `bob` (or a dedicated `lpBob` party) | adds/removes liquidity |
| Dealer Jump / Orca | new party (`jump`) | RFQ quote-side counterparty |

The Admin/Operator persona is split across three Daml parties
(operator + lpRegistrar + admin) because the Daml templates use
different controllers per concern. From the demo audience's
perspective these can be presented as a single "venue operator"
role. Internally they enforce the trust-boundary separation that
the M1/M2 docs describe.

If a party doesn't exist yet, run:

```bash
TOK=$(cat /tmp/ln-token.txt)
SUF="::1220d44fc1c3ba0b5bdf7b956ee71bc94ebe2d23258dc268fdf0824fbaeff2c61424"
for HINT in lpBob jump; do
  curl -sS -X POST http://localhost:5003/v2/parties \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"partyIdHint\":\"$HINT\",\"identityProviderId\":\"\"}"
  curl -sS -X POST "http://localhost:5003/v2/users/participant_admin/rights" \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d "{\"userId\":\"participant_admin\",\"rights\":[{\"kind\":{\"CanActAs\":{\"value\":{\"party\":\"$HINT$SUF\"}}}}]}"
done
```

## Surfaces

Three kinds of evidence, used together:

- **UI** — the dApp at `http://localhost:8081`, reading live state
  from the operator-backend's Canton indexer.
- **CLI** — harness scripts hitting the JSON LAPI directly:
  - `scripts/testnet-v2registry-trade.ts` — matched-trade
    settlement (M1)
  - `scripts/localnet-pool-demo.ts` — pool init + add LP (M2)
  - `npx vitest run` in `app/web/src/__tests__/commands.test.ts`
    — 9 snapshot tests pinning every wallet intent's Daml command tree
  - `cd trading-tests && daml test` — 31 in-script tests (M1 + M2
    + some M3)
- **Wallet** — splice-wallet-kernel gateway as the CIP-0103
  transport. Connect-side validated through the dApp's "Canton
  wallet (CIP-0103)" provider option. Write-side via
  `prepareSignExecute` is pending a real Amulet wallet on the
  `token-standard-v2-upcoming` branch (see Wallet Reality Check
  below).

## Recording plan

Real screen capture with `ffmpeg`, not stitched screenshots.

```bash
# Full-screen 90s recording at 15fps, H.264 ultrafast:
ffmpeg -nostdin -hide_banner -y \
  -f avfoundation -framerate 15 -capture_cursor 1 -i "4:none" \
  -t 90 -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  ~/Desktop/canton-dex-demo.mp4
```

Replace `4` with the actual screen device index from
`ffmpeg -f avfoundation -list_devices true -i ""`.

Practical recording options:

- **ffmpeg** — primary path. Works on macOS once Screen Recording
  permission is granted to the terminal app that launches it.
- **macOS screen recording** (`Cmd-Shift-5` / QuickTime) — manual
  fallback if you want narration audio.
- **Playwright/Puppeteer screenshots** — proof aid only, not the
  primary demo medium.

Don't build the demo from JPEG sequences. The goal is a real
product walkthrough, not a slide deck.

### Window layout

- **Left** — trader browser window pointed at
  `http://localhost:8081/`. Connect Alice here.
- **Right** — operator/admin browser window or a second tab. Used
  for venue setup and watching the pool reserves move.
- **Bottom or secondary window** — terminal showing the
  `scripts/run-localnet-milestone-proofs.sh` (or the per-segment
  harness) output as proof of on-chain state changes.

For dealer-side RFQ quoting and LP Bob's liquidity operations,
switch profiles or windows between segments. Trying to show four
parties simultaneously is more confusing than helpful.

## Sequence

### 1. Intro + Connect (≈2 min)

Show:

- dApp header: `Canton DEX v0.6 · canton:localnet`, slot counter,
  Connect Wallet button.
- Operator backend context — `curl http://localhost:8090/v1/context`
  in the terminal. Names the operator / lpRegistrar / admin parties.
- Trader connects via **Canton wallet (CIP-0103)** in the Connect
  Wallet menu. Header changes to `operat…1424 / operator` (the
  gateway-default party).
- Explain that the wallet authorizes trader-side actions while
  the operator backend handles operator-side actions and read
  queries.

Feature coverage:

- wallet connection state
- connected trader party
- network / backend status
- wallet-native vs dApp-native action boundary

Honest caveat for the voice-over: the gateway's default OAuth
identity logs in as the operator party (config-driven). For a true
trader persona, the demo should re-OAuth as a different identity —
or rely on CLI proof for the trader-authority writes.

### 2. Venue Setup (≈3 min)

Show as Admin / Operator:

- A pair is already seeded (BTC/USDC) — show it via
  `curl http://localhost:8090/v1/pairs`. If reseeding for the demo,
  use the curl payload from `docs/demo-walkthrough.md` §4.1.
- A pool shell is already seeded in PS_Unfunded — show it via
  `curl http://localhost:8090/v1/pools`.
- Explain `InstrumentId` pair support — BTC/USDC for this demo,
  but the pair template accepts arbitrary instrument ids.
- The pair + pool render on the dApp Pools page.

Feature coverage:

- pair listing
- pool creation
- admin/operator workflow boundary

### 3. RFQ / MatchedTrade Flow (≈5 min)

Two paths to choose between:

**Path A (preferred when the wallet write-side works):**

- Alice creates an RFQ from the dApp's RFQ page.
- Dealer Jump quotes it (separate window or party).
- Alice or operator accepts the quote.
- Resulting `PolicyReceipt` and `MatchedTrade` appear in the dApp.
- Settlement proof in the terminal.
- Portfolio / trade-history view updates.

**Path B (current default — CLI proof for the trader-authority
write, dApp for state visualization):**

- Run `npx tsx scripts/testnet-v2registry-trade.ts` in the
  terminal. 8 green steps end-to-end on real Canton:
  Registry → InstrumentConfig BTC → mint to alice → MatchedTrade
  → RequestAllocations → alice + bob accept + allocate →
  SettlementFactory_SettleBatch.
- 10 BTC moves alice → bob on the live ledger.
- Open the dApp Portfolio page (when the
  `Cannot read properties of undefined (reading 'slice')` bug
  is fixed) to see the holdings change.

Feature coverage:

- trader RFQ creation (Path A) or programmatic trade construction
  (Path B)
- dealer quote competition
- policy ranking / `PolicyReceipt`
- `MatchedTrade`
- OTC settlement baseline (V2 SettlementFactory_SettleBatch)

Primary proof sources:

- `scripts/testnet-v2registry-trade.ts` — full V2 surface
- in-script tests: `testRfqAcceptProducesMatchedTradeWithReceipt`,
  `testMatchedTradeFullSettle`, `testMatchedTradeViaTokenStandardRegistry`

### 4. Pool / LP Flow (≈5 min)

Show:

- Pool exists with real reserves (initially PS_Unfunded, $0 TVL
  in the UI).
- In terminal: `npx tsx scripts/localnet-pool-demo.ts` —
  initializes pool, then adds liquidity. 7 green steps.
- dApp refreshes: BTC/USDC card transitions
  `Unfunded $0 → Active $90.0K TVL (1.5 BTC / 45,000 USDC)`,
  Active Pools count grows.
- Pool now has 2 committed allocation slices per side —
  the "iterated allocations" pattern from the M2 description.

Single-hop swap and remove-liquidity:

- Live-LAPI swap + remove harnesses are deferred (need an
  allocation-flow swapper). For the demo, reference the in-script
  tests which exercise the same Daml templates against the same
  Canton 3.5.1 → 8.3 release surface.

Feature coverage:

- constant-product AMM (`Pool.daml` reserve math)
- LP mint / burn (`LPMintRequest`, `LPBurnRequest` via the LP
  registrar)
- committed / iterated allocation-backed pool funds (visible as
  the slice count grows)
- swap execution (in-script)
- portfolio / pool-state updates

Primary proof sources:

- `scripts/localnet-pool-demo.ts` — live Pool_Initialize +
  Pool_AddLiquidity on Canton 3.5.1
- in-script tests: `testPoolFullLifecycle`, `testPoolSwapEndToEnd`,
  `testPoolRemoveLiquidityConsolidates`,
  `testPoolRemoveLiquiditySliceLocal`

### 5. Prefunded Order Flow (≈3 min)

- Trader creates an order intent. Today this means
  `composeCommands({ kind: 'place-order', ... })` →
  `OrderFundingRequest` create — see the snapshot in
  `app/web/src/__tests__/commands.test.ts:56`.
- Order is bound and funded by the operator-side `OrderBinding`
  flow.
- Order appears in the dApp's Orders page (when the
  trader-authority write path through CIP-0103 is wired; today the
  UI path goes through the legacy operator-relay provider).
- Explain where partial-fill + cancel sit: choices exist on the
  order template; UI controls are not yet wired.

Feature coverage:

- prefunded order creation
- order funding / binding
- order visibility in UI
- explanation of partial-fill / cancel boundary

Primary proof source: in-script `testOrderFundingFlow`.

## Wallet Reality Check

The ideal recording uses a real WalletConnect / CIP-0103 capable
Canton wallet for at least the trader persona.

**Current state on this stack:**

- `real ledger-backed UI data` — **yes**. Pools / Pairs / Portfolio
  read live from Canton 3.5.1 via the operator-backend indexer.
- `real operator/backend flows` — **yes**. Operator-backend writes
  trader-relay submissions via the JSON LAPI; venue admin flows
  fully exercised.
- `real localnet Daml / JSON API proof` — **yes**. 31 in-script
  tests + 3 stable-pool tests pass against `canton-dex-trading
  0.1.0`. Live-LAPI matched-trade + pool init/add harnesses both
  green on Canton 3.5.1 today.
- `real CIP-0103 wallet connect on localnet` — **yes**. Via the
  splice-wallet-kernel gateway on `:3030`. dApp's "Canton wallet
  (CIP-0103)" Connect Wallet option succeeds; header reflects the
  wallet's party. Verified 2026-05-23.
- `real CIP-0103 wallet sign+execute on localnet` — **pending**.
  The connect side of the SDK provider works; the
  `prepareSignExecute` write path needs an Amulet wallet build
  paired against the gateway. That is the next gate in Plan E
  Phase 3.

For the demo:

- Keep the UI on real data (it is — operator backend is talking
  to real Canton 3.5.1).
- Use CLI proof for trader-authority flows that don't yet have a
  live local wallet write surface (matched-trade and pool init
  flows above are both CLI-driven).
- Do not imply the legacy "Token Standard V2 (recommended)"
  provider in the Connect Wallet menu is a production or testnet
  wallet — it relays through the operator's session and is the
  trust-boundary violation Plan E exists to delete.

## Submission Assets

Prepare three deliverables:

1. A recorded UI walkthrough (~90s minimum; can be longer with
   narration).
2. The localnet proof logs — capture `docs/demo-recording/` for
   ad-hoc runs, or build out
   `artifacts/localnet-runs/<run-stamp>/` if a more durable
   structure is wanted.
3. A short run-note tying each demo segment to the corresponding
   proof artifact. The mapping is already in this doc's
   Sequence section.

## Current Verified Base

As of 2026-05-24, the local proof base for the demo is:

- `bash scripts/demo-preflight.sh` ends "Demo-ready" against the
  Splice Canton 3.5.1 + gateway + operator-backend stack.
- `scripts/testnet-v2registry-trade.ts` — 8/8 green; matched-trade
  with 10 BTC moved alice → bob through the full V2 surface.
- `scripts/localnet-pool-demo.ts` — 7/7 green; Pool_Initialize +
  Pool_AddLiquidity, pool transitions PS_Unfunded → PS_Active
  with 2 committed allocation slices per side.
- `cd trading-tests && daml test` — 31 in-script tests pass.
- `cd examples/stable-pool && daml test` — 3 reuse-proof tests
  pass.
- `cd app/web && npx vitest run` — 9 commands snapshot tests pass.
- `cd app/web && npm run build` — clean build with
  `VITE_ENABLE_SDK=1`.
- dApp connect via Canton wallet (CIP-0103) succeeds end-to-end
  through splice-wallet-kernel.

That means the remaining work for a polished demo is presentation
and environment bring-up, **not** core workflow proof.

## Known UX gaps that affect the recording

- **Trade page + Portfolio page crash** with
  `Cannot read properties of undefined (reading 'slice')` when a
  PS_Active pool exists and a wallet is connected. Affects
  segments 3, 4, and 5. Workaround for the recording: stay on the
  Pools page, narrate the Trade / Portfolio behaviour with CLI
  output. Spawned task in the session backlog.
- **Pools page hook-order error #310** with 4+ pools — fixed in
  `daf6450` (`web/PoolsPage: hoist useAssetPricesUsd above
  conditional early returns`). Make sure the dApp is built off
  `srikanth/dapp-sdk-migration` or `main` after that commit.
- **Wallet session drops on page reload** — the CIP-0103 SDK
  session does not persist a hard reload. Acceptable for the
  recording; just don't F5 mid-demo unless you also re-connect
  the wallet.

## Demo-run artefacts

`docs/demo-recording/` holds the most recent run output:

- `demo-run-report.md` — narrative of a full run with on-chain
  evidence (CIDs, tx offsets, harness output).
- `harness-matched-trade.log` — `testnet-v2registry-trade.ts`
  output.
- `harness-pool-lifecycle.log` — `localnet-pool-demo.ts` output.

The recording itself goes to `~/Desktop/canton-dex-demo*.mp4`
during a session and can be moved into `artifacts/` if the team
wants it tracked alongside the proof logs.
