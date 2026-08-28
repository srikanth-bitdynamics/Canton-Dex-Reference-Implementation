# Canton Testnet Validator — Live Test Plan

Use this manual checklist to sign off one deployed DEX environment. It combines
boundaries that the automated suites intentionally test separately: a real
participant, authenticated backend, browser dApp, and real wallet. Record
evidence for each scenario; running a ledger script is useful corroboration,
not a substitute for the browser path.

## Know what each path proves

| Path | Includes | Does not prove |
|---|---|---|
| Offline pre-flight | Daml Script, backend tests, dApp tests, backend HTTP smoke | participant compatibility, real wallet, live state |
| Live RFQ test | RFQ service, JSON API, Daml engine | HTTP auth, browser/wallet, token settlement |
| Live AMM round trip | JSON API, Registry.V2, add → quote-bound swap → partial remove DvP with reserve, slice, LP-supply, invariant, and conservation checks | backend HTTP, browser, real wallet |
| Existing-pool probe | JSON API, existing pool, add and swap | backend HTTP, real wallet, remove |
| Matched-trade probe | JSON API, allocations, settlement | RFQ/order matching, AMM, HTTP, real wallet |
| This plan | deployed backend + dApp + wallet + participant | production load, security audit, disaster recovery |

The exact environment and expected output for every automated path is in the
[Testing reference](../reference/testing.md).

## Safety and evidence

All live writes mutate ledger state. Use dedicated test parties and a dedicated
pool; do not seed a production pool. A failed script can leave earlier
transactions committed because there is no cross-transaction rollback. Before
starting, create an evidence directory outside the repository and record:

- deployment name, Git commit, DAR package id, synchronizer id, and timestamp;
- operator, admin, LP registrar, trader, LP, swapper, and dealer party ids;
- backend and dApp URLs, but never bearer tokens or wallet secrets;
- each command, exit code, run id, relevant contract/update ids, and screenshots;
- cleanup performed after the run.

Mark each scenario **Pass**, **Fail**, **Blocked**, or **N/A**. A blocked wallet
or auth path is not a pass merely because a raw JSON API script succeeds.

## Prerequisites

- An already-running Canton validator/participant with JSON Ledger API access.
- The current trading DAR and its Token Standard V2 dependencies uploaded.
- Real party ids for every role used by the scenario.
- A ledger JWT with only the rights needed by the backend or probe.
- A synchronizer id and the DEX/Token Standard package ids.
- Node.js 24, npm, DPM with the SDK pinned by `trading/daml.yaml`, curl, and
  Docker Compose if Phase 8 is in scope.
- A submit-capable CIP-0103/PartyLayer/WalletConnect wallet supported by the
  deployment. The development mock wallet does not prove live submission.

The backend does **not** load `services/operator-backend/.env` automatically.
Export variables into the process environment (or use your deployment's secret
injection) before `npm start`. At minimum, full live mode needs:

```text
CANTON_LEDGER_URL             CANTON_LEDGER_TOKEN
CANTON_OPERATOR               CANTON_LP_REGISTRAR
CANTON_ADMIN                  CANTON_DEX_PACKAGE_ID
CANTON_ALLOC_FACTORY_CID
CANTON_SETTLE_FACTORY_CID     DEX_OPERATOR_API_TOKEN
OPERATOR_ADMIN_TOKEN
```

When `CANTON_LP_REGISTRAR != CANTON_ADMIN`, full mode also requires
`CANTON_LP_ALLOC_FACTORY_CID` and `CANTON_LP_SETTLE_FACTORY_CID` for the LP
registry. `CANTON_SYNCHRONIZER` is strongly recommended and may be required by
the target participant's routing policy.

`CANTON_USER_ID`, `CANTON_NETWORK`, `DB_PATH`, `INDEXER_INTERVAL_MS`, `HOST`,
and `PORT` are optional. `DEX_CALLER_JWT_SECRET` and
`DEX_CALLER_JWT_AUDIENCE` enable per-caller party binding for private reads and
trader-subject writes; if enabled, the dApp also needs a short-lived caller JWT
whose `sub` is the connected party.
`DEX_HOSTED_RFQ_RELAY` remains `0` unless a deliberately custodial RFQ scenario
is in scope; enabling it makes caller binding mandatory.

Do not put `DEX_OPERATOR_API_TOKEN`, `OPERATOR_ADMIN_TOKEN`, or the participant
JWT in a `VITE_*` variable. The Admin page can hold short-lived API tokens in
the current tab's `sessionStorage`; a public deployment should replace that
manual test handoff with an authenticated BFF/session issuer.

## Phase 0 — Offline pre-flight

Run from the repository root after installing dependencies:

```bash
bash scripts/run-local-daml-tests.sh
(cd services/registry-client && npm ci && npm run typecheck)
(cd services/operator-backend && npm ci && npm run typecheck && npm run typecheck:live-scripts && npm test)
(cd app/web && npm ci && npm test && npm run build)
bash scripts/backend-http-smoke.sh
```

Expected:

