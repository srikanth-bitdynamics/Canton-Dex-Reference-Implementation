# Canton DEX — Reference Implementation

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Daml SDK](https://img.shields.io/badge/Daml-3.4.11-orange.svg)](https://daml.com)
[![Token Standard](https://img.shields.io/badge/Canton-Token_Standard_V2-blueviolet.svg)](https://github.com/canton-network/splice)
[![Status](https://img.shields.io/badge/status-reference-success.svg)](#project-status)

**A complete, runnable DEX on Canton, built directly on Token Standard V2.**
Constant-product pools, prefunded orders, RFQ block trades, LP tokens —
all on-ledger, all V2-native, all open source under Apache 2.0.

This is a builder's reference, not a research demo: every flow that the
UI shows settles end-to-end through real Daml choices, registry-defined
allocations, and the same TradingAppV2 batch settlement pattern that
Canton-Net teams will use in production.

---

## What you get

| Layer | What | Where |
|---|---|---|
| **Daml templates** | DexPair, Pool, Order, Rfq, MatchedTrade, LPToken, V2 Registry | [`trading/CantonDex/`](trading/CantonDex/) |
| **Daml tests** | 26+ multi-party Daml-Script tests + token-standard harness | [`trading-tests/`](trading-tests/) |
| **Operator backend** | Node + TypeScript, JSON Ledger API, SQLite indexer, idempotency | [`services/operator-backend/`](services/operator-backend/) |
| **React frontend** | Vite, TanStack Query, WalletConnect + Token Standard wallet | [`app/web/`](app/web/) |
| **Testnet harnesses** | Real-asset matched-trade + V2-registry trade smoke tests | [`scripts/testnet-*.ts`](scripts/) |
| **Documentation** | Architecture, workflows, quickstart, runbook, builder guide | [`docs/`](docs/) |

---

## Who is this for

- **Builders** of a DEX, broker-dealer, or settlement venue on Canton.
  Fork the repo and replace what you need to keep — the Daml templates,
  the operator backend, or the frontend.
- **Reviewers** validating Token Standard V2 patterns end-to-end with
  multi-party Daml-Script tests and a real frontend.
- **Operators** who want a concrete deploy-recover-observe runbook
  rather than slideware.
- **Wallet teams** wiring CIP-0103 / Token Standard wallet provider
  contracts against a working dApp.

---

## Try it in 5 minutes

```bash
# 1. Clone + install
git clone https://github.com/canton-foundation/canton-dex
cd canton-dex
(cd services/operator-backend && npm install)
(cd app/web && npm install)

# 2. Run the operator backend (in-memory ledger, no Canton needed)
cd services/operator-backend
npm run dev            # http://localhost:8080

# 3. Run the frontend (new terminal)
cd app/web
cp .env.example .env.local   # mock wallet works as-is
npm run dev            # http://localhost:5173
```

You're now in a fully wired DEX:

1. Click **Connect Wallet** in the top bar → pick "Mock Wallet (dev)"
2. Open the **Trade** page → enter an amount → click "Review Swap"
3. Toast banners walk you through the on-ledger lifecycle:
   trader allocation → operator settle → pool roll-forward
4. Visit **Pools** to add/remove liquidity; **Orders** to place
   limit orders; **RFQ** for block trades; **Portfolio** for your
   positions and activity history; **Admin** for the operator view.

For a live Canton testnet validator, see
[`docs/run-testnet.md`](docs/run-testnet.md) and
[`docs/testnet-validator-test-plan.md`](docs/testnet-validator-test-plan.md).

For Docker Compose deployment, see [`docs/deployment.md`](docs/deployment.md).

---

## Architecture in one diagram

```
        ┌──────────────────────────────┐
        │   React frontend (app/web)   │
        │   - 6 pages, 1 toast stack   │
        │   - Wallet provider registry │
        └──────────────┬───────────────┘
                       │ HTTP /v1/*               trader-authority
                       ▼ (read + operator-driven) intents
        ┌──────────────────────────────┐         ┌────────────────┐
        │ Operator backend             │         │ Wallet         │
        │ (services/operator-backend)  │         │ (Token Std V2  │
        │ - HTTP shim                  │         │  / WalletConnect│
        │ - PoolService / OrderService │         │  / Direct / Mock)│
        │ - RfqService / MatchedTrade  │         └───────┬────────┘
        │ - PriceService               │                 │
        │ - Indexer (SQLite)           │                 │
        └──────────────┬───────────────┘                 │
                       │                                 │
                       ▼                                 ▼
                ┌─────────────────────────────────────────┐
                │       Canton JSON Ledger API            │
                │                                         │
                │  ┌────────────────┐  ┌───────────────┐  │
                │  │  DEX templates │  │  V2 Registry  │  │
                │  │  (trading/)     │  │  workflows    │  │
                │  └────────────────┘  └───────────────┘  │
                └─────────────────────────────────────────┘
```

Read [`docs/architecture.md`](docs/architecture.md) for the long form.

---

## How the workflows look

There are two audiences:

- **Traders / LPs / dealers** — see [`docs/workflows.md`](docs/workflows.md)
  for the user journey: connect wallet → swap → add liquidity → place
  order → settle RFQ → view portfolio.
- **Operators / admins** — see
  [`docs/operator-notes.md`](docs/operator-notes.md) for the operator
  journey: deploy DARs → bootstrap registry → create pairs/pools →
  monitor settlement → recover from incidents.

---

## Project status

| Milestone | Focus | Status |
|---|---|---|
| **M1** | Settlement-pattern + reference DEX baseline | ✅ Released |
| **M2** | Constant-product pool + LP + public testnet | ✅ Released |
| **M3** | Order workflows + builder guide + integration readiness | 🚧 In progress |
| **M4** | Audit, production hardening, 12-month maintenance | ⏳ Planned |

What works end-to-end today:
- ✅ RFQ matched-trade settlement on TradingAppV2 surface
- ✅ Constant-product pool with add/swap/remove liquidity
- ✅ Pool reserves as committed V2 allocation slices
- ✅ LP token as registry-backed V2 instrument (unversioned —
  see [docs/lp-token-versioning.md](docs/lp-token-versioning.md))
- ✅ Registry workflows: InstrumentConfiguration, credential-gated
  mint/burn/transfer, TransferPreapproval
- ✅ Operator backend with HTTP shim, idempotency, SQLite indexer
- ✅ Three wallet providers: Token Standard V2 (Canton-native),
  WalletConnect (CIP-0103), Direct (testnet bearer-token)
- ✅ React frontend with all 6 trader/operator views

What's coming (M3):
- Production-grade order matching engine with TradingAppV2 settle
- E2E test harness against a live testnet
- V2 MainNet migration (when upstream V2 stable lands EOM July 2026)

---

## Design inputs

These three upstream sources define the design surface:

- [**TradingAppV2**](https://github.com/canton-network/splice/blob/token-standard-v2-upcoming/token-standard/examples/splice-token-test-trading-app-v2/daml/Splice/Testing/Apps/TradingAppV2.daml)
  — reference posture for matched trades: app-owned trade state,
  per-authorizer allocation requests, batch settlement via the token
  standard.
- [**Registry workflows**](https://docs.digitalasset.com/utilities/devnet/overview/registry-user-guide/workflows.html)
  — `InstrumentConfiguration` is the source of truth for
  credential-gated mint/burn/transfer.
- [**Splice `token-standard-v2-upcoming`**](https://github.com/canton-network/splice/tree/token-standard-v2-upcoming/token-standard)
  — the released V2 allocation semantics (iterated settlement,
  committed allocations, `FinalizedAllocation`, and settle results
  that return rolled-forward allocation state). Originally proposed
  as [splice#5333](https://github.com/canton-network/splice/pull/5333);
  merged into the `token-standard-v2-upcoming` branch.

The repo ships the V2 token-standard DARs under
[`vendor/splice/`](vendor/splice/). When upstream V2
stable lands on MainNet (target EOM July 2026 per the canton-foundation
team), we cut over to upstream — the migration plan is in
[`docs/v2-migration.md`](docs/v2-migration.md).

---

## Documentation map

Start here:
- [`docs/quickstart.md`](docs/quickstart.md) — fresh clone to passing tests
- [`docs/architecture.md`](docs/architecture.md) — full design and rationale
- [`docs/workflows.md`](docs/workflows.md) — user/admin journeys end-to-end

Builder reference:
- [`docs/builder-guide.md`](docs/builder-guide.md) — extending the DEX
- [`docs/guide-add-trading-pair.md`](docs/guide-add-trading-pair.md)
- [`docs/guide-new-lp-or-instrument.md`](docs/guide-new-lp-or-instrument.md)
- [`docs/wallet-vs-dapp-boundary.md`](docs/wallet-vs-dapp-boundary.md)
- [`docs/api-reference.md`](docs/api-reference.md)

Operations:
- [`docs/run-testnet.md`](docs/run-testnet.md) — deploy on Canton testnet
- [`docs/deployment.md`](docs/deployment.md) — Docker-Compose path
- [`docs/operator-notes.md`](docs/operator-notes.md) — deploy/recover/observe
- [`docs/testnet-validator-test-plan.md`](docs/testnet-validator-test-plan.md)
- [`docs/registry-prerequisites.md`](docs/registry-prerequisites.md)

Internals:
- [`docs/choice-context-spec.md`](docs/choice-context-spec.md)
- [`docs/trading-allocation-surface.md`](docs/trading-allocation-surface.md)
- [`docs/v2-alignment-audit.md`](docs/v2-alignment-audit.md)
- [`docs/v2-migration.md`](docs/v2-migration.md)
- [`docs/lp-token-versioning.md`](docs/lp-token-versioning.md)
- [`docs/source-dependency-status.md`](docs/source-dependency-status.md)
- [`docs/architecture-non-goals.md`](docs/architecture-non-goals.md)

---

## Build commands

```bash
# Daml stack
bash scripts/build-vendored-token-standard.sh   # vendored V2 DARs
bash scripts/build-trading-surface.sh                   # canton-dex DAR
cd trading-tests && daml test                           # 26+ tests

# Operator backend
cd services/operator-backend
npm install
npm run typecheck
npm test                                               # 9 tests
npm run dev                                            # in-memory dev
npm start                                              # production (real Canton)

# Frontend
cd app/web
npm install
npm run dev                                            # vite dev
npm run build                                          # production build

# Bootstrap a Canton testnet from scratch
./scripts/deploy-testnet.sh

# E2E smoke
./scripts/e2e-smoke.sh
```

See [`docs/deployment.md`](docs/deployment.md) for environment variables
and Docker Compose details.

---

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for guidelines and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for the community standard.
Security disclosures: see [`SECURITY.md`](SECURITY.md).

The reference implementation is funded under the
[Canton Foundation Dev Fund](https://github.com/canton-foundation/canton-dev-fund/pull/108)
(BitDynamics, 1.1M CC). Roadmap and milestones are tracked in
[Linear](https://linear.app/bitdynamics/team/DEX/) (DEX-1 through DEX-30).

---

## License

Apache 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for
attributions of vendored code under [`vendor/`](vendor/).
