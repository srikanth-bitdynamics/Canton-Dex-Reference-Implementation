# Testing

This reference proves itself in layers. The Daml core is exercised by
in-script suites that run on an in-memory ledger with no Canton process at
all; the operator backend and the dApp have their own unit and integration
suites; and a small set of end-to-end paths drive the whole stack against a
live Canton participant. The design decision throughout is to test each
guarantee at the lowest layer that can hold it — value conservation and
authorization in Daml, projection and idempotency in the backend, command
composition in the dApp — and to reserve the slow, ledger-backed tests for the
seams that only a real engine exercises.

| Layer | What it proves | Runner | Command |
|---|---|---|---|
| Daml in-script suites | choice logic, conservation, authorization, rounding | Daml Script (in-memory) | `dpm test` in `trading-tests/` |
| Backend | HTTP surface, matching, indexer projection, idempotency, auth | `node:test` (InMemoryLedger) | `npm test` in `services/operator-backend` |
| dApp | wallet-intent → command composition, funding planners, providers | Vitest + jsdom | `npm test` in `app/web` |
| HTTP smoke | every endpoint answers, auth gate holds | Bash + curl (InMemoryLedger) | `bash scripts/e2e-smoke.sh` |
| Live ledger | the JSON Ledger API driver + real settlement | `node:test` / `tsx` (Canton) | `CANTON_E2E=1 npm test`; `npm run localnet:dvp-e2e` |

Everything above the last row runs offline and is what CI gates on. The last
row needs a Canton participant and is opt-in.

## Daml in-script suites (`trading-tests/`)

These are Daml Script tests: each is a `Script ()` that allocates parties,
submits commands, and asserts on the resulting contracts, all on the script
runner's in-memory ledger. No Canton, no JSON API, no backend — just the Daml
engine enforcing the same authorization and consumption rules it enforces in
production. Run them with:

```bash
bash scripts/run-local-daml-tests.sh
```

which builds the `canton-dex-trading` DAR against the committed Token Standard
DARs (`scripts/build-trading-surface.sh`) and then runs both the core suite and
the reuse example. By hand:

```bash
(cd trading       && dpm build)   # -> trading/.daml/dist/canton-dex-trading-0.1.4.dar
(cd trading-tests && dpm test)    # every script reports "ok" (97 scripts at time of writing)
```

### The registry-fixture ladder

Most of the suites differ not in the workflow they drive but in the *registry*
they drive it against, and that choice is load-bearing. A settlement bug can
hide behind a registry that doesn't hold real value, so the suites climb a
ladder from cheap-but-blind to slow-but-honest:

| Fixture | Holds real holdings? | Good for | Used by |
|---|---|---|---|
| `MockRegistry` | no (empty `inputHoldingCids`) | choice plumbing, multi-party authority | `EndToEndTests` |
| `DexRegistry` over `MockRegistry` | no | the `RegistryApi` interface handshake | `TokenStandardHarnessTests` |
| `CantonDex.Registry.V2` | yes (locks, credits, mint/burn accounts) | settlement, conservation, DvP | `PoolLiquidityRulesTests`, `RegistryConservationTests`, `RfqSettlementTests`, `PoolStateInvariantTests`, `DvpMintBurnTests` |
| upstream `TestTokenV2_RegistryV2` | yes, with a real disclosed `TokenRules` context | cross-registry settlement, per-admin choice context | `RealRegistryDvpTests` |

The header of [`RfqSettlementTests.daml`](../../trading-tests/CantonDex/Tests/RfqSettlementTests.daml)
records why the ladder exists: three separate wire shapes shipped wrong and
every one of them passed a holding-less harness test, because the harness
archives allocations without moving value. Settlement is only proven where
holdings really move — against `Registry.V2` and the upstream registry.

### What each suite proves

