# Operator Backend API Reference

All endpoints are served from the operator-backend HTTP shim at the
configured port (default 8080). Every response is JSON. Error responses
have the shape:

```json
{
  "error": "human-readable message",
  "code": "machine-readable code",
  "details": { "...optional context": "..." },
  "requestId": "uuid"
}
```

Every response also carries the `X-Request-Id` header (echoed from the
request if supplied, otherwise generated).

## Read Endpoints

### `GET /v1/context`

Returns `DexContext` — the static parties and factory CIDs the dApp
needs to build trader-authority intents.

```json
{
  "operator": "...",
  "lpRegistrar": "...",
  "admin": "...",
  "allocationFactoryCid": "...",
  "settlementFactoryCid": "...",
  "network": "canton:devnet"
}
```

### `GET /v1/status`

Health + slot snapshot.

```json
{ "network": "canton:devnet", "slot": 1234567, "synced": true, "serverTime": "2026-05-17T..." }
```

### `GET /v1/pools` → `Pool[]`

All active pools. `Pool` shape defined in
`services/operator-backend/src/types.ts`.

### `GET /v1/pairs` → `DexPair[]`

All trading pairs (whether or not they have pools).

### `GET /v1/orders?trader=:party` → `Order[]`

Open orders for a specific trader. **400** if `trader` is missing.

### `GET /v1/holdings?owner=:party` → `Holding[]`

Holdings for the owner. **400** if `owner` is missing. Returns per-contract
(UTXO-style) rows, not an aggregated balance: a trader "balance" is the sum of
`amount` grouped by `instrumentId`, treating `locked` holdings separately from
free ones. Clients aggregate client-side.

### `GET /v1/trades?trader=&pair=&limit=` → indexer rows

Settled MatchedTrade history from the SQLite indexer. **503** if the
indexer is not configured.

### `GET /v1/swaps?pair=&limit=` → indexer rows

Pool swap history from the indexer.

### `GET /v1/rfq` → `{ rfqs: Rfq[], quotes: RfqQuote[] }`

All active RFQs and their quotes visible to the operator.

### `GET /v1/rfq/history?trader=&limit=` → indexer rows

Historical RFQ acceptances.

### `GET /v1/admin/config` → `Record<string, string>`

All operator config key-values.

## Quote Endpoint

### `POST /v1/swaps/quote`

```json
// request — supply `poolCid` (the pool ContractId). `poolId` is also accepted
// and resolves EITHER the ContractId OR the logical pool id (e.g. "BTC-USDC").
{ "poolCid": "#2:0", "inputInstrumentId": "BTC", "inputAmount": "0.5" }
// response — the output plus the fields a trading client would otherwise
// recompute from reserves + feeBps (all exact, no floats):
{
  "outputAmount": "9496.5947516312",
  "inputAmount": "0.5",
  "inputInstrumentId": "BTC",
  "outputInstrumentId": "USDC",
  "feeBps": 30,
  "feeAmount": "0.0015000000",      // fee actually applied to the input
  "executionPrice": "18993.18...",  // output per unit input
  "spotPrice": "20000.00...",       // pre-trade reserve mid
  "priceImpact": "0.0503...",       // (spot - execution) / spot
  "poolCid": "#2:0",
  "poolId": "BTC-USDC"
}
```

Advisory; the on-ledger `PoolRules_Swap` choice re-validates with the latest
reserves.

## Write Endpoints

All POST endpoints return **400** for malformed JSON or missing required
fields, **413** if the body exceeds 1 MiB.

### `POST /v1/rfq`

Create an RFQ on a trader's behalf.

```json
{ "trader": "...", "rfqId": "...", "pair": "BTC/USDC", "side": "RFQ_Buy",
  "size": "0.5", "expiresAt": "2026-...", "whitelist": [...], "createdAt": "..." }
```

### `POST /v1/rfq/:cid/cancel` → `204`

Cancel an open RFQ.

### `POST /v1/rfq/accept`

Operator + trader co-sign the accept. Returns `{ tradeCid, receipt }`.

### `POST /v1/orders/bind`, `POST /v1/orders/fund`, `POST /v1/orders/:cid/cancel`

Order lifecycle. See `services/operator-backend/src/order/index.ts` for
the input shapes (the HTTP shim is a thin pass-through).

### `POST /v1/pools/swap`

Operator-driven `PoolRules_Swap` exercise. The dApp first calls
`POST /v1/pools/swap/request`, passes the returned allocation spec +
choice context to the wallet, and then sends the wallet-created allocation
CID to this endpoint.

### `POST /v1/pools/add-liquidity/request`

Operator opens the add-liquidity flow by creating a
`LiquidityAllocationRequest`. The trader's wallet then authors the
base-deposit, quote-deposit, and LP-receipt allocations via
`AllocationFactory_Allocate`.

### `POST /v1/pools/add-liquidity/settle`

