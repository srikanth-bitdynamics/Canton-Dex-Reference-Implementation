# Local Setup & Testing

One page to clone, build, run, test, and explore the **whole** reference DEX on
your machine — the Daml core, the operator backend, the dApp, and the scripts.
The local path needs **no Canton participant**: the dev backend ships an
in-memory ledger, so you can have the full stack up in a few minutes.

> TL;DR
> ```bash
> git clone https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation.git && cd Canton-Dex-Reference-Implementation
> bash scripts/run-local-daml-tests.sh                                 # Daml build + tests
> (cd services/operator-backend && npm ci && npm run dev)              # backend → :8080
> (cd app/web && cp .env.example .env.local && npm ci && npm run dev)  # dApp   → :5173
> ```

## What's in the repo

| Path | Component | Stack |
|---|---|---|
| `trading/` | `canton-dex-trading` Daml package — pool/swap/LP, orders, RFQ, matched-trade, reference V2 registry | Daml 3.4 |
| `trading-tests/` | in-script test suites for the Daml core | Daml |
| `examples/stable-pool/` | a separate consumer of the package (reuse proof) | Daml |
| `services/operator-backend/` | operator HTTP API, JSON-LAPI driver, idempotency, indexer, recovery; in-memory dev ledger | TypeScript / Node |
| `app/web/` | the dApp — Trade / Pools / Orders / RFQ / Portfolio / Admin + wallet layer | TypeScript / React / Vite |
| `scripts/` | build, smoke, registry-bootstrap, and LocalNet/testnet drivers | bash / ts-node |
| `vendor/splice/token-standard/` | vendored Token Standard V2 sources the build turns into local DARs | Daml |
| `docs/` | architecture, workflows, operator runbook, deployment, this page | — |

## Prerequisites
| Tool | Version | For |
|---|---|---|
| Daml SDK | **3.4.11** (`daml install 3.4.11`) | building + testing the Daml core |
| Node.js | **24+** | backend + dApp |
| npm | 10+ | install/test |
| (optional) Docker | recent | only for the real-Canton paths below |

Vendored Token Standard V2 sources are already in
`vendor/splice/token-standard/`; no extra download is needed. The local build
script compiles those sources into the `*-current.dar` files consumed by the
DEX package.

---

## 1. Daml core — `trading/`

```bash
bash scripts/run-local-daml-tests.sh
```
This builds the vendored Token Standard DARs, builds the `canton-dex-trading`
DAR, and runs the suites. Or by hand:

```bash
bash scripts/build-vendored-token-standard.sh
(cd trading              && daml build)      # produces canton-dex-trading-0.1.0.dar
(cd trading-tests        && daml test)       # expect: ~70 scripts "ok"
(cd examples/stable-pool && daml test)       # expect: 3 "ok"  (reuse proof)
```
This exercises the V2-native templates (pool/swap/LP, orders, RFQ,
matched-trade), the reference registry (`Registry/V2.daml`) implementing V2
Holding/Allocation/Settlement, and the conservation/invariant tests.

---

## 2. Operator backend — `services/operator-backend/`

In-memory dev ledger, no Canton needed:
```bash
cd services/operator-backend
npm ci
npm run dev            # listens on http://localhost:8080
```
On boot it seeds a demo BTC/USDC pair + pool and a demo trader with holdings.
Smoke it:
```bash
curl -s http://localhost:8080/v1/pairs | python3 -m json.tool
curl -s http://localhost:8080/v1/pools | python3 -m json.tool
```
> Port note: `localhost:8080` can collide with Docker’s IPv6 bind on macOS. If
> `/v1/pairs` returns "method not allowed", run on another port and point the
> dApp at it: `PORT=8091 npm run dev` and set `VITE_API_BASE=http://127.0.0.1:8091`.

Tests + typecheck:
```bash
npm run typecheck      # tsc, clean
npm test               # node:test, ~77 pass / 0 fail
```

---

## 3. dApp — `app/web/`

```bash
cd app/web
cp .env.example .env.local      # then edit (see Wallets below)
npm ci
npm run dev                     # Vite dev server → http://localhost:5173
```
Open `http://localhost:5173` → the Trade / Pools / Orders / RFQ / Portfolio /
Admin pages render the seeded backend state. Connect **Mock Wallet (dev)** to
exercise the full trade/LP/order flows with deterministic cids and no external
wallet.

Tests:
```bash
npm test                        # vitest, ~58 pass
```