| Suite | Scripts | Proves | Fixture |
|---|---|---|---|
| [`InstrumentTests.daml`](../../trading-tests/CantonDex/Tests/InstrumentTests.daml) | 6 | instrument config create/update; mint request → registrar accept (with credential check) and requestor cancel; burn accept; transfer offer → accept and via `TransferPreapproval`; open issuance | instrument templates |
| [`EdgeCaseTests.daml`](../../trading-tests/CantonDex/Tests/EdgeCaseTests.daml) | 5 | rejection paths the happy-path suites skip: zero/negative mint and burn amounts (`ensure` clauses), mint-accept on `instrumentId` mismatch or missing issuer credentials | instrument templates |
| [`PolicyReceiptTests.daml`](../../trading-tests/CantonDex/Tests/PolicyReceiptTests.daml) | 10 | `PolicyReceipt` + `MatchedTrade` shape invariants: `policyReceiptValues` encoding, `foldPolicyReceiptIntoMetadata`, `isWellFormed`, and the authority guard that rejects a receipt whose `signedBy` is not the venue | pure |
| [`PoolRoundingTests.daml`](../../trading-tests/CantonDex/Tests/PoolRoundingTests.daml) | 5 | pool arithmetic always rounds in the pool's favour, so a swap, deposit, or withdrawal can never quietly pay out more than it should | pure (`PoolModel`) |
| [`EndToEndTests.daml`](../../trading-tests/CantonDex/Tests/EndToEndTests.daml) | 19 | the whole exchange front-to-back: pool funding, order funding (`OrderFundingRequest` → `Order_Fund`), `OrderMatchExecution_Execute` (limit-price, atomic forward-roll, closing an unbacked remainder), RFQ accept → `MatchedTrade` + `PolicyReceipt`, `PoolRules_Swap`, and DvP choice-context threading | `MockRegistry` |
| [`TokenStandardHarnessTests.daml`](../../trading-tests/CantonDex/Tests/TokenStandardHarnessTests.daml) | 1 | the matched-trade flow driven through the `RegistryApi` interface, mirroring `splice-token-standard-test-v2`'s `TradingAppV2` exercise | `DexRegistry` |
| [`PoolLiquidityRulesTests.daml`](../../trading-tests/CantonDex/Tests/PoolLiquidityRulesTests.daml) | 16 | DvP liquidity against real holdings: an atomic add funds base + quote and mints LP tokens in one flow; remove delivers base + quote to the holder and burns LP via the burn account; stale-quote rejection; the settle is co-controlled by operator + `lpRegistrar` | `Registry.V2` |
| [`PoolStateInvariantTests.daml`](../../trading-tests/CantonDex/Tests/PoolStateInvariantTests.daml) | 5 | `PoolState.reserves` always equals the sum of the live `PoolSlice` holdings: `PoolRules_ReconcileState` succeeds across an add → swap → remove lifecycle and fails on an omitted slice, an operator-fabricated state, or a foreign slice | `Registry.V2` |
| [`DvpMintBurnTests.daml`](../../trading-tests/CantonDex/Tests/DvpMintBurnTests.daml) | 2 | the delivery-versus-mint/burn mechanism on the V2 allocation surface: a mint credits the recipient, a burn archives with no credit. Its header also documents, deliberately, that the shipped test registry does *not* gate mint authorization | `Registry.V2` |
| [`RegistryConservationTests.daml`](../../trading-tests/CantonDex/Tests/RegistryConservationTests.daml) | 16 | settle-time conservation in the reference registry: an executor cannot draw more than the allocation's locked backing; roll-forward carries real locked backing; surplus returns to the authorizer; the `SettlementFactory` batch rejects per-instrument imbalance and coverage mismatches | `Registry.V2` |
| [`RfqSettlementTests.daml`](../../trading-tests/CantonDex/Tests/RfqSettlementTests.daml) | 4 | the RFQ round trip against real holdings: each side funds its own leg from its own inventory; a dealer stocked with the wrong asset fails at allocation *after* `Rfq_Accept` has consumed the RFQ; an expiry between accept and settle blocks the settle; one lapsed quote aborts the accept | `Registry.V2` |
| [`RealRegistryDvpTests.daml`](../../trading-tests/CantonDex/Tests/RealRegistryDvpTests.daml) | 6 | the per-admin choice context against a genuinely context-requiring upstream registry: a DvP add settles across two registries in one transaction (base/quote under `TestTokenV2_RegistryV2`, the LP mint under `Registry.V2`), and dropping the real disclosed context aborts the settle | `TestTokenV2_RegistryV2` + `Registry.V2` |

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

### The reuse example (`examples/stable-pool/`)

A separate Daml project consumes `canton-dex-trading-0.1.4.dar` as a
*data-dependency* and builds a StableSwap pool on top of it, without editing a
base template. `run-local-daml-tests.sh` runs it too; the three scripts prove
an external builder can ship a different curve on the same V2 substrate:

```bash
(cd examples/stable-pool && dpm test)   # 3 ok
```

## Backend tests (`services/operator-backend`)

The backend suite runs on `node:test` against an `InMemoryLedger` that mimics
Daml choice semantics, so the HTTP surface, indexer, and pricing logic are all
tested without a Canton process. Type-check and run:

```bash
cd services/operator-backend
npm run typecheck
npm test
```

The files group by concern:

