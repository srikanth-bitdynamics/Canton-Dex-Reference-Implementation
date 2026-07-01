# Overview

Canton DEX is a runnable **reference implementation** of exchange workflows on
the Canton Network. It shows how market state, wallet-authorized funding,
registry-defined holdings, Token Standard V2 allocations, and atomic settlement
batches fit together in one application — as real Daml workflows and a working
dApp, not just diagrams.

If you want to run it, go to **[Getting Started](../getting-started.md)**. This
page explains *why it is shaped the way it is*.

## What it demonstrates

- **Token-standard-native funds movement.** Value moves through V2 holdings,
  allocations, allocation requests, and settlement factories — not a custom
  off-ledger balance model.
- **A strict authority boundary.** The operator can only submit the commands it
  is authorized to submit; every movement of *trader* assets is authorized by
  the trader's own wallet.
- **Concrete settlement patterns.** RFQs, matched trades, prefunded orders,
  swaps, and LP add/remove are each implemented as delivery-versus-payment
  settlement over V2 allocations.

> **This is a reference implementation, not an audited production exchange.**
> It is built for learning, evaluation, demos, and forks. Production adopters
> should do their own security review, operational hardening, compliance work,
> and version-compatibility checks.

## The standards it builds on

| Standard | What it is | Role here |
|---|---|---|
| **CIP-0056** — Canton Network Token Standard | The base token standard (holdings, transfers, metadata). | The foundation the V2 revision extends. |
| **CIP-0112** — Token Standard **V2** | The privacy / performance / traditional-accounting revision, adding the allocation + settlement surface. | Every asset (base, quote, and LP token) is a V2 instrument; funds move via V2 allocations and settlement factories. |
| **CIP-0103** — dApp Standard | The wallet interaction standard (prepare → sign → execute interactive submission). | The dApp hands *trader-authority* commands to a wallet over CIP-0103 rather than submitting them itself. |

Token Standard V2 has **merged into `canton-network/splice` `main`** and
becomes the network default from **mid-July 2026**. This repo vendors the V2
sources at a pinned commit — see
[`../../vendor/splice/VENDOR_PIN.md`](../../vendor/splice/VENDOR_PIN.md) and the
[Allocation Surface](../reference/allocation-surface.md) reference for the exact
surface it relies on.

## The trust model

The single most important design idea is **who is allowed to move what**. Four
authorities, each with a distinct responsibility:

| Authority | Owns | Example |
|---|---|---|
| **DEX contracts** | Market state and workflow validation. | An `Order` records price/size and enforces matching rules. |
| **Token Standard contracts** | Asset reservation and settlement. | An `Allocation` locks a holding; `SettlementFactory_SettleBatch` settles atomically. |
| **Registry** | Instrument semantics and choice context. | The registry says what a holding *is* and supplies the context a settlement needs. |
| **Wallet + operator** | Submission authority. | The **wallet** submits trader-authority commands (funding, allocation creation); the **operator** submits only the commands it is authorized to (binding orders, matching, settling batches). |

The operator backend **never** moves a trader's assets on its own. When a
trader funds an order, adds liquidity, or authorizes a swap, that command is
composed by the dApp and signed by the trader's wallet over CIP-0103. The
operator orchestrates and settles only what it is authorized to submit.

See [Architecture](architecture.md) for the component boundaries and
[Workflows](workflows.md) for how each flow choreographs these authorities.

## The components

```text
┌────────────────────────────────────────────────────────────┐
│  React dApp  (app/web)                                      │
│  Trade · Pools · Orders · RFQ · Portfolio · Admin           │
│  ── wallet boundary (CIP-0103): trader-authority commands ──│
└───────────────┬─────────────────────────┬──────────────────┘
                │ reads + operator APIs    │ trader-signed submissions
                ▼                          ▼
┌───────────────────────────────┐   ┌──────────────────────────┐
│  Operator backend             │   │  Wallet                  │
│  (services/operator-backend)  │   │  (external, CIP-0103)    │
│  HTTP API · matcher · indexer │   │                          │
│  · idempotency · recovery     │   │                          │
└───────────────┬───────────────┘   └────────────┬─────────────┘
                │ operator-authority              │ trader-authority
                ▼ JSON Ledger API submissions     ▼
┌────────────────────────────────────────────────────────────┐
│  Canton ledger  (trading/ — canton-dex-trading Daml package)│
│  DEX app: DexPair, Order, Rfq, MatchedTrade, Pool, PoolState│
│  LP component: LPTokenPolicy                                │
│  Token Standard V2 + reference registry: Holding, Allocation│
│  AllocationRequest, SettlementFactory                       │
└────────────────────────────────────────────────────────────┘
```

- **[`trading/`](../../trading/)** — the `canton-dex-trading` Daml package: DEX
  templates, the LP-token component, and a reference V2 registry.
- **[`services/operator-backend/`](../../services/operator-backend/)** — the
  operator HTTP API, JSON Ledger API driver, matcher, indexer, idempotency, and
  recovery. Ships an in-memory dev ledger so the stack runs with no Canton.
- **[`app/web/`](../../app/web/)** — the React dApp and its wallet-provider
  boundary (Mock, CIP-0103 SDK, WalletConnect, PartyLayer, and more).
- **The registry is external.** The reference ships one, but Token Standard V2
  does not require this exact registry — see
  [Registry Integration](../guides/registry-integration.md).

## Where to go next

- **Run it:** [Getting Started](../getting-started.md)
- **Read the design:** [Architecture](architecture.md) → [Workflows](workflows.md)
- **Build on it:** [Builder Guide](../guides/builder-guide.md)
- **Look up a term:** [Glossary](glossary.md)
