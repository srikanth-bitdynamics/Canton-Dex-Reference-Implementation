# Testing

This reference proves itself in layers. The Daml core is exercised by
in-script suites that run on an in-memory ledger with no Canton process; the
operator backend and dApp have their own offline suites; a backend-process
smoke checks selected HTTP routes; and opt-in probes exercise narrower seams
against a live Canton participant.

The word **end-to-end** is reserved here for a path whose stated boundaries are
actually present. None of the automated paths currently includes all of a
browser, real wallet transport, authenticated operator HTTP server, and live
Canton participant. The [Validator Test Plan](../guides/validator-test-plan.md)
is the manual deployment sign-off for those combined boundaries.

| Path | Boundaries present | What it proves | What it does **not** prove | Command |
|---|---|---|---|---|
| Daml in-script suites | Daml Script engine | choice logic, conservation, authorization, rounding | Canton process, JSON API, backend, browser, wallet | `bash scripts/run-local-daml-tests.sh` |
| Backend suite | backend services/routes + `InMemoryLedger` | HTTP shapes, matching, projection, idempotency, auth | real Daml authorization or participant wire compatibility | `(cd services/operator-backend && npm test)` |
| dApp suite | React/jsdom + mocked fetch/providers | wallet-intent composition, funding planners, UI state | real browser wallet, backend, Canton | `(cd app/web && npm test)` |
| Backend HTTP smoke | backend process + curl + `InMemoryLedger` | selected reads/quote routes and one admin 401 | dApp, successful writes, wallet, Canton, every API endpoint | `bash scripts/backend-http-smoke.sh` |
| Live RFQ service integration | backend service + shared `JsonApiLedger` + Canton | RFQ create/quote/accept/list/cancel and receipt agreement | HTTP server, token settlement, registry factories, browser, wallet | `CANTON_LIVE_RFQ=1 npm run test:live:rfq` from `services/operator-backend` |
| Self-contained live AMM round trip | raw JSON API + Canton | Registry.V2 setup; add → quote-bound swap → partial remove; exact balance/reserve/slice/LP/invariant/conservation checks | backend HTTP, dApp, browser auth, real wallet transport | `npm run live:roundtrip` from `services/operator-backend` |
| Existing-pool add/swap probe | raw JSON API + Canton | mint → add → swap on an existing pool; exact reserve/balance/invariant checks | backend HTTP, dApp, wallet transport, remove | `npm run testnet:seed-pool` from `services/operator-backend` |
| Matched-trade settlement probe | raw JSON API + Canton | V2 allocations and `MatchedTrade_Settle` move one instrument | AMM, RFQ acceptance, backend HTTP, dApp, wallet | `npm run live:matched-trade` from `services/operator-backend` |

The first four rows run without an external participant; the first three are CI
gates, while the backend HTTP smoke is a manual pre-flight. CI also type-checks
the live driver sources, but does not connect to a participant. Every live row
is opt-in and changes ledger state.

## Daml in-script suites (`trading-tests/`)

These are Daml Script tests: each is a `Script ()` that allocates parties,
submits commands, and asserts on the resulting contracts, all on the script
runner's in-memory ledger. No Canton, no JSON API, no backend — just the Daml
engine enforcing the same authorization and consumption rules it enforces in
production. Run them with:

```bash
bash scripts/run-local-daml-tests.sh
```

which builds the `canton-dex-trading-v2` DAR against the committed Token Standard
DARs (`scripts/build-trading-surface.sh`) and then runs the core suite. By hand:

```bash
(cd trading       && dpm build)   # -> trading/.daml/dist/canton-dex-trading-v2-1.0.0.dar
(cd trading-tests && dpm test)    # every script reports "ok"
```

### The registry-fixture ladder

Most of the suites differ not in the workflow they drive but in the *registry*
they drive it against, and that choice is load-bearing. A settlement bug can
hide behind a registry that doesn't hold real value, so the suites climb a
ladder from cheap-but-blind to slow-but-honest:

