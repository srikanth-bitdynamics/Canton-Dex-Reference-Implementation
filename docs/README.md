# Canton-Dex documentation

A token-standard-native reference DEX for Canton, built on Token Standard V2
(CIP-0112). This folder is the full documentation set; start with the **Get
started** group below.

## Get started
| Page | What it covers |
|---|---|
| [Local Setup & Testing](local-setup.md) | One page to clone, build, run, and test the **whole** stack locally against the in-memory dev ledger — no Canton participant needed. Start here. |
| [Quickstart](quickstart.md) | Builder onboarding: from a fresh clone to a running stack and a first trade. |
| [Architecture](architecture.md) | How the pieces fit — the Daml core, the operator backend, and the dApp. |
| [Workflow Design](workflows.md) | The design thinking behind the venue's workflows (why it's shaped the way it is). |

## Guides by role
| Page | Audience |
|---|---|
| [User Guide](user-guide.md) | Traders, LPs, and RFQ counterparties using the DEX. |
| [Operator Guide](operator-guide.md) | The operator/admin: deploy, configure, and run the venue. |
| [Operator Runbook](operator-runbook.md) | Recovery and observability guidance for the operator roles. |
| [Builder Guide](builder-guide.md) | Engineers picking this reference up to extend it. |

## How-to recipes
| Page | Recipe |
|---|---|
| [Add a trading pair](guide-add-trading-pair.md) | List a new pair (e.g. `ETH/USDT`) on a running venue. |
| [Issue a new LP token or instrument](guide-new-lp-or-instrument.md) | Mint a new asset / lifecycle-rich instrument via Token Standard V2. |

## Reference
| Page | Topic |
|---|---|
| [Operator Backend API Reference](api-reference.md) | The operator-backend HTTP endpoints. |
| [Registry Prerequisites](registry-prerequisites.md) | What the DEX assumes from an asset registry. |
| [Choice Context & Disclosure](choice-context-spec.md) | What the backend attaches to each transaction it submits. |
| [Allocation Surface delta](allocation-surface.md) | Delta vs. the released/stable Token Standard V2 allocation surface. |
| [Pricing & Oracle Sources](pricing-sources.md) | The pricing model (there is no on-chain price oracle). |
| [LP Liquidity Custody](lp-liquidity-custody.md) | How the reference pool represents and custodies LP liquidity. |
| [LP Token Versioning](lp-token-versioning.md) | Why Canton-Dex LP tokens are unversioned. |

## Deploy & test on Canton
| Page | Topic |
|---|---|
| [Deployment Guide](deployment.md) | The deployment options (LocalNet / testnet / managed). |
| [Run Against a Testnet](run-testnet.md) | Point the operator backend and dApp at a Canton testnet. |
| [Canton-backed E2E Test](canton-e2e-test.md) | The real-ledger end-to-end integration test (replaces the in-memory harness). |
| [Testnet Validator Test Plan](testnet-validator-test-plan.md) | Live end-to-end test plan against a Canton testnet validator. |
