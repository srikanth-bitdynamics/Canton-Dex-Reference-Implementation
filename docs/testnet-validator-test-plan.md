# Canton Testnet Validator — Live Test Plan

End-to-end test plan for validating the Canton DEX reference
implementation against a live Canton testnet validator.

## Goals

1. Confirm all wallet provider paths (Token Standard, WalletConnect,
   Direct, Mock) connect against a real participant.
2. Verify every trader-authority intent translates correctly into
   on-ledger V2 Token Standard transactions.
3. Confirm operator-driven flows (RFQ accept, Pool_Swap, order
   binding/funding, remove-liquidity) settle through the
   AllocationFactory + SettlementFactory.
4. Validate indexer + history endpoints reflect on-ledger state.
5. Stress-test idempotency and graceful shutdown.

## Prerequisites

- Canton testnet validator with JSON Ledger API reachable (e.g.,
  `https://canton-testnet.example.com:7575`).
- A bearer JWT issued for `ledger-api-user` with rights to act-as the
  operator, lpRegistrar, admin, and demo trader parties.
- The synchronizer id (e.g., `global-domain::1220...`).
- Docker / Docker Compose installed on the test runner host.
- `daml` CLI installed (SDK 3.4.11).
- All env vars in `services/operator-backend/.env.example` populated.

## Phase 0 — Build & upload DARs

```bash
export CANTON_LEDGER_URL=...
export CANTON_LEDGER_TOKEN=...
export CANTON_OPERATOR=...
export CANTON_LP_REGISTRAR=...
export CANTON_ADMIN=...

./scripts/deploy-testnet.sh
```

Expected:
- `daml build` succeeds; `.daml/dist/canton-dex-*.dar` exists.
- DARs upload to participant (HTTP 200 from `/v2/packages`).
- Parties allocated (or pre-existing).
- `scripts/bootstrap-registry.ts` reports each instrument and LP
  config as "created" (or "already configured" on a re-run).

## Phase 1 — Backend boot

```bash
cd services/operator-backend
npm install
npm start
```

Expected logs (JSON, one per line):
```
{"ts":"...","level":"info","msg":"server started","component":"testnet-server","url":"...","ledger":"..."}
```

Health checks:
- [ ] `curl http://localhost:8080/v1/status` returns `{network, slot, synced:true}`
- [ ] `curl http://localhost:8080/v1/context` returns operator/admin/lpRegistrar + factory CIDs
- [ ] `curl http://localhost:8080/v1/pools` returns `[]` (no pools yet) or seeded pools

## Phase 2 — Frontend boot

```bash
cd app/web
cp .env.example .env.local
# Set:
#   VITE_API_BASE=http://localhost:8080
#   VITE_CANTON_LEDGER_URL=$CANTON_LEDGER_URL
#   VITE_CANTON_AUTH_TOKEN=$CANTON_LEDGER_TOKEN
#   VITE_CANTON_NETWORK_ID=canton:testnet
#   VITE_WC_PROJECT_ID=...   (optional, for WalletConnect)
npm install
npm run dev
```

Open <http://localhost:5173>. Smoke checks:
- [ ] All 6 pages render without crash (TradePage, Pools, Orders, RFQ,
      Portfolio, Admin)
- [ ] Error boundaries do NOT trigger (no red banners)
- [ ] Connect Wallet menu shows: Token Standard, WalletConnect (if
      configured), Mock (DEV only — should be absent in prod build)

## Phase 3 — Wallet provider validation

### 3.1 Token Standard provider
- [ ] Click "Connect Wallet" → Token Standard
- [ ] Connection succeeds; party id displayed
- [ ] Reload page; session persists, no re-prompt
- [ ] Click Disconnect; localStorage `canton-dex:token-standard:session` cleared

### 3.2 WalletConnect (if `VITE_WC_PROJECT_ID` set)
- [ ] Connect → QR modal opens, scannable
- [ ] After mobile wallet pairing, primary party returned
- [ ] Cancel during pairing surfaces error message, NOT a stuck state

### 3.3 Direct Canton (advanced fallback)
- [ ] With `VITE_CANTON_LEDGER_URL` + `VITE_CANTON_AUTH_TOKEN` set,
      Direct Canton appears in the menu
- [ ] Connect succeeds via `/v2/users/current`

## Phase 4 — Operator admin operations

Requires `OPERATOR_ADMIN_TOKEN`.

- [ ] Create new pair (DOGE/USDC) via Admin page → 200, pair listed
      via `GET /v1/pairs`
