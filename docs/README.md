# Canton DEX — Documentation

A full-stack, **Token Standard V2 (CIP-0112)** reference DEX for the Canton
Network: Daml contracts, an operator backend, a React dApp with a CIP-0103
wallet boundary, tests, and operator runbooks, covering RFQs, prefunded
orders, constant-product pools, swaps, and LP tokens.

New here? Read **[Understand the design in 15 minutes](concepts/design-tour.md)**,
then use **[Getting Started](getting-started.md)** to run the full stack locally
without a Canton participant.

> **Standards note.** This reference implements the Canton Network Token
> Standard **V2 (CIP-0112)** — the privacy/performance/accounting revision of
> the base token standard (**CIP-0056**) — and uses the **CIP-0103** dApp
> standard for trader-authorized wallet submissions. The exact Splice release
> used for the committed Token Standard DARs is recorded in
> [`../vendor/splice/VENDOR_PIN.md`](../vendor/splice/VENDOR_PIN.md).

---

## Find your path

| I want to… | Read, in order |
|---|---|
| **Run it locally** | [Getting Started](getting-started.md) |
| **Learn DEX and TSv2 from Daml** | [15-minute Design Tour](concepts/design-tour.md) → [Glossary](concepts/glossary.md) → [Workflows](concepts/workflows.md) → [Builder Guide](guides/builder-guide.md) |
| **Understand the design** | [15-minute Design Tour](concepts/design-tour.md) → [Architecture](concepts/architecture.md) → [Workflows](concepts/workflows.md) |
| **Build on / extend it** | [Getting Started](getting-started.md) → [Builder Guide](guides/builder-guide.md) → [HTTP API](reference/http-api.md) |
| **Operate a venue** | [Deployment](guides/deployment.md) → [Operator Guide](guides/operator-guide.md) → [Operator Runbook](guides/operator-runbook.md) |
| **Integrate a registry** | [Registry Integration](guides/registry-integration.md) → [Choice Context](guides/choice-context.md) → [Allocation Surface](reference/allocation-surface.md) |
| **Trade in the dApp** | [Using the dApp](guides/using-the-dapp.md) |
| **Evaluate / review it** | [Overview](concepts/overview.md) → [Architecture](concepts/architecture.md) → [Non-goals](concepts/non-goals.md) → [Ecosystem feedback](reference/ecosystem-feedback.md) |

---

## All documentation

The docs follow the [Diátaxis](https://diataxis.fr/) model, separating
learning (tutorial), tasks (how-to guides), understanding (concepts), and
lookup (reference).

### Start here — tutorial
| Page | What it covers |
|---|---|
| **[Getting Started](getting-started.md)** | Clone → build → run the whole stack (Daml core, backend, dApp) locally against the in-memory dev ledger, then test and explore. **Start here.** |

### Concepts — understand the design
| Page | Audience | What it explains |
|---|---|---|
| **[15-minute Design Tour](concepts/design-tour.md)** | Daml developer, reviewer | The shortest code-backed path through actors, contracts, authority, custody, and all four settlement flows. |
| [Overview](concepts/overview.md) | Everyone | What the DEX is, the trust model, and how it maps onto Token Standard V2. |
| [Architecture](concepts/architecture.md) | Builder, integrator | The system model, component boundaries, and executor-authority constraints. |
| [Workflows](concepts/workflows.md) | Builder, integrator | The venue workflows, the actor model, and the design principles behind them. |
| [Liquidity & Custody](concepts/liquidity-and-custody.md) | Integrator | How the pool represents and custodies LP liquidity (operator-custodied, DvP at the boundary). |
| [LP Tokens](concepts/lp-tokens.md) | Builder, integrator | Why LP tokens are a single, unversioned V2 instrument per pool. |
| [Pricing](concepts/pricing.md) | Operator, integrator | Where prices come from — pool-derived, order book, RFQ — and the (absent) oracle attachment points. |
| [Glossary](concepts/glossary.md) | Everyone | The key terms: allocation, commitment, iterated settlement, DvP, slice, registrar, and more. |
| [Non-goals](concepts/non-goals.md) | Everyone | What the reference intentionally does not include, and why. |

### Guides — do a task
| Page | Audience | Recipe |
|---|---|---|
| [Builder Guide](guides/builder-guide.md) | Builder | The contract surface, off-ledger layout, matcher logic, and extension patterns. |
| [Using the dApp](guides/using-the-dapp.md) | Trader, LP | Swap, add/remove liquidity, place orders, accept an RFQ quote, read the portfolio. |
| [Add a Trading Pair](guides/add-a-trading-pair.md) | Operator | List a new pair (e.g. `ETH/USDT`) on a running venue. |
| [Add an LP or Instrument](guides/add-lp-or-instrument.md) | Builder, operator | Register a fungible asset or identify where gated/lifecycle behavior requires a custom registry. |
| [Deployment](guides/deployment.md) | Operator | Local dev, Docker Compose, testnet, environment variables, production checklist. |
| [Operator Guide](guides/operator-guide.md) | Operator | First-time deployment and day-to-day operations. |
| [Operator Runbook](guides/operator-runbook.md) | Operator, SRE | Recovery procedures, observability, and failure modes. |
| [Run on a Testnet](guides/run-on-testnet.md) | Operator | Point the operator backend and dApp at a Canton testnet. |
| [Registry Integration](guides/registry-integration.md) | Integrator | What the DEX assumes from an asset registry, and how to swap in your own. |
| [Choice Context](guides/choice-context.md) | Integrator | What the backend attaches to each transaction it submits (context + disclosure). |
| [Validator Test Plan](guides/validator-test-plan.md) | QA, validator | The live end-to-end validation checklist. |

### Reference — look something up
| Page | Topic |
|---|---|
| [HTTP API](reference/http-api.md) | The operator-backend HTTP endpoints, wallet intents, and error codes. |
| [Allocation Surface](reference/allocation-surface.md) | The V2 allocation surface this reference relies on (committed allocations, iterated settlement). |
| [Testing](reference/testing.md) | The test strategy, suite coverage, and opt-in live-ledger drivers. |
| [Ecosystem feedback](reference/ecosystem-feedback.md) | How the reference was evaluated externally, what was found, and what changed. |

---

## Also in the repo
- **[Getting Started](getting-started.md)** doubles as the local test-suite
  reference (Daml, backend, and dApp commands with expected counts).
- The [Builder Guide](guides/builder-guide.md) walks through the four workflow
  families — pair listing, matched-trade/RFQ, prefunded orders,
  and pool/swap/LP — with file and test pointers.

## Governance
[Contributing](../CONTRIBUTING.md) · [Code of Conduct](../CODE_OF_CONDUCT.md)
· [Security Policy](../SECURITY.md) · [License (Apache 2.0)](../LICENSE)