| Fixture | Holds real holdings? | Good for | Used by |
|---|---|---|---|
| `MockRegistry` | no (empty `inputHoldingCids`) | choice plumbing, multi-party authority | `PoolWorkflowTests`, `OrderWorkflowTests`, `TradeWorkflowTests`, `ChoiceContextWorkflowTests` |
| `DexRegistry` over `MockRegistry` | no | the `RegistryApi` interface handshake | `TokenStandardHarnessTests` |
| `CantonDex.Registry.V2` | yes (locks, credits, mint/burn accounts) | settlement, conservation, DvP | `PoolLiquidityRulesTests`, `RegistryConservationTests`, `RfqSettlementTests`, `PoolStateInvariantTests` |
| upstream `TestTokenV2_RegistryV2` | yes, with a real disclosed `TokenRules` context | cross-registry settlement, per-admin choice context | `RealRegistryDvpTests` |

[`RfqSettlementTests.daml`](../../trading-tests/CantonDex/Tests/RfqSettlementTests.daml)
shows why the ladder matters: a holding-less harness can verify command
composition, but only a registry with real holdings can prove locks, credits,
change, and balance conservation. Value movement is therefore tested against
`Registry.V2` and the upstream registry.

### What each suite proves

| Suite | Scripts | Proves | Fixture |
|---|---|---|---|
| [`InstrumentTests.daml`](../../trading-tests/CantonDex/Tests/InstrumentTests.daml) | 6 | the standalone lifecycle sample retained in the package lineage: config updates, credential-gated mint, burn, transfer offers, and preapproval | `CantonDex.Instrument` sample (not used by DEX workflows) |
| [`EdgeCaseTests.daml`](../../trading-tests/CantonDex/Tests/EdgeCaseTests.daml) | 5 | rejection paths for the standalone lifecycle sample: invalid mint/burn amounts, instrument mismatch, and missing issuer credentials | `CantonDex.Instrument` sample (not used by DEX workflows) |
| [`PolicyReceiptTests.daml`](../../trading-tests/CantonDex/Tests/PolicyReceiptTests.daml) | 10 | `PolicyReceipt` + `MatchedTrade` shape invariants: `policyReceiptValues` encoding, `foldPolicyReceiptIntoMetadata`, `isWellFormed`, and the authority guard that rejects a receipt whose `signedBy` is not the venue | pure |
| [`PoolRoundingTests.daml`](../../trading-tests/CantonDex/Tests/PoolRoundingTests.daml) | 5 | four focused arithmetic proofs plus one holding-backed swap prove that pool-favouring rounding also preserves the settlement invariant | pure `PoolModel` (4); `Registry.V2` holding-backed swap (1) |
| [`PoolWorkflowTests.daml`](../../trading-tests/CantonDex/Tests/PoolWorkflowTests.daml) | 3 | pool initialization, pause/resume, quote/state binding, swap replacement, and request-to-settlement choreography; it does not prove value movement | `MockRegistry` |
| [`OrderWorkflowTests.daml`](../../trading-tests/CantonDex/Tests/OrderWorkflowTests.daml) | 8 | order funding, allocation binding, limit enforcement, rejection paths, and atomic remainder roll-forward; it does not prove locked backing | `MockRegistry` |
| [`TradeWorkflowTests.daml`](../../trading-tests/CantonDex/Tests/TradeWorkflowTests.daml) | 5 | allocation-request consumption, RFQ ranking receipts and expiry, and bilateral settlement assembly; it does not prove balance movement | `MockRegistry` |
| [`ChoiceContextWorkflowTests.daml`](../../trading-tests/CantonDex/Tests/ChoiceContextWorkflowTests.daml) | 5 | allocation and split-admin settlement choice contexts reach the correct registry factories and missing context is rejected; it does not prove value movement | context-requiring `MockRegistry` factories |
| [`DexPairTests.daml`](../../trading-tests/CantonDex/Tests/DexPairTests.daml) | 3 | operator-only listing updates, consuming replacement/visibility, and fee-counter accounting; explicitly does not claim that listing metadata gates pool or order execution | pure listing state |
| [`LifecycleChoiceTests.daml`](../../trading-tests/CantonDex/Tests/LifecycleChoiceTests.daml) | 5 | the exits that happy-path suites can obscure: request cancel/reject, funded-order cancel, matched-trade cancel, RFQ cancel/quote withdraw, and match abort, including controller failures and release of real locked holdings | `Registry.V2` where value release matters |
| [`TokenStandardHarnessTests.daml`](../../trading-tests/CantonDex/Tests/TokenStandardHarnessTests.daml) | 1 | the matched-trade flow driven through the `RegistryApi` interface, mirroring `splice-token-standard-test-v2`'s `TradingAppV2` exercise | `DexRegistry` |
| [`PoolLiquidityRulesTests.daml`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml) | 16 | DvP liquidity against real holdings: an atomic add funds base + quote and mints LP tokens in one flow; remove delivers base + quote to the holder and burns LP via the burn account; stale-quote rejection; the settle is co-controlled by operator + `lpRegistrar` | `Registry.V2` |
| [`PoolStateInvariantTests.daml`](../../trading-tests/CantonDex/Tests/PoolStateInvariantTests.daml) | 6 | `PoolState.reserves` always equals the sum of the live `PoolSlice` holdings: `PoolRules_ReconcileState` succeeds across an add → swap → remove lifecycle and fails on an omitted slice, an operator-fabricated state, or a foreign slice | `Registry.V2` |
| [`RegistryConservationTests.daml`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml) | 25 | V2 factory, actor, deadline, withdrawal, cancellation, and settle-time conservation rules: an executor cannot draw more than locked backing; roll-forward carries real backing; surplus returns to the authorizer; batch settlement rejects imbalance and coverage mismatches | `Registry.V2` |
| [`RfqSettlementTests.daml`](../../trading-tests/CantonDex/Tests/RfqSettlementTests.daml) | 4 | the RFQ round trip against real holdings: each side funds its own leg from its own inventory, successful settlement leaves no residual locks, expiry blocks late settlement, and every considered quote must be live when accepted | `Registry.V2` |
| [`RealRegistryDvpTests.daml`](../../trading-tests/CantonDex/Tests/RealRegistryDvpTests.daml) | 11 | the per-admin choice context against genuinely context-requiring registries: DvP add/swap/remove and cross-admin order matching settle across two distinct registries in one transaction, each admin's disclosed context reaching only its own batch, and dropping it aborts the settle | `TestTokenV2_RegistryV2` + `Registry.V2` |

