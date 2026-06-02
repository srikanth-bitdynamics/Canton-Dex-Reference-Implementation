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

Holdings for the owner. **400** if `owner` is missing.

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
// request
{ "poolId": "ContractId<Pool>", "inputInstrumentId": "BTC", "inputAmount": "0.5" }
// response
{ "outputAmount": "9852.143..." }
```

Advisory; the on-ledger `PoolRules_Swap` choice re-validates with the latest
reserves.

## Write Endpoints

All POST endpoints return **400** for malformed JSON or missing required
fields, **413** if the body exceeds 1 MiB.

### `POST /v1/rfq`

Create an RFQ on a trader's behalf.

```json
{ "trader": "...", "rfqId": "...", "pair": "BTC/USDC", "side": "Buy",
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

## Admin Endpoints

All `/v1/admin/*` write endpoints (PUT, DELETE) require the
`Authorization: Bearer <OPERATOR_ADMIN_TOKEN>` header. **401** otherwise.

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