- [ ] Toggle pair active/inactive → state reflected on next GET
- [ ] Update fee model → new fees take effect
- [ ] Create pool for DOGE/USDC → 200, pool listed via `GET /v1/pools`
- [ ] Admin write WITHOUT bearer token → 401 with structured error
      envelope

## Phase 5 — Trader flows

### 5.1 Place order
- [ ] Submit a buy order for BTC/USDC at limit price < current ask
- [ ] Wallet intent translates to OrderFundingRequest creation
- [ ] Operator backend observes and binds via OrderFundingRequest_Bind
- [ ] Order appears in `GET /v1/orders?trader=...`

### 5.2 Order matching
- [ ] Place a crossing sell order (price ≤ existing buy)
- [ ] `POST /v1/orders/match {base,quote}` returns 1 match
- [ ] After settle, both orders archived (or remaining qty updated for partial)
- [ ] MatchedTrade appears in `GET /v1/trades`

### 5.3 Pool swap
- [ ] Quote: `POST /v1/swaps/quote` returns positive output for 0.01 BTC
- [ ] Submit swap intent through wallet → on-ledger Pool_Swap exercised
- [ ] Pool reserves update; swap appears in `GET /v1/swaps`

### 5.4 Add liquidity (two-call DvP)
- [ ] `POST /v1/pools/add-liquidity/request` → operator creates a
      LiquidityAllocationRequest
- [ ] Wallet authors the base-deposit, quote-deposit, and LP-receipt
      allocations via AllocationFactory_Allocate
- [ ] `POST /v1/pools/add-liquidity/settle` → operator + lpRegistrar
      settle (LpDvpRules_SettleAddLiquidity); funds enter the pool and
      LP tokens are minted to the LP atomically
- [ ] LP tokens minted (visible in Portfolio page LP section)
- [ ] Pool reserves grow proportionally

### 5.5 Remove liquidity (two-call DvP)
- [ ] `POST /v1/pools/remove-liquidity/request` → operator creates a
      LiquidityAllocationRequest
- [ ] Wallet authors the holder's base-receipt + quote-receipt + LP
      burn-sender allocations
- [ ] `POST /v1/pools/remove-liquidity/settle` → operator + lpRegistrar
      settle (LpDvpRules_SettleRemoveLiquidity); base + quote are
      delivered to the holder and the LP tokens burn to the burn
      account atomically

### 5.6 RFQ
- [ ] Trader creates RFQ via `POST /v1/rfq`
- [ ] Dealer posts a quote (separate wallet session)
- [ ] Trader+operator co-sign accept via `POST /v1/rfq/accept`
- [ ] PolicyReceipt returned and matches verifyReceipt()
- [ ] After expiry, `sweepExpired` cancels stale RFQs (verify via
      logs after manually setting an RFQ's expiry in the past)

## Phase 6 — Credentials enforcement

- [ ] Configure an instrument with `holderRequirements` (e.g., a
      KYC credential)
- [ ] Trader without the credential attempts to trade → backend rejects
      OR CredentialStatus banner shows the missing claim
- [ ] Issue the credential via the registry; trader retries → succeeds

## Phase 7 — Resilience

- [ ] Send SIGTERM to backend; logs show graceful shutdown
      (indexer stop → http close → db close)
- [ ] Restart backend; indexer resumes from last persisted offset
- [ ] Crash backend mid-submission; idempotency table prevents
      duplicate commit on restart
- [ ] Submit malformed JSON to `/v1/swaps/quote` → 400 with `code: bad_request`
- [ ] Submit oversized body (>1 MiB) → 413 with `code: payload_too_large`

## Phase 8 — Observability

- [ ] Every request log line has `requestId`, `method`, `path`,
      `status`, `durationMs`
- [ ] Every error log line goes to stderr (verify by redirecting)
- [ ] `X-Request-Id` header echoed back when supplied; generated otherwise

## Phase 9 — Frontend regression

- [ ] Error boundary triggered by throwing in a child component
      surfaces the retry card without taking down the page shell
- [ ] Disconnect mid-transaction shows clear error message
- [ ] Page refresh after disconnect → no auto-reconnect, clean
      "Connect Wallet" state

## Phase 10 — Docker compose deployment

- [ ] `docker-compose up` brings both services up
- [ ] Frontend at port 80 proxies `/v1/*` to backend
- [ ] `docker-compose restart backend` does not lose indexer state
      (volume persistence)
- [ ] CORS narrowed when `ALLOWED_ORIGINS` set

## Sign-off

Mark this plan ✅ once every checkbox above is verified against a
real Canton testnet validator.
