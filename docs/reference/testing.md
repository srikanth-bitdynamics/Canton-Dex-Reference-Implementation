# Canton-backed end-to-end integration test

Replaces the in-memory test harness with a real ledger driver
(`services/operator-backend/src/ledger/json-api.ts`) and a test that
runs the operator backend's RFQ accept flow against a live Canton
participant.

## What it verifies

The test covers the same ground as the existing `rfq.test.ts`
(`InMemoryLedger`-driven), but going through the **real Daml engine**
on a Canton participant via the JSON Ledger API:

- `JsonApiLedger.submit` correctly serializes `submit-and-wait`
  envelopes with `actAs`, `commandId`, and `disclosedContracts`.
- `Rfq` and `RfqQuote` creates land on-ledger.
- `RfqService.accept` co-submits `Rfq_Accept` under
  `[trader, operator]`; the choice computes its own ranking +
  receipt and creates a `MatchedTrade` whose
  `policyReceipt` matches what the operator backend computed
  off-chain.
- `verifyReceipt` (digest replay) holds against the on-chain receipt.

The test is gated on `CANTON_E2E=1` so it stays out of the default
test run. Local runs against a sandbox take ~30s including Canton
boot.

## Prerequisites

- `daml` CLI ≥ 3.4 on `$PATH`.
- The `canton-dex-trading` DAR built (`cd trading && dpm build`).

## Run

### 1. Boot a sandbox with the DEX DARs

```bash
daml sandbox \
  --port 6865 \
  --json-api-port 7575 \
  --dar trading/.daml/dist/canton-dex-trading-0.1.0.dar \
  --dar trading/.daml/dist/splice-api-token-allocation-v2-current.dar \
  --dar trading/.daml/dist/splice-api-token-allocation-instruction-v2-current.dar \
  --dar trading/.daml/dist/splice-api-token-allocation-request-v2-current.dar \
  --dar trading/.daml/dist/splice-api-token-holding-v2-current.dar \
  --dar trading/.daml/dist/splice-api-token-metadata-v1-current.dar
```

(In practice the DAR depends on the others; uploading the top one
typically pulls them in. The list above is explicit so the test
won't fail on a missing dependency.)

### 2. Allocate parties and obtain a JWT

```bash
# allocate
daml ledger allocate-parties operator alice orca jump btc-admin

# request a JWT for the operator (covers all parties via wildcard
# claims). Production deployments use a proper IAM.
daml-helper request-token --party operator > /tmp/operator.jwt
```

### 3. Run the test

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

Expected output — the three Canton E2E cases (enabled by `CANTON_E2E=1`)
within the full backend suite:

```
✔ Canton E2E: RFQ accept produces MatchedTrade with PolicyReceipt
✔ Canton E2E: rfq.list returns visible RFQs and quotes
✔ Canton E2E: rfq.cancel archives an open Rfq
```

`npm test --prefix services/operator-backend` runs the entire backend
suite (~100 tests); the three lines above are the Canton-participant
cases. To run only the E2E file, replace the `npm test` line with
`node --import tsx --test services/operator-backend/test/canton-e2e.test.ts`.

When `CANTON_E2E` is unset (or anything other than `1`), the Canton
test is automatically skipped:

```
﹣ Canton E2E (skipped: set CANTON_E2E=1 to enable) # SKIP
✔ RFQ accept end-to-end through operator backend
```

## How the JsonApiLedger driver maps to the JSON Ledger API

| `LedgerSubmitter` method | JSON API call |
|---|---|
| `submit` (create) | `POST /v2/commands/submit-and-wait` with `CreateCommand` |
| `submit` (exercise) | `POST /v2/commands/submit-and-wait` with `ExerciseCommand` |
| `submit` (exerciseInterface) | `POST /v2/commands/submit-and-wait` with `ExerciseByInterfaceCommand` |
| `query` | `POST /v2/state/active-contracts` |
| `subscribe` | `GET /v2/updates/flats` (SSE) |

Errors are mapped from the JSON API's `{ errors: [...] }` body to
typed `LedgerError` instances. Contention errors (HTTP 409 / GRPC
ABORTED with substrings `contention` or `inconsistent`) are tagged
retryable so `retryOnContention` recovers automatically.

## Authentication notes

- The `CANTON_JSON_API_TOKEN` should grant `actAs` for every party
  the test submits as: operator, trader, both dealers, and the asset
  admin.
- Production deployments use a proper IAM that issues per-session
  tokens; `daml-helper request-token` is for local dev only.
- The token is passed as `Authorization: Bearer ...` on every
  request.

## What this test does NOT cover

- Pool initialization + add liquidity + swap end-to-end on a live
  ledger. The `testPoolFullLifecycle` and `testPoolSwapEndToEnd`
  Daml Script tests (`trading-tests/`) cover the same ground at the
  on-chain level; a JSON Ledger API version can be added as an
  additional integration test.
- Order placement through the `OrderFundingRequest` →
  `OrderAllocationRequest` → trader-Accept → `Order_Fund` flow with
  a real wallet. The wallet handoff lives in
  `app/web/src/wallet/handoff.ts`; the integration test for that
  needs a wallet emulator.
- The full registry HTTP API. The current test stubs `getFactories`
  because the RFQ accept flow doesn't read factory CIDs. Tests that
  exercise pool swaps will need a real registry-backed factory.

## Debugging

When a Canton test fails, the JSON API's response body is the most
useful artifact. The driver puts it in the `LedgerError.detail`. To
see full request/response wire traffic, set:

```bash
NODE_DEBUG=http,fetch CANTON_E2E=1 ... npm test
```

Common failure modes:

| Symptom | Cause |
|---|---|
| `401: invalid token` | JWT expired or scoped to wrong party set |
| `404: template not found` | DAR not uploaded, or operator party can't see it |
| `409: contention` | Submission stale; the driver retries automatically |
| `400: requires authorizer X` | `actAs` doesn't include all parties the choice needs |

---

**Where to read next:** [Getting Started](../getting-started.md) · [Validator Test Plan](../guides/validator-test-plan.md) · [All docs](../README.md)