A concept doc points at several of these as its worked proof — for example the
rounding rules in [`PoolRoundingTests.daml`](../../trading-tests/CantonDex/Tests/PoolRoundingTests.daml)
pin the exact case where naive `*` and `/` would leak value:

```daml
testFloorDivStaysBelowExactQuotient = do
  let numerator = 7000.0 : Decimal
  numerator / 1007.0 === 6.9513406157         -- plain (/) rounds the last digit UP
  PM.floorDiv 7000.0 1007.0 === 6.9513406156  -- floorDiv never overshoots
  ...
```

## Backend tests (`services/operator-backend`)

The backend suite runs on `node:test` against a TypeScript `InMemoryLedger`
fixture that implements only the selected choices needed by these service and
route tests. It does not execute Daml. This keeps HTTP, indexer, and pricing
tests fast while the Daml and live-Canton layers prove the ledger behavior.
Type-check and run:

```bash
cd services/operator-backend
npm run typecheck
npm test
```

The files group by concern:

| Area | Representative files | What they cover |
|---|---|---|
| Matching & pricing | `matching.test.ts`, `pool.test.ts`, `order.test.ts`, `decimal-money.test.ts` | order-book aggregation and `matchOrdersForPair`, the AMM quote math, decimal-string money handling |
| RFQ & matched trade | `rfq.test.ts`, `matched-trade.test.ts`, `match-leg-shape.test.ts` | the RFQ accept path through the service boundary (`RfqService.accept` → `MatchedTrade` + `PolicyReceipt`, with `verifyReceipt` digest replay), and the settlement batch wire shape |
| Indexer & idempotency | `idempotency.test.ts`, `indexer-projection-exactness.test.ts`, `indexer-migrations.test.ts`, `order-fill-recording.test.ts` | the replay/idempotency guard, exact decimal projection out of the store, schema migrations, order-fill recording |
| Auth & read scoping | `auth.test.ts`, `caller-auth.test.ts`, `read-exposure.test.ts`, `rfq-read-scoping.test.ts` | the write-route auth gate, CORS default-deny, and that party-scoped reads never over-expose |
| Ledger driver | `json-api-ledger.test.ts` | `JsonApiLedger.submit` serialization against a mocked `fetch` — create/exercise envelopes and the `updateId` → transaction-tree follow, with no live ledger |
| Docs as tests | `docs-governance-caveats.test.ts`, `docs-hosted-scope.test.ts`, `docs-token-standard-scope.test.ts`, `docs-v2-only.test.ts` | assertions that keep the docs honest about governance, Token Standard, and hosted-deployment boundaries |

