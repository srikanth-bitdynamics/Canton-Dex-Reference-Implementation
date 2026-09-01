<div align="center">

<a href="#canton-dex-reference-implementation">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/bitdynamics-mark.svg" />
    <img src="docs/assets/bitdynamics-mark-black.svg" alt="Canton DEX" width="84" height="84" />
  </picture>
</a>

# Canton DEX Reference Implementation

## A full-stack code reference for a Token Standard V2 DEX on Canton

Daml contracts, an operator backend, a React frontend, wallet handoff, tests,
and runbooks for RFQs, prefunded orders, pools, swaps, and LP tokens.

> **New to Canton but comfortable with AMMs?** Follow the single
> [newcomer learning path](docs/README.md#canonical-newcomer-learning-path). It
> starts with the Canton/Daml mental model, runs each proof mode, traces one
> swap, and ends with a tested first code change.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://daml.com"><img src="https://img.shields.io/badge/Daml-3.5.2-orange.svg" alt="Daml SDK 3.5.2" /></a>
  <a href="https://github.com/canton-network/splice"><img src="https://img.shields.io/badge/Canton-Token_Standard_V2-blueviolet.svg" alt="Canton Token Standard V2" /></a>
</p>

<p>
  <a href="#quick-start"><b>Quick Start</b></a> ·
  <a href="https://srikanth-bitdynamics.github.io/Canton-Dex-Reference-Implementation/"><b>Documentation Site</b></a> ·
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

(cd services/operator-backend && npm ci)
(cd app/web && npm ci && cp .env.example .env.local)

# Then use the split-terminal Quick Start below.
```

</td></tr></table>

</div>

---

## What Is This?

Canton DEX is a runnable reference implementation of exchange workflows on
Canton. It shows how market state, wallet-authorized funding, registry-defined
holdings, V2 allocations, and atomic settlement batches fit together in one
application.

In AMM terms: a **holding** is a token balance, an **allocation** locks a
trader's funds for a single trade, and a **settlement batch** is the one atomic
step that exchanges them. The RFQs, orders, pools, swaps, and LP tokens named
above are those Canton pieces assembled into an exchange.

It is designed to be:

- **Readable**: Daml templates and docs explain the workflow boundaries.
- **Runnable**: the browser preview and Daml-engine tests run without a Canton
  participant; real wallet settlement uses a configured participant.
- **Verifiable**: Daml tests and TypeScript tests cover the reference flows.
- **Forkable**: builders can reuse the Daml, backend, frontend, or docs.

> [!NOTE]
> This is a reference implementation, not an audited turnkey production
> exchange. Production adopters should perform their own security review,
> operational hardening, compliance work, and version-compatibility checks.

The repository has three deliberately different run modes:

| Mode | Best for | Honest boundary |
|---|---|---|
| Browser preview | screens, seeded reads, quotes, wallet-intent UI | TypeScript in-memory ledger and Mock Wallet; no Daml or value settlement |
| Daml-engine tests | choices, authorization, atomicity, conservation | Daml Script runner; no browser, backend, or Canton participant |
| Live Canton proof | real Canton process, JSON Ledger API, package upload, distinct LP/swapper parties, and add → quote-bound swap → partial remove value movement | direct-ledger driver only; no backend HTTP, browser, external wallet, or persistent state |

See [Getting started](docs/getting-started.md) for the commands and expected
results for each mode.

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

### Full-Stack Code Reference

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
| Add/remove liquidity | Implemented | DvP (delivery-versus-payment) request, wallet allocation, and operator settle flow |
| LP token | Implemented | LP token is identified by a V2 `InstrumentId` and issued through the registry used by the reference |
| Single-hop swaps | Implemented | Trader allocation plus `PoolRules_Swap` settlement |
| Wallet handoff | Implemented with explicit boundaries | External-wallet adapters for the Canton dapp SDK (CIP-0103), PartyLayer, and WalletConnect; DEV-only operator relay and Mock; unsafe Direct Canton experiment disabled |
| Operator backend | Implemented | HTTP API, JSON Ledger API driver, idempotency, indexing, and recovery |

## Who Should Use It?

| You are | This helps because |
|---|---|
| Canton or Daml builder | You get a complete Token Standard V2 app to read and run |
| DEX or venue team | You can inspect RFQ, order, pool, swap, and LP-token workflows |
| Wallet team | You can validate submit flows against a working dApp |
| Operator | You get deployment, observability, cleanup, and recovery patterns |
| Auditor or evaluator | You can inspect authority boundaries and settlement choreography |

## New To Canton Or Daml?

If you know AMMs but not Canton, follow this order. Each step assumes only the
steps before it:

1. [Canton and Daml primer](docs/concepts/canton-daml-primer.md)
2. [Overview](docs/concepts/overview.md)
3. [Getting started: run the three proof modes](docs/getting-started.md)
4. [Trace one AMM swap](docs/tutorials/amm-first-walkthrough.md)
5. [Understand the design in 15 minutes](docs/concepts/design-tour.md)
6. [Architecture](docs/concepts/architecture.md)
7. [Workflow design](docs/concepts/workflows.md)
8. [Make your first AMM code change](docs/tutorials/make-your-first-amm-change.md)
9. [Builder guide](docs/guides/builder-guide.md)

Keep the [Glossary](docs/concepts/glossary.md) open as a companion. The same
canonical path, including the outcome of every step, is maintained in the
[documentation index](docs/README.md#canonical-newcomer-learning-path).

## Quick Start

The quickest local experience is a **browser preview**, not a settled Canton
DEX. The backend uses seeded TypeScript state and Mock Wallet returns fake
contract IDs. Use the Daml tests below to exercise real contract semantics.

### Prerequisites

- [Node.js 24 or newer](https://nodejs.org/en/download) and its bundled npm.
- [Git](https://git-scm.com/downloads/).
- [Eclipse Temurin JDK 17 or newer](https://adoptium.net/temurin/releases/?version=17),
  [DPM](https://docs.canton.network/sdks-tools/cli-tools/dpm), and
  Daml SDK 3.5.2 for Daml builds/tests and the default live-Canton proof.

See the [full prerequisites](docs/getting-started.md#prerequisites). If the
language is new to you, start with Digital Asset's official
[Get started with Daml](https://docs.canton.network/sdks-tools/sdks/daml-sdk)
tutorial.

### 1. Install

```bash
git clone https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation.git
cd Canton-Dex-Reference-Implementation

(cd services/operator-backend && npm ci)
(cd app/web && npm ci && cp .env.example .env.local)
```

### 2. Start The Local Backend

```bash
cd services/operator-backend
ALLOWED_ORIGINS=http://localhost:5173 npm run dev
```

Leave this foreground process running. Success includes
`dev server listening at http://127.0.0.1:8080`. The explicit origin is
required because browser CORS access is denied by default.

### 3. Start The Frontend

In another terminal:

```bash
cd app/web
npm run dev
```

Open the URL Vite prints, normally <http://localhost:5173>.

The app header and warning banner identify this mode as **In-memory preview —
no Canton participant**. If that banner is absent, verify which backend URL the
dApp is using before treating any displayed state as ledger-backed.

### 4. Explore

1. Confirm Trade and Pools show the seeded `Amulet/USDCx` market.
2. Select **Mock Wallet (dev)** and inspect the `trader-demo` holdings.
3. Change a swap amount and inspect the quote, fee, and price impact.
4. Browse Pools, Orders, RFQ, Portfolio, and Admin to learn the surfaces.

Mock Wallet logs an intent and returns a `#mock-…:0` placeholder; it does not
sign or submit a Canton transaction. Writes are `401` by default. The explicit
local-only `DEX_DEV_OPEN=1` bypass opens the non-admin operator-write gate, but
allocation-backed flows can still return `501 not_supported` because this
ledger does not implement them. Admin routes still require their admin token.
These are expected preview boundaries.

### Prove The Daml Swap

Install DPM, JDK 17+, and SDK 3.5.2 as described in
[Getting started](docs/getting-started.md#additional-tools-for-daml-builds-and-tests),
then run:

```bash
bash scripts/run-local-daml-tests.sh
```

A successful run builds `canton-dex-trading-v2-1.0.0.dar`, reports every Daml
Script test as `ok`, and exits 0. At this revision there are 118 test
declarations. This proves Daml behavior, including real-holding settlement
fixtures, but still does not run a Canton participant or browser integration.

### Prove Live Canton Value Movement

The default live path needs no Canton DevKit or Docker:

```bash
bash scripts/run-dpm-sandbox-proof.sh
```

It builds the DAR, starts a throwaway `dpm sandbox`, uploads that DAR (including
its embedded Token Standard dependency closure), creates distinct LP/trader and
swapper parties, and runs the live JSON Ledger API DvP driver. The driver adds
liquidity, executes a quote-bound swap, and removes half the LP position.
Success ends with:

```text
==> PASS: portable live-Canton proof completed
    The throwaway sandbox is now stopping; no persistent ledger state remains.
```

This proves real ledger value movement between distinct counterparties in an
authentication-disabled local sandbox. It checks exact balances and reserves,
reserve-slice reconciliation after every phase, LP holding/supply/policy
consistency, `x*y` nondecrease, reserve-per-LP, and total value conservation.
Operator, admin, and LP registrar still share the bootstrap party and the
sandbox user has unrestricted throwaway rights. It does not start the operator
HTTP server, browser, or an external wallet. See
[Local Canton from a clean clone](docs/guides/localnet.md) for its phases,
limitations, and optional persistent environments.

The complete split-terminal procedure, exact outputs, CORS explanation, and
three-mode capability table are in [Getting started](docs/getting-started.md).

## Run Against Canton

Start with the DPM sandbox proof above. It is the repository's default live
path and has no dependency on Canton DevKit. DevKit is an optional, separately
distributed helper for a persistent Splice LocalNet; it is not a runtime
dependency of the DEX application or its DARs.

For a persistent local network, bring-your-own participant, or testnet, use:

- [`docs/guides/localnet.md`](docs/guides/localnet.md) for the default DPM
  sandbox proof and optional persistent DevKit LocalNet.
- [`docs/guides/run-on-testnet.md`](docs/guides/run-on-testnet.md) for the testnet setup flow.
- [`docs/guides/deployment.md`](docs/guides/deployment.md) for Docker Compose and production
  environment variables.
- [`docs/guides/operator-runbook.md`](docs/guides/operator-runbook.md) for recovery,
  observability, cleanup, and incident response.
- [`docs/guides/validator-test-plan.md`](docs/guides/validator-test-plan.md)
  for a full live-validation checklist.

A live **browser** flow additionally needs deployed/vetted packages, separated
parties and ledger rights, long-lived registry factories and holdings, a funded
pool, backend credentials, explicit CORS, and a compatible wallet. Passing the
DPM sandbox proof does not establish those browser/wallet boundaries.

Self-custodial value flows keep trader authority in the wallet: order funding,
swap allocation creation, and LP add/remove allocations never require the
operator to act as the trader. The included operator-mediated RFQ routes are an explicit
exception: they require the backend's ledger user to be authorized for the
configured trader party, and `Rfq_Accept` also requires the operator. External
deployments should provide those authorities through their own wallet,
delegation, or co-submission design.

## Repository Layout

| Path | Purpose |
|---|---|
| [`trading/`](trading/) | Daml package for the DEX app, LP-token component, and reference registry |
| [`trading-tests/`](trading-tests/) | Daml Script tests and Token Standard harnesses |
| [`services/operator-backend/`](services/operator-backend/) | Operator HTTP API, ledger submission, indexing, idempotency, pricing, and recovery |
| [`services/registry-client/`](services/registry-client/) | Registry context and factory discovery client |
| [`app/web/`](app/web/) | React frontend and wallet-provider boundary |
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
  registry uses its own `InstrumentConfig`, but Token Standard V2 does not
  require a configuration template.
- Wallets own trader-authored allocation submissions in self-custodial flows.
- The operator backend submits administrative and settlement commands. Its
  operator-mediated RFQ path is a documented authority exception, not a
  self-custodial path or a public relay service.

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
| LP and custom instruments | [`docs/guides/add-lp-or-instrument.md`](docs/guides/add-lp-or-instrument.md) | `LPTokenPolicy`, `InstrumentConfig`, registry extension boundary |
| Choice context | [`docs/guides/choice-context.md`](docs/guides/choice-context.md) | Registry factories and Token Standard choices |

## Wallet Support

The frontend separates external-wallet integrations from local conveniences:

- **External-wallet adapters:** the Canton dapp SDK (CIP-0103), PartyLayer, and
  WalletConnect. The SDK path is marked DvP-ready, PartyLayer remains marked
  unproven until a selected wallet passes the live validator plan, and the
  current WalletConnect adapter is marked no-DvP and rejects LP add/remove.
- **Development-only adapters:** the `token-standard` provider is
  accurately labelled **Operator Relay (dev only)** because the backend submits
  with configured ledger rights; Mock Wallet returns placeholders and performs
  no ledger write. Neither is registered in production builds.
- **Disabled experiment:** Direct Canton is not registered. Its former
  `/v1/wallet/execute` target is not a participant Ledger API endpoint, and the
  app does not retain a participant bearer token in browser storage.

No external wallet is connected automatically. When several production-facing
adapters are enabled, one row gets a recommendation badge, but the user still
chooses and authorizes the wallet. If none is configured, production does not
fall back to the operator relay.

PartyLayer live-validation steps are documented in
[`docs/guides/run-on-testnet.md`](docs/guides/run-on-testnet.md).

## Development Commands

```bash
# Refresh Token Standard DARs from a Splice release (optional)
bash scripts/fetch-splice-dars.sh 0.6.12

# Build the DEX Daml package
bash scripts/build-trading-surface.sh

# Build the Daml package and run every Daml test project
bash scripts/run-local-daml-tests.sh

# Run backend checks
(cd services/operator-backend && npm run typecheck && npm test)

# Run frontend checks
(cd app/web && npm test -- --run && npm run build)

# Bootstrap a Canton testnet
./scripts/deploy-testnet.sh

# Run the smoke test script
bash scripts/backend-http-smoke.sh

# Run the portable live-Canton add -> swap -> partial-remove proof
bash scripts/run-dpm-sandbox-proof.sh
```

## Token Standard V2

This reference is built on the Canton Network **Token Standard V2 (CIP-0112)** —
the privacy, performance, and traditional-accounting revision of the base token
standard (**CIP-0056**) — and uses the **CIP-0103** dApp standard for
trader-authorized wallet submissions.

The build consumes the released Splice Token Standard DARs committed under
[`vendor/splice/dars/`](vendor/splice/dars/). Their release and provenance are
recorded in [`vendor/splice/VENDOR_PIN.md`](vendor/splice/VENDOR_PIN.md). The pool relies on
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

Read the rendered **[documentation site](https://srikanth-bitdynamics.github.io/Canton-Dex-Reference-Implementation/)**
or the repository index at **[`docs/README.md`](docs/README.md)**. The site is
published from `main`; documentation on an unmerged branch appears only after
that branch is merged and the Pages workflow completes. Good entry points:

- **[Getting Started](docs/getting-started.md)** — choose browser preview,
  Daml-engine proof, or live integration and see the boundary of each.
- **[Canton and Daml primer](docs/concepts/canton-daml-primer.md)** — the minimum
  ledger mental model for a newcomer.
- **[AMM-first walkthrough](docs/tutorials/amm-first-walkthrough.md)** — trace one
  swap from `x*y=k` through allocation and settlement tests.
- **[Make your first AMM code change](docs/tutorials/make-your-first-amm-change.md)** —
  make a small test-first Daml refactor, check the off-ledger impact, and rerun
  the live-Canton proof.
- **[Local Canton](docs/guides/localnet.md)** — run the default DPM sandbox
  live proof; understand the optional DevKit path and exact proof boundaries.
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
