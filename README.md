<div align="center">

<a href="#canton-dex-reference-implementation">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/bitdynamics-mark.svg" />
    <img src="docs/assets/bitdynamics-mark-black.svg" alt="Canton DEX" width="84" height="84" />
  </picture>
</a>

# Canton DEX Reference Implementation

### A full-stack Token Standard V2 DEX reference for Canton.

Daml contracts, an operator backend, a React frontend, wallet handoff, tests,
and runbooks for RFQs, prefunded orders, pools, swaps, and LP tokens.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://daml.com"><img src="https://img.shields.io/badge/Daml-3.4.11-orange.svg" alt="Daml SDK 3.4.11" /></a>
  <a href="https://github.com/canton-network/splice"><img src="https://img.shields.io/badge/Canton-Token_Standard_V2-blueviolet.svg" alt="Canton Token Standard V2" /></a>
</p>

<p>
  <a href="#quick-start"><b>Quick Start</b></a> ·
  <a href="#features"><b>Features</b></a> ·
  <a href="#architecture"><b>Architecture</b></a> ·
  <a href="#workflow-coverage"><b>Workflows</b></a> ·
  <a href="#documentation"><b>Docs</b></a> ·
  <a href="#contributing"><b>Contributing</b></a>
</p>

<table align="center"><tr><td>

```sh
git clone https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation.git
cd Canton-Dex-Reference-Implementation

(cd services/operator-backend && npm install && npm run dev)
(cd app/web && npm install && npm run dev)
```

</td></tr></table>

</div>

---

## What Is This?

Canton DEX is a runnable reference implementation of exchange workflows on
Canton. It shows how market state, wallet-authorized funding, registry-defined
holdings, V2 allocations, and atomic settlement batches fit together in one
application.

It is designed to be:

- **Readable**: Daml templates and docs explain the workflow boundaries.
- **Runnable**: local demo mode works without a Canton participant.
- **Verifiable**: Daml tests and TypeScript tests cover the reference flows.
- **Forkable**: builders can reuse the Daml, backend, frontend, or docs.

> [!NOTE]
> This is a reference implementation, not an audited turnkey production
> exchange. Production adopters should perform their own security review,
> operational hardening, compliance work, and version-compatibility checks.

## Why Canton DEX?

Token Standard V2 gives Canton applications a shared way to represent holdings,
allocations, allocation requests, and settlement. A DEX touches all of those
surfaces at once.

<table>
<tr>
  <td width="33%" valign="top">

### Concrete Settlement Patterns

RFQs, matched trades, orders, swaps, and LP flows are implemented as real Daml
workflows, not just diagrams.

  </td>
  <td width="33%" valign="top">

### Full-Stack Reference

The repo includes Daml contracts, backend orchestration, wallet handoff,
frontend screens, tests, and operator runbooks.

  </td>
  <td width="34%" valign="top">

### Token Standard Native

Funds move through V2 holdings, allocations, allocation requests, and settlement
factories instead of a custom off-ledger balance model.

  </td>
</tr>
</table>

## Features

| Feature | Status | Notes |
|---|---|---|
| Pair listing | Implemented | `DexPair` records base, quote, fee model, and trading mode |
| RFQ and matched trades | Implemented | TradingAppV2-style allocation request and batch settlement |
| Prefunded orders | Implemented | Orders are backed by V2 allocations |
| Order matching | Implemented | Reference price-time-priority matcher in the backend |
| Constant-product pools | Implemented | Pool state plus committed allocation slices |
| Add/remove liquidity | Implemented | DvP request, wallet allocation, and operator settle flow |
| LP token | Implemented | LP token is identified by a V2 `InstrumentId` and issued through the registry used by the reference |
| Single-hop swaps | Implemented | Trader allocation plus `PoolRules_Swap` settlement |
| Wallet handoff | Implemented | Token Standard, PartyLayer, CIP-0103-style, WalletConnect, Direct Canton, and Mock providers |
| Operator backend | Implemented | HTTP API, JSON Ledger API driver, idempotency, indexing, and recovery |
| Stable-pool extension | Example | Separate Daml project consuming the DEX DAR |

## Who Should Use It?

| You are | This helps because |
|---|---|
| Canton or Daml builder | You get a complete Token Standard V2 app to read and run |
| DEX or venue team | You can inspect RFQ, order, pool, swap, and LP-token workflows |
| Wallet team | You can validate submit flows against a working dApp |
| Operator | You get deployment, observability, cleanup, and recovery patterns |
| Auditor or evaluator | You can inspect authority boundaries and settlement choreography |