| Area | Representative files | What they cover |
|---|---|---|
| Matching & pricing | `matching.test.ts`, `pool.test.ts`, `order.test.ts`, `decimal-money.test.ts` | order-book aggregation and `matchOrdersForPair`, the AMM quote math, decimal-string money handling |
| RFQ & matched trade | `rfq.test.ts`, `matched-trade.test.ts`, `match-leg-shape.test.ts` | the RFQ accept flow end-to-end (the worked example: `RfqService.accept` → `MatchedTrade` + `PolicyReceipt`, with `verifyReceipt` digest replay), and the settlement batch wire shape |
| Indexer & idempotency | `idempotency.test.ts`, `indexer-projection-exactness.test.ts`, `indexer-migrations.test.ts`, `order-fill-recording.test.ts` | the replay/idempotency guard, exact decimal projection out of the store, schema migrations, order-fill recording |
| Auth & read scoping | `auth.test.ts`, `caller-auth.test.ts`, `read-exposure.test.ts`, `rfq-read-scoping.test.ts` | the write-route auth gate, CORS default-deny, and that party-scoped reads never over-expose |
| Ledger driver | `json-api-ledger.test.ts` | `JsonApiLedger.submit` serialization against a mocked `fetch` — create/exercise envelopes and the `updateId` → transaction-tree follow, with no live ledger |
| Docs as tests | `docs-governance-caveats.test.ts`, `docs-token-standard-scope.test.ts`, `docs-v2-only.test.ts` | assertions that keep the docs honest about scope and governance caveats |

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

## HTTP smoke test

`scripts/e2e-smoke.sh` boots the dev backend (still `InMemoryLedger`) and curls
every key endpoint in sequence, asserting the response shape and the admin auth
gate, then shuts down. It needs only `node` and `curl` — no Canton:

```bash
bash scripts/e2e-smoke.sh   # "==> All smoke checks passed"
```

It walks the read endpoints (`/v1/status`, `/v1/context`, `/v1/pools`,
`/v1/pairs`, `/v1/orders`, `/v1/holdings`), a swap quote, the order book, the
price feed, and finally confirms `POST /v1/admin/pairs` is refused without auth.

## Against a live Canton participant

The dev backend is in-memory. Two opt-in paths exercise the real JSON Ledger
API driver (`services/operator-backend/src/ledger/json-api.ts`) against an
actual Canton engine.

### The RFQ accept integration test (`CANTON_E2E=1`)

`services/operator-backend/test/canton-e2e.test.ts` covers the same ground as
the in-memory `rfq.test.ts`, but routes every command through the real Daml
engine on a Canton participant. It verifies:

- `JsonApiLedger.submit` serializes `submit-and-wait` envelopes with `actAs`,
  `commandId`, and `disclosedContracts`.
- `Rfq` and `RfqQuote` creates land on-ledger.
- `RfqService.accept` co-submits `Rfq_Accept` under `[trader, operator]`; the
  choice computes its own ranking + receipt and creates a `MatchedTrade` whose
  `policyReceipt` matches what the backend computed off-ledger.
- `verifyReceipt` (digest replay) holds against the on-ledger receipt.

The test is gated on `CANTON_E2E=1` so it stays out of the default run; a local
sandbox run takes ~30s including Canton boot.

**Prerequisites:** `daml` CLI ≥ 3.4 on `$PATH`, and the `canton-dex-trading`
DAR built (`cd trading && dpm build`).

**1. Boot a sandbox with the DEX DARs.** The trading DAR pulls its Token
Standard dependencies in on upload, but listing them explicitly avoids a
missing-dependency failure:

```bash
daml sandbox \
  --port 6865 \
  --json-api-port 7575 \
  --dar trading/.daml/dist/canton-dex-trading-0.1.4.dar \
  --dar vendor/splice/dars/splice-api-token-allocation-v2-1.0.0.dar \
  --dar vendor/splice/dars/splice-api-token-allocation-instruction-v2-1.0.0.dar \
  --dar vendor/splice/dars/splice-api-token-allocation-request-v2-1.0.0.dar \
  --dar vendor/splice/dars/splice-api-token-holding-v2-1.0.0.dar \
  --dar vendor/splice/dars/splice-api-token-transfer-instruction-v2-1.0.0.dar \
  --dar vendor/splice/dars/splice-api-token-transfer-events-v2-1.0.0.dar \
  --dar vendor/splice/dars/splice-api-token-metadata-v1-1.0.0.dar
```

**2. Allocate parties and obtain a JWT.**

```bash
daml ledger allocate-parties operator alice orca jump btc-admin
daml-helper request-token --party operator > /tmp/operator.jwt
```

The token must grant `actAs` for every party the test submits as — operator,
trader, both dealers, and the asset admin — and is sent as
`Authorization: Bearer ...` on every request. `daml-helper request-token` is
for local dev only; production deployments issue per-session tokens from a
proper IAM.