### Wallet options (set in `app/web/.env.local`)
| Provider | Enable | Notes |
|---|---|---|
| **Mock (dev)** | (always available in dev) | deterministic cids; best for local UI testing |
| **WalletConnect** | `VITE_WC_PROJECT_ID=<reown id>` | web3-native path; get an id at cloud.reown.com |
| **CIP-0103 SDK** | `VITE_ENABLE_SDK=1` | `@canton-network/dapp-sdk`; needs a CIP-0103 wallet |
| **PartyLayer** | `VITE_ENABLE_PARTYLAYER=1` | `VITE_PARTYLAYER_WALLET_IDS=console,nightly,send[,loop]` |
| Token-standard relay | dev builds only | operator co-signs; labelled "dev only" — not for prod |

Backend API base is `VITE_API_BASE` (default `http://localhost:8080`).

---

## Scripts reference (`scripts/`)
| Script | What it does |
|---|---|
| `run-local-daml-tests.sh` | build the DAR + run the Daml test suites |
| `e2e-smoke.sh` | quick end-to-end smoke across the stack |
| `bootstrap-registry.ts` | create reference-registry `InstrumentConfiguration` + factories for BTC/USDC/ETH and LP instruments |
| `localnet-dvp-e2e.ts` | LP add / swap / remove DvP round-trip on a LocalNet (`npm run localnet:dvp-e2e` from the backend) |
| `testnet-v2registry-trade.ts` | drive a V2 registry trade against a testnet participant |
| `build-vendored-token-standard.sh` | (re)build the vendored TSv2 DARs |
| `build-trading-surface.sh` | build the `canton-dex-trading` surface |
| `deploy-testnet.sh` | upload the DAR + seed a pair/pool on a testnet participant |

---

## Running the full test suite
| Component | Command | Expected |
|---|---|---|
| Daml core | `cd trading-tests && daml test` | ~70 ok |
| Daml reuse example | `cd examples/stable-pool && daml test` | 3 ok |
| Backend | `cd services/operator-backend && npm run typecheck && npm test` | clean; ~77 pass |
| dApp | `cd app/web && npm test` | ~58 pass |
| End-to-end (in-memory) | `bash scripts/e2e-smoke.sh` | green |

### Milestone verification
For the Dev Fund milestone reviewers, the same commands map to the deliverables:

| Milestone | What it covers | Verify with |
|---|---|---|
| **M1** — Daml core on Token Standard V2 | templates, reference V2 registry, DvP + conservation | `daml test` in `trading-tests` (~70 ok) + `examples/stable-pool` (3 ok) |
| **M2** — operator backend + dApp + wallet | HTTP API + logic; UI; wallet handoff | backend `npm test` (~77), dApp `npm test` (~58) + open :5173; `npm run localnet:dvp-e2e` for the LP→swap→remove round-trip |

---

## Optional: run against a real Canton ledger
The dev backend is in-memory. To run on real Canton:
- **LocalNet** — a self-contained Canton + Splice network on one host; build the
  DAR, upload it + the V2 DARs, seed a pair/pool, point the backend at the
  participant (`CANTON_LEDGER_URL`), and run `npm run start`. See
  `docs/guides/deployment.md`.
- **Testnet** — `scripts/deploy-testnet.sh` uploads the DAR + seeds; record the
  vetted package id + seed CIDs in `docs/guides/run-on-testnet.md`.

---

## Troubleshooting
| Symptom | Fix |
|---|---|
| backend `/v1/*` → "method not allowed" | Docker owns `:8080`; use `PORT=8091 npm run dev` + `VITE_API_BASE=http://127.0.0.1:8091` |
| dApp can’t reach backend (CORS) | start backend with `ALLOWED_ORIGINS=http://localhost:5173` |
| dev relay wallet needs a party | set `VITE_CANTON_DEFAULT_PARTY=trader-demo` (dev only) |
| `daml: command not found` | `daml install 3.4.11` and re-open the shell |
| Daml CLI prints a "DPM" deprecation warning on every build | informational only; `daml build` remains the supported path for this repo |
| stale `node_modules` after branch switch | `rm -rf node_modules && npm ci` |

See also: [Overview](concepts/overview.md), [Architecture](concepts/architecture.md),
[Workflows](concepts/workflows.md), the [Builder Guide](guides/builder-guide.md)
workflow tour, [Operator Runbook](guides/operator-runbook.md), and the full
[documentation index](README.md).