## Quick Start

You can run the app locally without a Canton participant. The local backend uses
an in-memory ledger and seeded demo data.

### Prerequisites

- Node.js 24 or newer.
- npm.
- Daml SDK 3.4.11 for Daml builds and tests.

### 1. Install

```bash
git clone https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation.git
cd Canton-Dex-Reference-Implementation

(cd services/operator-backend && npm install)
(cd app/web && npm install)
```

### 2. Start The Local Backend

```bash
cd services/operator-backend
npm run dev
```

The backend listens on <http://localhost:8080>.

### 3. Start The Frontend

In another terminal:

```bash
cd app/web
cp .env.example .env.local
npm run dev
```

Open <http://localhost:5173>.

### 4. Explore

1. Click **Connect Wallet**.
2. Select **Mock Wallet (dev)**.
3. Open **Trade** and review a swap.
4. Open **Pools** to add or remove liquidity.
5. Open **Orders** to place a prefunded order.
6. Open **RFQ** to inspect the bilateral block-trade flow.
7. Open **Portfolio** and **Admin** to see user and operator views.

## Run Against Canton

For a real Canton participant or testnet validator, start with:

- [`docs/guides/run-on-testnet.md`](docs/guides/run-on-testnet.md) for the testnet setup flow.
- [`docs/guides/deployment.md`](docs/guides/deployment.md) for Docker Compose and production
  environment variables.
- [`docs/guides/operator-runbook.md`](docs/guides/operator-runbook.md) for recovery,
  observability, cleanup, and incident response.
- [`docs/guides/validator-test-plan.md`](docs/guides/validator-test-plan.md)
  for a full live-validation checklist.

The operator backend signs operator-authority commands only. Trader-authority
commands, such as order funding, swap allocation creation, and LP add/remove
allocations, must go through a wallet or another user-authorized submitter.

## Repository Layout

| Path | Purpose |
|---|---|
| [`trading/`](trading/) | Daml package for the DEX app, LP-token component, and reference registry |
| [`trading-tests/`](trading-tests/) | Daml Script tests and Token Standard harnesses |
| [`services/operator-backend/`](services/operator-backend/) | Operator HTTP API, ledger submission, indexing, idempotency, pricing, and recovery |
| [`services/registry-client/`](services/registry-client/) | Registry context and factory discovery client |
| [`app/web/`](app/web/) | React frontend and wallet-provider boundary |
| [`examples/stable-pool/`](examples/stable-pool/) | Example Daml project that consumes the DEX DAR |
| [`scripts/`](scripts/) | Build, bootstrap, deployment, and smoke-test helpers |
| [`docs/`](docs/) | Architecture, workflows, guides, runbooks, and API reference |
| [`vendor/splice/`](vendor/splice/) | Vendored Token Standard packages used by this reference |

## Architecture

```text
React frontend
  |
  | HTTP reads and operator APIs
  v
Operator backend
  |
  | JSON Ledger API submissions, indexing, recovery
  v
Canton ledger
  |
  +-- DEX application contracts
  |     DexPair, Order, Rfq, MatchedTrade, Pool, PoolState, PoolSlice
  |
  +-- LP-token component
  |     LPTokenPolicy and reference-registry LP config
  |
  +-- Token Standard / registry contracts
        Holding, Allocation, AllocationRequest, SettlementFactory
```

The boundary is intentionally strict:

- DEX contracts own market state and workflow validation.
- Token Standard contracts own asset reservation and settlement.
- Registries own instrument semantics and choice context. The reference
  registry uses `InstrumentConfiguration`, but Token Standard V2 does not
  require that exact template.
- Wallets own trader-authority submissions.
- The operator backend orchestrates and settles only commands it is authorized
  to submit.

The Daml package separates LP-token policy, venue workflows, and the reference
registry by module/template. It implements upstream Token Standard V2
interfaces, but it does not define custom Daml interfaces that decouple those
components into independently swappable apps.

Read [`docs/concepts/architecture.md`](docs/concepts/architecture.md) and
[`docs/concepts/workflows.md`](docs/concepts/workflows.md) for the full model.

## Workflow Coverage