## dApp tests (`app/web`)

The dApp suite runs on Vitest in a jsdom environment; a shared setup
(`src/__tests__/setup.ts`) installs jest-dom matchers and a default `fetch`
mock that shapes the backend's read endpoints, so components and services test
without a network. Run:

```bash
cd app/web
npm test
```

The load-bearing seams:

| Area | Files | What they cover |
|---|---|---|
| Command composition | `commands.test.ts` | snapshot tests of `composeCommands`: every `WalletIntent` maps to a stable set of Daml commands (the piece the wallet signs) |
| Funding planners | `ledger.test.ts`, `normalize-funding.test.ts` | `pickCoveringHoldingCids` / `pickExactHoldingCids` / `planSwapFunding`, and the read → split/merge → re-read → pick funding normalization |
| Wallet providers | `detection.test.ts`, `sdk-provider.test.ts`, `partylayer-provider.test.ts`, `walletconnect-provider.test.ts`, `wallet-store.test.ts` | wallet discovery and the one-row mapping, each provider's result shape and disconnect signal, and store lifecycle (no listener leaks) |
| UI | `pages.test.tsx`, `swap-decimal-strings.test.tsx` | page rendering against the mocked backend, and that swap inputs preserve decimal-string precision |

## Backend HTTP smoke

[`scripts/backend-http-smoke.sh`](../../scripts/backend-http-smoke.sh) starts the development
backend with `InMemoryLedger` and asserts the Amulet/USDCx preview seed across
selected read and quote routes: `/v1/pools` and `/v1/pairs` list Amulet,
`trader-demo`'s holdings include USDCx, and the swap-quote, order-book, and
prices routes answer for the Amulet/USDCx pair. It also confirms that an
unauthenticated admin write returns 401, then stops the process. It does not
start the dApp or Canton, submit a successful write, or exercise a wallet.

Install the backend dependencies once, then run the script from the repository
root:

```bash
(cd services/operator-backend && npm ci)
bash scripts/backend-http-smoke.sh
# final line: ==> All backend HTTP smoke checks passed
```

The script needs Bash, Node.js, npm, curl, and grep. Set `PORT` to use a port
other than 18080. It refuses to reuse a port already serving `/v1/status`. On
failure it prints the retained backend-log path; on success it removes its
temporary directory.

## Live Canton probes

The probes below require an **already-running participant** with the required
DARs uploaded. LocalNet start/stop is deliberately separate from these test
commands. If using `canton-devkit`, its lifecycle command is
`canton-devkit localnet`; its environment does not supply the DEX role or
package-id variables listed below. The repository's optional adapter uses the
app-provider primary party for operator/admin and allocates an LP/trader and
swapper through the JSON Ledger API. The self-contained driver's synchronizer
id is optional on a single-synchronizer participant; the other raw scripts
still require one.

> **State warning:** every live probe submits commands and can leave contracts
> behind after success or failure. Use a throwaway LocalNet where possible. On
> a shared testnet, use dedicated parties/pools and record the printed run id.
> There is no automatic rollback.

### RFQ service integration

[`canton-live-rfq.test.ts`](../../services/operator-backend/test/live/canton-live-rfq.test.ts)
uses the real `JsonApiLedger` and backend `RfqService`, without starting the
HTTP server. It creates an RFQ and quotes, accepts one, verifies the returned
receipt, queries the resulting `MatchedTrade`, checks exact CIDs in the list
case, and verifies cancel archives an RFQ. It does not fund or settle the
`MatchedTrade`; the accepted trade remains on-ledger.

Required environment:

| Variable | Meaning |
|---|---|
| `CANTON_JSON_API_URL` | participant JSON Ledger API base URL |
| `CANTON_JSON_API_TOKEN` | JWT with `actAs` for operator, trader, and both dealers |
| `CANTON_OPERATOR_PARTY` | RFQ operator and trade venue |
| `CANTON_TRADER_PARTY` | RFQ trader |
| `CANTON_DEALER_JUMP`, `CANTON_DEALER_ORCA` | two quote dealers |
| `CANTON_BTC_ADMIN` | asset-admin party written into the resulting trade |

