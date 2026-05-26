# Deployment Guide

How to deploy the Canton DEX reference implementation. Three deployment
paths are supported: **Docker Compose**, **local dev** (in-memory ledger),
and **direct testnet** (real Canton participant).

## 1. Local Dev (no Canton required)

For UI development. Uses the `InMemoryLedger` and seeds a BTC/USDC pair
and pool.

```bash
# backend
cd services/operator-backend
npm install
npm run dev                # listens on :8080

# frontend (separate terminal)
cd app/web
npm install
cp .env.example .env.local # set VITE_API_BASE=http://localhost:8080
npm run dev                # listens on :5173
```

No Canton participant needed. All writes go through stub choice handlers
in `services/operator-backend/src/dev-server.ts`.

## 2. Docker Compose

For deployments against a remote Canton testnet/MainNet, packaged for
ops. Brings up:

- `backend` (operator-backend, port 8080) running `testnet-server.ts`.
- `frontend` (nginx, port 80) serving the Vite build, proxying `/v1/*`
  to the backend.

```bash
cp services/operator-backend/.env.example .env
# Edit .env with CANTON_LEDGER_URL, CANTON_LEDGER_TOKEN, party ids, etc.

docker-compose build
docker-compose up -d
```

Persistent state lives in the `backend-data` volume (SQLite indexer DB).
To wipe and restart fresh: `docker-compose down -v && docker-compose up -d`.

## 3. Testnet Deployment

Direct deployment without containers. Same path as docker-compose's
backend service but you manage the Node process yourself (systemd, pm2,
fly.io, etc.).

```bash
cd services/operator-backend
npm install
export CANTON_LEDGER_URL=...
export CANTON_LEDGER_TOKEN=...
# ... (see .env.example for the full list)
npm start
```

### One-time bootstrap

Before the operator backend can serve trades, the registry must have
the right contracts on-ledger. Run the bootstrap script once per
ledger:

```bash
export CANTON_LEDGER_URL=...
export CANTON_LEDGER_TOKEN=...
export CANTON_ADMIN=...
export CANTON_LP_REGISTRAR=...
node --import tsx scripts/bootstrap-registry.ts
```

The script is idempotent — running it twice is a no-op. See
[docs/registry-prerequisites.md](registry-prerequisites.md) for what
contracts are created and why.

## Environment Variables

See `services/operator-backend/.env.example` and `app/web/.env.example`
for the canonical list. Required for production:

| Var | Purpose |
|-----|---------|
| `CANTON_LEDGER_URL` | JSON Ledger API base URL |
| `CANTON_LEDGER_TOKEN` | Bearer JWT for the participant |
| `CANTON_OPERATOR` | Operator party id |
| `CANTON_LP_REGISTRAR` | LP registrar party id |
| `CANTON_ADMIN` | Asset admin party id |
| `CANTON_ALLOC_FACTORY_CID` | AllocationFactory contract id |
| `CANTON_SETTLE_FACTORY_CID` | SettlementFactory contract id |
| `OPERATOR_ADMIN_TOKEN` | Admin auth token for `/v1/admin/*` |
| `ALLOWED_ORIGINS` | CSV of CORS origins to allow |

## Production Checklist

- [ ] `OPERATOR_ADMIN_TOKEN` set to a strong random value
- [ ] `ALLOWED_ORIGINS` narrowed to your dApp host (not `*`)
- [ ] SQLite DB path on persistent volume (`DB_PATH=/var/lib/dex/operator.db`)
- [ ] Process supervisor configured to restart on crash (systemd / pm2 / docker restart)
- [ ] Reverse proxy in front of `:8080` terminating TLS
- [ ] Backups configured for the indexer DB (it carries trade history and idempotency keys)
- [ ] Bootstrap script run once per ledger
- [ ] Monitoring: scrape logs from stdout/stderr; alert on `level: error` lines