- [ ] Every command exits 0.
- [ ] The Daml runner reports every selected script `ok`.
- [ ] The HTTP smoke ends with `All backend HTTP smoke checks passed`.
- [ ] The smoke is recorded only as an in-memory selected-route check; it does
      not prove successful writes or live Canton.

## Phase 1 — Deployment readiness

Follow [Run on a Testnet](run-on-testnet.md) for build, upload, party, and
registry bootstrap. Then capture independent evidence:

- [ ] `canton-dex-trading` resolves to the expected package id.
- [ ] The Token Standard V2 allocation request/instruction packages required by
      the live probes resolve to the expected ids.
- [ ] Operator, admin, LP registrar, test traders, LP, swapper, and dealers are
      allocated and connected to the intended synchronizer.
- [ ] The asset-admin and (when distinct) LP-registrar `Registry.V2` contracts
      plus required base/quote/LP instruments exist.
- [ ] `CANTON_ALLOC_FACTORY_CID` and `CANTON_SETTLE_FACTORY_CID` identify the
      intended asset-admin registry, not `PENDING_*` placeholders.
- [ ] With distinct registrars, both `CANTON_LP_*_FACTORY_CID` values identify
      the LP registry rather than reusing the asset registry.
- [ ] The test pool is uniquely identified by pair and `POOL_ID` if more than
      one pool uses that pair.

## Phase 2 — Backend and authentication

With the environment exported, start the live server:

```bash
cd services/operator-backend
npm ci
npm start
```

In a second terminal:

```bash
curl -fsS http://127.0.0.1:8080/v1/status
curl -fsS http://127.0.0.1:8080/v1/context
curl -fsS http://127.0.0.1:8080/v1/pools
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:8080/v1/admin/pairs
```

- [ ] Startup logs identify the expected ledger URL, parties, network, DB, and
      `mode:"full"`.
- [ ] Status reports `synced:true`; context contains the expected parties and
      factory CIDs.
- [ ] The unauthenticated admin write returns 401.
- [ ] A request with a wrong admin token returns 401.
- [ ] A request with a wrong operator token to a non-admin write returns 401.
- [ ] If caller binding is enabled, a missing/invalid `X-Caller-Token` returns
      401, while a valid token for a different party returns 403.
- [ ] The same caller-binding check covers scoped orders, holdings, balances,
      trades, RFQ history, and RFQ/quote reads; an admin token can inspect them.
- [ ] Read-only mode, if tested, was explicitly started with `DEX_READ_ONLY=1`
      and is not signed off for write scenarios.

Use the payload examples in [HTTP API](../reference/http-api.md) for an
authenticated write; do not use `{}` as a success-case payload.

## Phase 3 — dApp and wallet connection

Create `app/web/.env.local` with only public deployment configuration. For a
local Vite validation run:

```bash
cd app/web
npm ci
npm run dev
```

Open <http://localhost:5173> and validate all six routes: Trade, Pools, Orders,
RFQ, Portfolio, and Admin.

- [ ] No route triggers its error boundary.
- [ ] The intended production-capable wallet is shown and connects.
- [ ] The connected party is the dedicated test trader.
- [ ] Reload and disconnect behave as documented by that provider.
- [ ] A cancelled/rejected wallet approval returns the UI to a usable state.
- [ ] The mock and dev-only relay/direct providers are not treated as evidence
      of production wallet compatibility.

For this controlled validation only, enter short-lived operator/admin API
tokens in **Admin → API session credentials**. If per-caller binding is enabled,
enter the test trader's scoped caller JWT too.

- [ ] Browser network requests attach the admin token only to `/v1/admin/*`
      writes and the operator token only to other writes.
- [ ] Credentials disappear when the tab session is cleared.
- [ ] No token appears in screenshots, console output, committed files, or the
      built JavaScript bundle.

## Phase 4 — Automated live corroboration