After building and uploading the current trading DAR and allocating the
parties, run from the backend directory:

```bash
cd services/operator-backend
CANTON_LIVE_RFQ=1 \
  CANTON_JSON_API_URL=https://participant.example \
  CANTON_JSON_API_TOKEN=... \
  CANTON_OPERATOR_PARTY=... \
  CANTON_TRADER_PARTY=... \
  CANTON_DEALER_JUMP=... \
  CANTON_DEALER_ORCA=... \
  CANTON_BTC_ADMIN=... \
  npm run test:live:rfq
```

The live test lives under `test/live/`, outside the ordinary `test/*.test.ts`
glob, so `npm test` cannot discover or submit it. When `CANTON_LIVE_RFQ` is
absent, the explicit `npm run test:live:rfq` command emits one skipped test.

The driver's main mappings are:

| `LedgerSubmitter` method | JSON API call |
|---|---|
| `submit` | `POST /v2/commands/submit-and-wait` |
| `query` | `GET /v2/state/ledger-end`, then `POST /v2/state/active-contracts` |
| `subscribe` | `GET /v2/updates/flats` (SSE) |

### Self-contained AMM round-trip probe

[`live-amm-roundtrip.ts`](../../scripts/live-amm-roundtrip.ts) creates a unique
`Registry.V2`, registers base/quote/LP instruments, mints the deposit assets,
creates the pool contracts, authors the LP's three allocations, and settles one
add-liquidity DvP. In full mode it then has the swapper authorize the exact
quote-bound input allocation, executes a quote-to-base swap, and redeems half
the LP position through three LP-authored remove allocations.

The driver asserts:

- the exact holding and reserve deltas for every phase;
- `PoolState.reserves` equals the active `PoolSlice` sums after add, swap, and
  remove;
- LP holdings, `PoolState.totalLpSupply`, and `LPTokenPolicy.totalSupply`
  agree after mint and burn;
- the constant product does not decrease after the fee-bearing swap;
- reserve value per remaining LP token does not decrease after redemption; and
- aggregate unlocked holdings plus pool reserves conserve both instruments.

It does not call the operator HTTP API, render the dApp, exercise browser
authentication, or use a real wallet transport. The script directly authors
the allocations that a wallet would normally submit.

Required variables are `CANTON_LEDGER_URL`, `CANTON_LEDGER_TOKEN`,
`CANTON_DEX_PACKAGE_ID`, `CANTON_ALLOC_INSTR_PACKAGE_ID`, `CANTON_OPERATOR`,
`CANTON_ADMIN`, and `CANTON_TRADER`. `CANTON_SWAPPER` is optional and defaults
to the trader. `CANTON_USER_ID` defaults to `ledger-api-user`;
`CANTON_SYNCHRONIZER` is also optional, and an omitted value lets a
single-synchronizer participant route commands automatically. The JWT must be
allowed to act as every distinct configured party. `CANTON_ADMIN` is also the
asset issuer and LP registrar in this self-contained fixture. The trader must
differ from the operator because an add cannot self-transfer; full mode also
requires the swapper to differ from the operator.

```bash
cd services/operator-backend
npm run live:roundtrip
# PASS: add -> swap -> partial remove settled real holdings; ...
```

The final output includes the unique run, registry, and pool identifiers left
on the participant. `npm run localnet:amm-roundtrip` is the full-round-trip
compatibility alias. For a fast diagnostic that intentionally stops after the
first DvP, use `npm run live:add-liquidity`; it still requires trader and
operator to be different parties.

### Existing-pool add and swap probe

[`seed-testnet-pool.ts`](../../scripts/seed-testnet-pool.ts) discovers an
existing registry and pool, mints test assets, performs one add-liquidity and
one swap, and checks exact reserves and holdings, slice reconciliation, and
that the constant-product invariant did not decrease. It does not test remove
liquidity, HTTP, the dApp, or wallet transport. It adds assets to the selected
pool on every run, so use a dedicated test pool.