Operator + lpRegistrar settle (`PoolLiquidityRules_SettleAddLiquidity`): funds
enter the pool and LP tokens are minted to the LP, atomically.

### `POST /v1/pools/remove-liquidity/request`

Operator opens the remove-liquidity flow by creating a
`LiquidityAllocationRequest`. The trader's wallet then authors the
base-receipt, quote-receipt, and LP burn-sender allocations.

### `POST /v1/pools/remove-liquidity/settle`

Operator + lpRegistrar settle (`PoolLiquidityRules_SettleRemoveLiquidity`):
base + quote are delivered to the holder and the LP tokens burn to the
burn account, atomically.

## Authentication

**All state-changing routes require operator authorization** — not only
`/v1/admin/*`, but also the trader-facing writes (`/v1/pools/swap*`,
`/v1/rfq`, `/v1/orders/*`). They return **401** unless `DEX_OPERATOR_API_TOKEN`
is configured (send `Authorization: Bearer <token>`) or, on the in-memory dev
server only, `DEX_DEV_OPEN=1` is set. Read (GET) routes need no auth. Admin
routes additionally require the `OPERATOR_ADMIN_TOKEN`. See
[Local Setup → Exercising write paths](../getting-started.md#exercising-write-paths-in-demo-mode).

## Admin Endpoints

### `POST /v1/admin/pairs` → `{ pairCid }`
### `POST /v1/admin/pairs/:cid/fee-model` → `{ pairCid }`
### `POST /v1/admin/pairs/:cid/active` → `{ pairCid }`
### `POST /v1/admin/pairs/:cid/trading-mode` → `{ pairCid }`
### `POST /v1/admin/pools` → `{ poolCid }`
### `PUT /v1/admin/config` body `{ key, value }`
### `DELETE /v1/admin/config/:key`

## Wallet Intent Shapes

The frontend never calls the on-chain ledger directly for trader-
authority writes. Instead it hands intents to the active
`WalletProvider`. Intent shapes are defined in
`app/web/src/wallet/types.ts`:

| Intent | When |
|--------|------|
| `AcceptAllocationRequestIntent` | Trader allocates holdings for an open order or swap |
| `PlaceOrderIntent` | Trader places a new order |
| `RequestSwapIntent` | Trader initiates a pool swap |
| `AddLiquidityIntent` | Trader authors the base/quote/LP-receipt allocations for an add-liquidity request |
| `RemoveLiquidityIntent` | Trader authors the base/quote-receipt and LP burn-sender allocations for a remove-liquidity request |
| `PostRfqQuoteIntent` | Dealer posts a quote on an RFQ |
| `AcceptRfqIntent` | Trader accepts a dealer's quote (co-signed with operator) |

## Error Codes

| `code` | HTTP | Meaning |
|--------|------|---------|
| `bad_request` | 400 | malformed JSON, missing fields, invalid types |
| `unauthorized` | 401 | missing or invalid admin token |
| `not_found` | 404 | route or resource not found |
| `payload_too_large` | 413 | body > 1 MiB |
| `internal_error` | 500 | unexpected server error |


## Examples

All examples assume the local backend on `http://localhost:8080`. Reads need no
auth; `/v1/admin/*` writes need `Authorization: Bearer $OPERATOR_ADMIN_TOKEN`.

```bash
# Read: trading pairs, pools, and a trader's holdings
curl -s http://localhost:8080/v1/pairs   | python3 -m json.tool
curl -s http://localhost:8080/v1/pools   | python3 -m json.tool
curl -s "http://localhost:8080/v1/holdings?owner=$TRADER" | python3 -m json.tool

# Advisory swap quote (re-validated on-ledger by PoolRules_Swap)
curl -s -X POST http://localhost:8080/v1/swaps/quote \
  -H 'Content-Type: application/json' \
  -d '{"poolId":"<Pool cid>","inputInstrumentId":"BTC","inputAmount":"0.5"}'
# -> {"outputAmount":"9852.14..."}

# Create an RFQ on a trader's behalf
curl -s -X POST http://localhost:8080/v1/rfq \
  -H 'Content-Type: application/json' \
  -d '{"trader":"'"$TRADER"'","rfqId":"rfq-1","pair":"BTC/USDC","side":"RFQ_Buy",
       "size":"0.5","expiresAt":"2026-12-31T00:00:00Z","whitelist":[],"createdAt":"2026-07-01T00:00:00Z"}'
```

The `POST` bodies for the order lifecycle (`/v1/orders/bind`, `/v1/orders/fund`),
the pool DvP settle endpoints, and `/v1/admin/*` are the pass-through inputs
defined in `services/operator-backend/src/{order,pool,matched-trade,admin}/index.ts`.

---

**Where to read next:** [Builder Guide](../guides/builder-guide.md) · [Choice Context](../guides/choice-context.md) · [All docs](../README.md)