| Workflow | Where To Read | Key Contracts |
|---|---|---|
| Pair listing | [`docs/guides/add-a-trading-pair.md`](docs/guides/add-a-trading-pair.md) | `DexPair` |
| RFQ and matched trade | [`docs/concepts/workflows.md`](docs/concepts/workflows.md) | `Rfq`, `RfqQuote`, `MatchedTrade`, `TradeAllocationRequest` |
| Orders | [`docs/concepts/workflows.md`](docs/concepts/workflows.md) | `OrderFundingRequest`, `Order`, `OrderAllocationRequest`, `OrderMatchExecution` |
| Pools and swaps | [`docs/concepts/liquidity-and-custody.md`](docs/concepts/liquidity-and-custody.md) | `Pool`, `PoolState`, `PoolSlice`, `PoolRules` |
| Add/remove liquidity | [`docs/concepts/liquidity-and-custody.md`](docs/concepts/liquidity-and-custody.md) | `PoolLiquidityRules`, `LiquidityAllocationRequest`, `LPTokenPolicy` |
| LP instruments | [`docs/guides/add-lp-or-instrument.md`](docs/guides/add-lp-or-instrument.md) | `LPTokenPolicy`, reference-registry instrument config |
| Choice context | [`docs/guides/choice-context.md`](docs/guides/choice-context.md) | Registry factories and Token Standard choices |

## Wallet Support

The frontend has a wallet-provider abstraction. Current providers include:

- Token Standard V2 provider for Canton-native local and testnet flows.
- PartyLayer provider for supported Canton wallets.
- CIP-0103 SDK-style provider.
- WalletConnect provider.
- Direct Canton provider for advanced testnet sessions.
- Mock provider for local development.

PartyLayer live-validation steps are documented in
[`docs/guides/run-on-testnet.md`](docs/guides/run-on-testnet.md).

## Development Commands

```bash
# Build vendored Token Standard DARs
bash scripts/build-vendored-token-standard.sh

# Build the DEX Daml package
bash scripts/build-trading-surface.sh

# Run Daml tests
(cd trading-tests && daml test)

# Run backend checks
(cd services/operator-backend && npm run typecheck && npm test)

# Run frontend checks
(cd app/web && npm test -- --run && npm run build)

# Bootstrap a Canton testnet
./scripts/deploy-testnet.sh

# Run the smoke test script
./scripts/e2e-smoke.sh
```

## Token Standard V2

This reference is built on the Canton Network **Token Standard V2 (CIP-0112)** —
the privacy, performance, and traditional-accounting revision of the base token
standard (**CIP-0056**) — and uses the **CIP-0103** dApp standard for
trader-authorized wallet submissions.

Token Standard V2 has **merged into `canton-network/splice` `main`** and becomes
the network default from **mid-July 2026**. The vendored V2 sources under
[`vendor/splice/`](vendor/splice/) are pinned to a specific upstream commit,
recorded in [`vendor/splice/VENDOR_PIN.md`](vendor/splice/VENDOR_PIN.md); the
repo re-pins as the surface stabilizes on `main`. The pool relies on
iterated-settlement and committed-allocation semantics — the exact surface it
depends on is documented in
[Allocation Surface](docs/reference/allocation-surface.md).

## Project Maturity

This is a reference implementation with active development. It is appropriate
for learning, evaluation, demos, and forks.

Before using it as production infrastructure, adopters should perform their own
security review, operational hardening, deployment-specific compliance work,
and compatibility checks against the Canton and Token Standard versions they
intend to run.

## Documentation

The full documentation set is in **[`docs/README.md`](docs/README.md)** — organized as
Getting Started, Concepts, Guides, and Reference. Good entry points:

- **[Getting Started](docs/getting-started.md)** — run the whole stack locally.
- **[Overview](docs/concepts/overview.md)** — what it is and the trust model.
- **[Builder Guide](docs/guides/builder-guide.md)** — extend the reference.
- **[HTTP API](docs/reference/http-api.md)** — backend endpoints.
- **[Using the dApp](docs/guides/using-the-dapp.md)** — trader, LP, and dealer flows.

## Contributing

Issues and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for development guidelines and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for
community expectations.

## Security

Please do not open public issues for suspected vulnerabilities. See
[`SECURITY.md`](SECURITY.md) for the disclosure process.

## License

Apache 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Vendored upstream
packages are under [`vendor/`](vendor/) with their own attribution.

## Acknowledgements

Implemented by BitDynamics as part of a Canton ecosystem development grant.