Required variables are `CANTON_LEDGER_URL`, `CANTON_LEDGER_TOKEN`,
`CANTON_SYNCHRONIZER`, `CANTON_DEX_PACKAGE_ID`,
`CANTON_ALLOC_INSTR_PACKAGE_ID`, and `CANTON_OPERATOR`. Optional selectors and
amounts are documented at the top of the script: `CANTON_USER_ID`,
`CANTON_LP`, `CANTON_SWAPPER`, `CANTON_REGISTRY_CID`,
`CANTON_LP_REGISTRY_CID`, `POOL_BASE`, `POOL_QUOTE`, `POOL_ID`, `SEED_BASE`,
`SEED_QUOTE`, `SWAP_IN`, and `SWAP_IN_SIDE`. The JWT must be allowed to act as
the operator and all asset-admin, LP-registrar, LP, and swapper parties resolved
by the script.

```bash
cd services/operator-backend
npm run testnet:seed-pool
```

### Matched-trade settlement probe

[`testnet-v2registry-trade.ts`](../../scripts/testnet-v2registry-trade.ts)
creates its own registry and instrument, mints to a sender, creates a
one-instrument `MatchedTrade`, accepts both allocation sides, settles the batch,
and verifies sender/receiver holdings. It is a direct ledger settlement probe;
it does not exercise RFQ acceptance, order matching, AMM code, HTTP, or a
wallet.

Required variables are `CANTON_LEDGER_URL`, `CANTON_LEDGER_TOKEN`,
`CANTON_SYNCHRONIZER`, `CANTON_DEX_PACKAGE_ID`,
`CANTON_ALLOC_REQUEST_PACKAGE_ID`, `CANTON_ALLOC_INSTR_PACKAGE_ID`,
`CANTON_VENUE`, `CANTON_ADMIN`, `CANTON_ALICE`, and `CANTON_BOB`.
`CANTON_USER_ID` is optional. The JWT must be allowed to act as all four
configured parties.

```bash
cd services/operator-backend
npm run live:matched-trade
```

### Diagnosing and recovering from failures

| Symptom | Likely cause | Recovery |
|---|---|---|
| `missing env: NAME` / `required env: NAME` | incomplete environment | export the named variable; no ledger command was sent before configuration finished |
| HTTP 401 | expired JWT or missing party rights | issue a fresh token with the exact `actAs` set |
| template/package not found | DAR absent or wrong package-id environment | upload the current DARs and correct the package ids |
| requires authorizer / authorization failure | token cannot act as a submitted party | compare the script's documented party set with the JWT rights |
| contract not found / duplicate fixture | stale CID, wrong observing party, or a rerun against shared state | use a new throwaway LocalNet or choose a dedicated pool; do not assume a failed run rolled back earlier transactions |

The RFQ driver surfaces JSON API failures as `LedgerError.detail`; the raw
scripts print their failing step and HTTP response body. Preserve that output
and the run id before resetting a throwaway LocalNet. There is no generic
cleanup command because a partial run can stop at many different contract
states.

## What CI runs

`.github/workflows/ci.yml` gates every pull request on the offline layers: the
Daml build, in-script tests, and upgrade-compatibility check; backend typecheck
and tests; frontend typecheck, tests, and production build; the documentation
site build; and a container build plus backend runtime smoke. The container
check starts the read-only backend with an intentionally unreachable
participant, asserts that `/v1/status` reports unsynchronized state, verifies
an unauthenticated admin write returns 401, and checks the non-root runtime and
SQLite binding. CI also runs `npm run typecheck:live-scripts` so the
deployment/bootstrap and raw live-driver sources cannot silently drift. It does
not connect to Canton or prove any live path.

## Out of scope

- An automated remove-liquidity path through the authenticated operator HTTP
  API and a real browser wallet. The self-contained raw JSON-API driver proves
  the live ledger transition, not those application boundaries.
- The order-funding flow (`OrderFundingRequest` → trader-authored allocation →
  `Order_Fund`) through a real browser wallet. The wallet handoff lives in
  `app/web/src/wallet/`; an integration test for it needs a wallet emulator.
- One automated path through browser, real wallet transport, authenticated
  backend HTTP, and live Canton.
- A live external-registry HTTP round trip. The live RFQ integration test uses
  a `FixedRegistryClient` whose methods are never called because RFQ acceptance
  does not allocate or settle tokens. Offline tests prove the canonical
  operation-specific request bodies and response validation; a live swap test
  still needs a deployed registry endpoint, credentials, and factory contracts.

---

**Where to read next:** [Getting Started](../getting-started.md) · [Builder Guide](../guides/builder-guide.md) · [Validator Test Plan](../guides/validator-test-plan.md) · [All docs](../README.md)