**3. Run the test.**

```bash
CANTON_E2E=1 \
  CANTON_JSON_API_URL=http://localhost:7575 \
  CANTON_JSON_API_TOKEN=$(cat /tmp/operator.jwt) \
  CANTON_OPERATOR_PARTY=operator \
  CANTON_TRADER_PARTY=alice \
  CANTON_DEALER_JUMP=jump \
  CANTON_DEALER_ORCA=orca \
  CANTON_BTC_ADMIN=btc-admin \
  npm test --prefix services/operator-backend
```

The three Canton cases run inside the full backend suite:

```
✔ Canton E2E: RFQ accept produces MatchedTrade with PolicyReceipt
✔ Canton E2E: rfq.list returns visible RFQs and quotes
✔ Canton E2E: rfq.cancel archives an open Rfq
```

To run only this file, replace the `npm test` line with
`node --import tsx --test services/operator-backend/test/canton-e2e.test.ts`.
When `CANTON_E2E` is unset, the suite emits a single skip line and the
in-memory `rfq.test.ts` still runs.

**How the driver maps to the JSON Ledger API:**

| `LedgerSubmitter` method | JSON API call |
|---|---|
| `submit` (create) | `POST /v2/commands/submit-and-wait` with `CreateCommand` |
| `submit` (exercise) | `POST /v2/commands/submit-and-wait` with `ExerciseCommand` |
| `submit` (exerciseInterface) | `POST /v2/commands/submit-and-wait` with `ExerciseByInterfaceCommand` |
| `query` | `POST /v2/state/active-contracts` |
| `subscribe` | `GET /v2/updates/flats` (SSE) |

Errors are mapped from the JSON API's `{ errors: [...] }` body to typed
`LedgerError` instances. Contention errors (HTTP 409 / gRPC `ABORTED` carrying
`contention` or `inconsistent`) are tagged retryable, so `retryOnContention`
recovers automatically. When a case fails, the JSON API's response body is the
most useful artifact — the driver puts it in `LedgerError.detail`; set
`NODE_DEBUG=http,fetch` to see full request/response wire traffic. Common
failure modes:

| Symptom | Cause |
|---|---|
| `401: invalid token` | JWT expired or scoped to the wrong party set |
| `404: template not found` | DAR not uploaded, or operator party can't see it |
| `409: contention` | Submission stale; the driver retries automatically |
| `400: requires authorizer X` | `actAs` doesn't include a party the choice needs |

### The headless DvP round-trip (`localnet:dvp-e2e`)

`scripts/localnet-dvp-e2e.ts` drives the one seam the browser dApp can't
automate: the trader's wallet authoring allocations. It stands in for a
CIP-0103 wallet, authoring the trader's three allocations for each DvP add and
remove, then settling — exercising the operator's full two-call flow
(request → wallet authors allocations → settle) plus a swap, against a live
LocalNet participant. From the backend (which has `tsx` on its path), with the
LocalNet `CANTON_*` environment exported:

```bash
npm run localnet:dvp-e2e --prefix services/operator-backend
```

It is self-contained: it creates its own `Registry.V2`, registers
base/quote/LP instruments, mints to the trader, builds the pool contracts, then
runs add → swap → remove and asserts the on-ledger reserves and LP supply.

## What CI runs

`.github/workflows/ci.yml` gates every pull request on the offline layers:
commit-message hygiene, the Daml build plus upgrade-compatibility check
(`scripts/check-upgrade-compat.sh`), the backend typecheck + tests, the
frontend typecheck + build, and a Docker build smoke. The live-ledger paths
above are opt-in and not part of CI.

## Out of scope

- A pool add-liquidity + swap end-to-end over the *JSON Ledger API*. The
  `PoolLiquidityRulesTests` and `RealRegistryDvpTests` Daml suites cover this
  ground at the ledger level, and `localnet:dvp-e2e` covers it against a live
  participant; a JSON-API-driven version can be added as another integration
  test.
- The order-funding flow (`OrderFundingRequest` → trader-Accept → `Order_Fund`)
  through a real browser wallet. The wallet handoff lives in
  `app/web/src/wallet/`; an integration test for it needs a wallet emulator.
- The full registry HTTP API. The `CANTON_E2E` test stubs `getFactories`
  because the RFQ accept flow reads no factory CIDs; tests that exercise pool
  swaps will need a real registry-backed factory.

---

**Where to read next:** [Getting Started](../getting-started.md) · [Builder Guide](../guides/builder-guide.md) · [Validator Test Plan](../guides/validator-test-plan.md) · [All docs](../README.md)
