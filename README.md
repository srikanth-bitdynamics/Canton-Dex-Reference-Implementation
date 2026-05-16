# Canton-Dex

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Reference DEX for Canton** built directly on Token Standard V2 (CIP-0056)
and registry-backed instrument configuration. Apache 2.0 licensed.

This repo is a builder's reference: a complete, runnable example of how
to assemble pair listings, RFQ block trades, constant-product pools, LP
tokens, and prefunded orders on the V2 token standard, using the
iterated-settlement allocation surface from
[Splice PR 5333](https://github.com/canton-network/splice/pull/5333).

## Who is this for

- Teams building a DEX or other settlement venue on Canton who need a
  working starting point rather than a paper design.
- Reviewers evaluating Token Standard V2 patterns end-to-end.
- Operators who want a concrete deploy-recovery-observe runbook.

## What's in the box

| Layer | What | Where |
|---|---|---|
| Daml templates | DexPair, Rfq, MatchedTrade, Pool, LPToken, Order, V2 Registry | `pr5333/CantonDex/` |
| Daml tests | 26 in-script tests + token-standard harness | `pr5333-tests/` |
| Live-testnet harnesses | Real-asset matched-trade + V2-registry trade | `scripts/testnet-*.ts` |
| Operator backend | Node.js + JSON LAPI, SQLite indexer, idempotency cache | `services/operator-backend/` |
| Web UI | React + Vite, WalletConnect, real testnet wiring | `app/web/` |
| Docs | Quickstart, run-testnet, workflows, builder guide, non-goals | `docs/` |

## Quickstart

Pre-requisites: Daml SDK 3.4.11, Node 20+, `tsx`.

```bash
# 1. Build the Daml stack
bash scripts/build-vendored-token-standard-pr5333.sh   # vendored V2 standard
bash scripts/build-pr5333-surface.sh                   # canton-dex package
daml build --project-root pr5333-tests                 # tests (optional)

# 2. Run tests
cd pr5333-tests && daml test
```

For a runnable local UI + backend, see [`docs/quickstart.md`](docs/quickstart.md).
For a real-testnet deployment, see [`docs/run-testnet.md`](docs/run-testnet.md).
For extending the reference, see [`docs/builder-guide.md`](docs/builder-guide.md).

## Project status

| Milestone | Focus | Status |
|---|---|---|
| M1 | Settlement-pattern + reference DEX baseline | Released |
| M2 | Constant-product pool + LP token + public testnet | Released |
| M3 | Order workflows + builder guide + integration readiness | Released |

See [`docs/architecture.md`](docs/architecture.md) for the design, and
[`docs/architecture-non-goals.md`](docs/architecture-non-goals.md) for
what is intentionally **not** in this reference and why.

## License

Apache License 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for
attributions of vendored upstream code under `vendor/`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

The repo is being shaped around a specific design direction:

- the DEX owns its own order, trade, pool, and LP contracts
- `V2.Allocation` is used to represent reserved order funds
- `V2.Allocation` is also used to represent liquidity-pool funds
- the app supports arbitrary trading pairs of `InstrumentId`
- rich asset semantics live in versioned instrument configuration, not in a
  custom settlement path
- the DEX issues its own LP token so pool shares can be held and traded as
  standard holdings

## Design Inputs

These docs are grounded in three upstream sources:

- [TradingAppV2](https://github.com/canton-network/splice/blob/token-standard-v2-upcoming/token-standard/examples/splice-token-test-trading-app-v2/daml/Splice/Testing/Apps/TradingAppV2.daml)
- [Registry workflows](https://docs.digitalasset.com/utilities/devnet/overview/registry-user-guide/workflows.html)
- [Splice PR 5333](https://github.com/canton-network/splice/pull/5333/changes)

What they imply for this repo:

- `TradingAppV2` shows the right reference posture for matched trades:
  app-owned trade state, per-authorizer allocation requests, and batch
  settlement through the token standard.
- Registry workflows make `InstrumentConfiguration` the source of truth for
  credential-gated mint, burn, and transfer and the place to attach extra
  identifiers such as ISIN or CUSIP.
- PR 5333 adds the missing allocation semantics for pool funds:
  iterated settlement, committed allocations, `Allocation_Adjust`, and
  settle results that return the rolled-forward allocation state.

## Current Status

Milestone 1 (Public Release and Initial Ecosystem Adoption) and Milestone 2
(Public Testnet and Builder Adoption) deliverables are in the repo:

- **OTC / RFQ matched-trade settlement** runs on the current TradingAppV2-style
  surface (`src/`, tests under `tests/`)
- **Constant-product pool** with add liquidity, remove liquidity, single-hop
  swap, and LP token issuance is implemented on the PR-5333-compatible branch
  (`pr5333/`, tests under `pr5333-tests/`)
- **Pool reserves** are represented by committed `V2.Allocation` slices with
  slice-local redemption semantics (`Pool_Swap` and `Pool_RemoveLiquidity`
  both touch only the slices they need)
- **LP token** is a real registry-backed instrument with its own
  `InstrumentConfiguration`, mint/burn lifecycle, and holdings
- **Registry workflows** for `InstrumentConfiguration`, credential-gated
  mint / burn / transfer, and `TransferPreapproval` are implemented
- **RFQ policy receipts** are folded into `SettlementInfo.meta` so the
  ranking the operator applied at accept time travels on-ledger with every
  allocation request and settlement

The PR-5333-dependent flows (orders, pools, swaps, LP) move forward as the
upstream branch lands. Field-name shifts in upstream are tolerated: the
acceptance criterion is preservation of design intent on the best available
V2 surface.

## Docs

- [Quickstart (M1 builder onboarding)](./docs/quickstart.md): fresh clone to passing tests
- [Operator Notes (M2 deploy / recover / observe)](./docs/operator-notes.md)
- [Architecture](./docs/architecture.md)
- [Workflow Design](./docs/workflows.md)
- [Implementation Plan](./docs/implementation-plan.md)
- [Production Build Plan](./docs/production-build-plan.md)
- [Source Dependency Status](./docs/source-dependency-status.md)
- [PR 5333 Allocation Surface](./docs/pr5333-allocation-surface.md)

## Build

- `bash scripts/build-vendored-token-standard.sh`
  - builds the vendored upstream token-standard packages and refreshes their
    `*-current.dar` artifacts
- `bash scripts/build-source-stack.sh`
  - builds the vendored source stack and then builds the local `canton-dex`
    package
- `bash scripts/run-local-daml-tests.sh`
  - rebuilds the local `canton-dex` DAR and runs the separate Daml Script test
    package under `tests/`
- `bash scripts/build-pr5333-surface.sh`
  - builds the PR-5333 token-standard API package set from
    `vendor/splice-pr5333` and then builds the local branch-only package under
    `pr5333/`
- `bash scripts/probe-pr5333-tradingappv2-build.sh`
  - checks whether the unchanged upstream `TradingAppV2` example can build on
    the PR-5333 utility layer yet and reports the known blocker when it cannot
- `bash scripts/check-tradingappv2-alignment.sh`
  - checks that the local `OTCTradeV2` workflow body stays aligned with the
    vendored upstream `TradingAppV2` source

## Package Layout

- `src/`
  - production Daml modules for the reference settlement pattern and DEX
- `tests/`
  - Daml Script validation and source-derived backend query helpers
- `pr5333/`
  - branch-only Daml package wired to the PR 5333 `AllocationV2` surface,
    including local helpers for moved admin and next-iteration funding
- `daml/README.md`
  - notes on the source-driven workflow constraints
