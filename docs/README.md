# Canton DEX — Documentation

A full-stack code reference for a **Token Standard V2 (CIP-0112)** DEX on the
Canton Network: Daml contracts, an operator backend, a React dApp with a
CIP-0103 wallet boundary, tests, and operator runbooks. It covers RFQs,
prefunded orders, constant-product pools, swaps, and LP tokens.

**Rendered site:**
[srikanth-bitdynamics.github.io/Canton-Dex-Reference-Implementation](https://srikanth-bitdynamics.github.io/Canton-Dex-Reference-Implementation/).
The site is published from `main`; changes on a branch become public after they
are merged and the GitHub Pages workflow finishes.

New to Canton and Daml, but familiar with AMMs? Follow the canonical path below.
It is the only ordered newcomer curriculum in this documentation.

> **Three run modes.** The local browser preview uses a TypeScript in-memory
> ledger and Mock Wallet; it does not settle value. Daml Script tests execute
> real Daml semantics without a participant. The default live proof starts a
> throwaway DPM sandbox and proves JSON Ledger API value movement without a
> browser or wallet. A live browser write needs the larger configured
> environment. [Getting started](getting-started.md) keeps these modes and their
> success criteria separate.

> **Standards note.** This reference implements the Canton Network Token
> Standard **V2 (CIP-0112)** — the privacy/performance/accounting revision of
> the base token standard (**CIP-0056**) — and uses the **CIP-0103** dApp
> standard for trader-authorized wallet submissions. The exact Splice release
> used for the committed Token Standard DARs is recorded in
> [`../vendor/splice/VENDOR_PIN.md`](../vendor/splice/VENDOR_PIN.md).

---

## Canonical newcomer learning path

Follow these steps in order. The glossary is a companion, not another step.

| Step | Read or run | You are done when… |
|---:|---|---|
| 1 | [Canton and Daml primer](concepts/canton-daml-primer.md) | You can distinguish a party from a participant, a template from a contract, and DEX state from token value. |
| 2 | [Overview](concepts/overview.md) | You can explain the system boundary and the operator → wallet → operator swap authority sequence. |
| 3 | [Getting started](getting-started.md) | You have installed the tools and run the preview, the Daml proof, and the throwaway live-Canton proof without confusing their boundaries. |
| 4 | [AMM-first walkthrough](tutorials/amm-first-walkthrough.md) | You can trace `x*y=k` through `PoolState`, slices, allocation, and atomic settlement. |
| 5 | [15-minute design tour](concepts/design-tour.md) | You can name the actors and the four workflow families. |
| 6 | [Architecture](concepts/architecture.md) | You can locate market state, token custody, off-ledger orchestration, and the trust boundaries. |
| 7 | [Workflow design](concepts/workflows.md) | You can follow swap, liquidity, order, and RFQ state transitions. |
| 8 | [Make your first AMM code change](tutorials/make-your-first-amm-change.md) | A focused Daml test, the full suite, and the live sandbox proof pass after your edit. |
| 9 | [Builder guide](guides/builder-guide.md) | You can identify every layer affected by the extension you want to build. |

Keep the [Glossary](concepts/glossary.md) open while reading. If Daml syntax
itself is new, the primer links the official language tutorial before asking
you to edit source.

---

## Find your path

| I want to… | Read, in order |
|---|---|
| **Learn Canton/Daml from an AMM mental model** | Follow the [canonical newcomer learning path](#canonical-newcomer-learning-path) without skipping proof boundaries. |
| **Preview the UI locally** | [Getting started — Mode 1](getting-started.md#mode-1-run-the-browser-preview) |
| **Prove the Daml contracts locally** | [Getting started — Mode 2](getting-started.md#mode-2-run-the-daml-engine-proofs) → [Testing](reference/testing.md) |
| **Prove value movement on real Canton** | [Getting started — Mode 3](getting-started.md#mode-3-run-the-default-live-canton-proof) → [Local Canton from a clean clone](guides/localnet.md) |
| **Integrate a persistent/testnet environment** | [Local Canton](guides/localnet.md) → [Run on a testnet](guides/run-on-testnet.md) → [Validator test plan](guides/validator-test-plan.md) |
| **Understand the design** | [Overview](concepts/overview.md) → [15-minute Design Tour](concepts/design-tour.md) → [Architecture](concepts/architecture.md) → [Workflows](concepts/workflows.md) |
| **Build on / extend it** | Complete the [canonical newcomer learning path](#canonical-newcomer-learning-path), then use the [HTTP API](reference/http-api.md) as a lookup reference. |
| **Operate a venue** | [Deployment](guides/deployment.md) → [Operator Guide](guides/operator-guide.md) → [Operator Runbook](guides/operator-runbook.md) |
| **Integrate a registry** | [Registry Integration](guides/registry-integration.md) → [Choice Context](guides/choice-context.md) → [Allocation Surface](reference/allocation-surface.md) |
| **Trade in the dApp** | [Using the dApp](guides/using-the-dapp.md) |
| **Evaluate / review it** | [Overview](concepts/overview.md) → [Architecture](concepts/architecture.md) → [Non-goals](concepts/non-goals.md) → [Ecosystem feedback](reference/ecosystem-feedback.md) |

---

## All documentation

The docs follow the [Diátaxis](https://diataxis.fr/) model, separating
learning (tutorial), tasks (how-to guides), understanding (concepts), and
lookup (reference).

### Concepts — understand the design

| Page | Audience | What it explains |
|---|---|---|
| **[Canton and Daml primer](concepts/canton-daml-primer.md)** | First-time Canton/Daml builder | The minimum ledger mental model needed to read this codebase. |
| **[15-minute Design Tour](concepts/design-tour.md)** | Daml developer, reviewer | The shortest code-backed path through actors, contracts, authority, custody, and all four settlement flows. |
| [Overview](concepts/overview.md) | Everyone | What the DEX is, the trust model, and how it maps onto Token Standard V2. |
| [Architecture](concepts/architecture.md) | Builder, integrator | The system model, component boundaries, and executor-authority constraints. |
| [Workflows](concepts/workflows.md) | Builder, integrator | The venue workflows, the actor model, and the design principles behind them. |
| [Liquidity & Custody](concepts/liquidity-and-custody.md) | Integrator | How the pool represents and custodies LP liquidity (operator-custodied; delivery-versus-payment — DvP — at the boundary). |
| [LP Tokens](concepts/lp-tokens.md) | Builder, integrator | Why LP tokens are a single, unversioned V2 instrument per pool. |
| [Pricing](concepts/pricing.md) | Operator, integrator | Where prices come from — pool-derived, order book, RFQ — and the (absent) oracle attachment points. |
| [Glossary](concepts/glossary.md) | Everyone | The key terms: allocation, commitment, iterated settlement, DvP, slice, registrar, and more. |
| [Non-goals](concepts/non-goals.md) | Everyone | What the reference intentionally does not include, and why. |

### Tutorials — learn by following one path

| Page | Audience | Outcome |
|---|---|---|
| [Getting started](getting-started.md) | First-time builder | Install the tools and run the preview, Daml-engine proofs, and live-Canton sandbox proof without confusing their boundaries. |
| [AMM-first walkthrough](tutorials/amm-first-walkthrough.md) | AMM developer new to Canton | Locate the quote math, map pool state to contracts, follow operator → trader → operator authority, and run arithmetic, choreography, and real-holding swap proofs. |
| [Make your first AMM code change](tutorials/make-your-first-amm-change.md) | First-time Daml contributor | Complete one reproducible red/green edit and assess its Daml, backend, UI, and live-ledger impact. |

### Guides — do a task

| Page | Audience | Recipe |
|---|---|---|
| [Builder Guide](guides/builder-guide.md) | Builder | The contract surface, off-ledger layout, matcher logic, and extension patterns. |
| [Using the dApp](guides/using-the-dapp.md) | Trader, LP | Swap, add/remove liquidity, place orders, accept an RFQ quote, read the portfolio. |
| [Add a Trading Pair](guides/add-a-trading-pair.md) | Operator | List a new pair (e.g. `ETH/USDT`) on a running venue. |
| [Add an LP or Instrument](guides/add-lp-or-instrument.md) | Builder, operator | Register a fungible asset or identify where gated/lifecycle behavior requires a custom registry. |
| [Local Canton from a clean clone](guides/localnet.md) | Builder, integrator | Run the default throwaway DPM sandbox proof; optionally use a separately distributed DevKit for persistent LocalNet. |
| [Deployment](guides/deployment.md) | Operator | Local dev, default DPM sandbox, optional DevKit LocalNet, Docker Compose, testnet, environment variables, and production checklist. |
| [Operator Guide](guides/operator-guide.md) | Operator | First-time deployment and day-to-day operations. |
| [Operator Runbook](guides/operator-runbook.md) | Operator, SRE | Recovery procedures, observability, and failure modes. |
| [Run on a Testnet](guides/run-on-testnet.md) | Operator | Point the operator backend and dApp at a Canton testnet. |
| [Registry Integration](guides/registry-integration.md) | Integrator | What the DEX assumes from an asset registry, and how to swap in your own. |
| [Choice Context](guides/choice-context.md) | Integrator | What the backend attaches to each transaction it submits (context + disclosure). |
| [Validator Test Plan](guides/validator-test-plan.md) | QA, validator | The live, boundary-labelled validation checklist. |

### Reference — look something up

| Page | Topic |
|---|---|
| [HTTP API](reference/http-api.md) | The operator-backend HTTP endpoints, wallet intents, and error codes. |
| [Allocation Surface](reference/allocation-surface.md) | The V2 allocation surface this reference relies on (committed allocations, iterated settlement). |
| [Daml proof map](reference/daml-proof-map.md) | Named learning paths from one concept to its Daml choices and focused executable tests, with each fixture's limitations. |
| [Testing](reference/testing.md) | The test strategy, suite coverage, and opt-in live-ledger drivers. |
| [Ecosystem feedback](reference/ecosystem-feedback.md) | How the reference was evaluated externally, what was found, and what changed. |

---

## Also in the repo

- **[Getting started](getting-started.md)** is the local run-mode and component
  check reference. It states the exact success signal and limitation for each
  command.
- The [Builder Guide](guides/builder-guide.md) walks through the four workflow
  families — pair listing, matched-trade/RFQ, prefunded orders,
  and pool/swap/LP — with file and test pointers.

## Governance

[Contributing](../CONTRIBUTING.md) · [Code of Conduct](../CODE_OF_CONDUCT.md)
· [Security Policy](../SECURITY.md) · [License (Apache 2.0)](../LICENSE)