Use a throwaway LocalNet for self-contained probes. Use the shared validator
only with dedicated parties/pools and explicit approval to leave test state.
Export each script's full environment from the [Testing
reference](../reference/testing.md#live-canton-probes), then run from
`services/operator-backend`:

```bash
CANTON_LIVE_RFQ=1 npm run test:live:rfq
npm run live:roundtrip
npm run testnet:seed-pool
npm run live:matched-trade
```

- [ ] RFQ test checks exact RFQ/quote/trade CIDs and the stored policy receipt.
- [ ] AMM round trip prints its unique run id and passes exact add, swap, and
      partial-remove reserve/holding/slice/LP assertions plus the documented
      invariant and conservation checks.
- [ ] Existing-pool probe passes add/swap reserve, holding, slice, and invariant
      assertions against the selected dedicated pool.
- [ ] Matched-trade probe passes the sender/receiver holding assertions.
- [ ] Results are mapped only to the boundaries in the table at the top; in
      particular, the direct JSON API round trip is not cited as evidence for
      the backend HTTP, browser, or real-wallet transport.

## Phase 5 — Browser trader and admin flows

For each scenario, capture the wallet approval, backend request id, resulting
ledger update/contract ids, and the refreshed UI state. Use small test amounts.

### Admin

- [ ] Create or select a dedicated test pair and pool with the admin credential.
- [ ] Update its supported fee/trading configuration and observe it on the next
      GET.
- [ ] Repeat one write without the admin credential and observe 401.

### Order lifecycle

- [ ] Place a non-crossing order; the wallet signs the trader-authorized
      funding transaction and the order appears in `/v1/orders`.
- [ ] Cancel it and verify the active contract disappears.
- [ ] Place crossing buy/sell orders using two test traders, run the match route,
      and verify the resulting fill/history and balances.

### Swap

- [ ] Obtain a positive quote for a small input.
- [ ] Approve and submit the wallet intent, then verify input/output balances and
      the exact reserve transition.
- [ ] Verify the swap/history projection after at least one indexer interval.

### Add liquidity

- [ ] The request route creates one `LiquidityAllocationRequest`.
- [ ] The wallet authors base-deposit, quote-deposit, and LP-receipt
      allocations.
- [ ] The settle route consumes the request/allocations atomically; reserves and
      LP supply increase by the expected values and the LP holding is visible.

### Remove liquidity

- [ ] The request route creates a remove `LiquidityAllocationRequest`.
- [ ] The wallet authors base-receipt, quote-receipt, and LP-burn allocations.
- [ ] Settle reduces reserves and LP supply by the expected values and delivers
      base/quote holdings to the LP.

The automated AMM round trip corroborates remove-liquidity directly through
the JSON Ledger API. This manual scenario is still required to establish the
different boundary under review here: browser state, backend authorization,
wallet approval/transport, and the deployed party-rights configuration.

### RFQ

- [ ] Trader creates an RFQ and a whitelisted dealer posts a quote from a
      separate authorized session.
- [ ] Trader/operator accept returns a verifying `PolicyReceipt`; the exact
      receipt is stored on the resulting `MatchedTrade`.
- [ ] Fund and settle the matched trade, then verify both assets moved. The live
      RFQ automated test stops before this step and cannot substitute for it.
- [ ] Create an already-expired fixture through an approved test setup, invoke
      the deployment's RFQ sweep job, and verify the operator archives it. The
      reference exposes `sweepExpired` as a service method but does not include
      a standalone scheduler/CLI, so mark this **Blocked** if the deployment has
      no job entrypoint.

## Phase 6 — Failure handling and observability

- [ ] Malformed JSON returns 400 with `code:"bad_request"` and a request id.
- [ ] A body over 1 MiB returns 413 with `code:"payload_too_large"`.
- [ ] A supplied `X-Request-Id` is echoed; otherwise the server creates one.
- [ ] Request logs contain request id, method, path, status, and duration.
- [ ] Ledger/authorization failures preserve a useful structured error without
      leaking JWTs or API tokens.
- [ ] Send SIGTERM to the backend process, observe graceful HTTP/indexer/DB
      shutdown, restart with the same `DB_PATH`, and verify status/history.

Do not claim crash/idempotency recovery from the restart check alone. A
mid-submission fault requires a controlled fault-injection harness and evidence
that only one ledger update committed; mark it **Blocked** if that harness is
not available.

## Phase 7 — Frontend failure states

- [ ] Disconnect/reject during a transaction shows a clear retryable error.
- [ ] Refresh after disconnect returns to a clean Connect Wallet state.
- [ ] Stop the backend temporarily; each page shows a bounded error state and
      recovers after the backend restarts.
- [ ] An authorization failure is distinguishable from wallet rejection and
      from ledger validation failure.

## Phase 8 — Docker Compose, if deployed that way

Run from the repository root with all Compose variables exported:

```bash
docker compose up --build
```

- [ ] Backend starts in the intended full/read-only mode; neither API token is
      blank in full mode.
- [ ] Frontend on port 80 proxies `/v1/*` to the backend.
- [ ] `docker compose restart backend` retains indexer state in the named
      volume.
- [ ] `ALLOWED_ORIGINS` is restricted to the deployed dApp origin.
- [ ] Secrets are injected at runtime and absent from the frontend image/bundle.

## Cleanup and sign-off

- [ ] Cancel every still-cancellable RFQ, quote, order, allocation request, and
      matched trade created by the test.
- [ ] Record contracts that cannot be cleaned up safely (for example the
      accepted RFQ test's unmatched trade) and the owner responsible.
- [ ] Stop/remove the throwaway LocalNet. For shared testnet state, do not delete
      or mutate contracts outside the recorded run ids and dedicated pool.
- [ ] Remove tokens from `sessionStorage`, shell history where applicable, and
      temporary environment files; revoke short-lived credentials.
- [ ] Attach the Pass/Fail/Blocked/N/A matrix and evidence links to the release
      record. Any required **Fail** or **Blocked** scenario prevents sign-off.

---

**Where to read next:** [Run on a Testnet](run-on-testnet.md) · [Operator Runbook](operator-runbook.md) · [Testing reference](../reference/testing.md) · [All docs](../README.md)
