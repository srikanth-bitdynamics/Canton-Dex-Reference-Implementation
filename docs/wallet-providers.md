# Wallet providers & hosted-wallet support

How Canton-Dex connects to wallets, where PartyLayer fits, and which wallets can
drive which flows. Companion to `wallet-vs-dapp-boundary.md` (the trust model),
`wallet-flow-conformance-gap.md` (why LP DvP needs the canonical accept flow),
and `partylayer-probe.md` (the live capability probe).

> **Status legend:** ✅ proven on LocalNet · 🧪 planned / pending the live probe
> · ❌ not supported.

## The layering (where PartyLayer fits)

```
DEX UI (pages)
   │  emits a typed business intent
WalletIntent  ──────────────── the audit boundary (app/web/src/wallet/types.ts)
   │  one place translates intent → Daml command tree
commands.ts (composeCommands)
   │  ExerciseCommand / CreateCommand trees
WalletProvider  ─────────────── pluggable connector interface
   │   token-standard · sdk · mock · (PartyLayer →)
the wallet  ─────────────────── signs + submits (CIP-0103 prepare/sign/execute)
```

**PartyLayer is a `WalletProvider` (connector) — nothing more.** It is a CIP-0103
SDK that unifies multiple Canton wallets (Console, Loop, Cantor8, Nightly, Send)
behind one connect/discovery/session/approval surface, plus a ready
`ConnectButton`. It slots in **beside** the existing providers; it does not change
the layers above it.

## What PartyLayer does and does **not** do

**Does:** cleaner wallet onboarding (one integration, many wallets); CIP-0103
`prepareExecute` (wallet-mediated signing, not an operator relay); session +
lifecycle (`txChanged`: pending → signed → executed/failed) + error handling;
multi-wallet discovery.

**Does not:**
- **Does not replace registry choice-context fetching.** Allocation factory cids,
  `getChoiceContext`, and disclosures are still fetched **app/operator-side**
  (`services/registry-client`, surfaced through the operator `/request`
  responses). PartyLayer's docs are explicit that this stays on the dApp side
  because the endpoint varies by provider.
- **Does not replace the DEX choreography.** The operator still drives
  `/request → wallet approve → /settle`. PartyLayer only carries the wallet-
  approval step.
- **Does not move allocation construction into a raw wallet screen.** Users act in
  **our** DEX UI ("Swap", "Add liquidity") and approve a **prepared** command. They
  never hand-build allocations in a wallet's low-level allocation page. (The Splice
  Amulet manual-allocation / iterated-funding screen is a debug surface we do not
  rely on.)
- **Does not override a wallet's DAR allowlist.** A connected wallet that refuses
  third-party DARs still refuses them through PartyLayer (see Loop, below).

## DvP requirement (the gating capability)

For swap and LP add/remove, the operator settle needs the **created
`Registry.V2:Allocation` cids** and — for LP — the **`LiquidityAllocationAcceptance`
evidence cid** (see DEX-90). A provider is **DvP-ready** only if those are
recoverable. Two supported recovery paths:

1. **From the wallet result** — the provider parses created events into
   `WalletResult.createdAllocationCids` (+ `auxiliaryCids.liquidityAcceptanceCid`).
   This is what `token-standard-provider` / `sdk-provider` / `mock-provider` do.
2. **Operator discovery** — if the wallet result exposes only an `updateId`, the
   operator recovers the created `Allocation` cids (and, for LP, the
   `LiquidityAllocationAcceptance` cid) from that update's tree via the shared
   `recoverCreatedAllocations` helper (`updateId → transaction-tree-by-id`,
   classify created events by template; DEX-92). **All DvP flows support this** —
   LP add/remove (`recoverDvpAllocations`, 3 allocations + acceptance), swap, and
   order-funding (1 allocation each). A separate
   `PoolService.discoverAcceptance(requestCid)` recovers an acceptance *without*
   an updateId, keyed on the unique `originalRequestCid` — note `(lp,
   settlement.id)` is **not** unique because `poolSettlement` uses a constant
   settlement id per pool.

So "the wallet result lacks created cids" is **not** a blocker — it only decides
*which* recovery path a flow uses (dApp-return vs operator-discovery).

## Support matrix

| Provider / wallet | Connect | Read (holdings/portfolio) | OTC accept-settle | Swap DvP | LP add/remove DvP | Notes |
|---|---|---|---|---|---|---|
| `token-standard-provider` (operator-relay) | ✅ | ✅ | ✅ | ✅ | ✅ | dev/default; relays via `/v1/wallet/submit` |
| `sdk-provider` (`@canton-network/dapp-sdk`) | ✅ | ✅ | ✅ | ✅ | ✅ | CIP-0103; behind `VITE_ENABLE_SDK` |
| `mock-provider` | ✅ | ✅ | ✅ | ✅ | ✅ | deterministic cids for tests/dev |
| **Splice / Amulet wallet** (LocalNet, TSv2 branch) | ✅ | ✅ | ✅ | 🧪 | 🧪 | DvP needs DEX-90 (landed) + a live pass (DEX-94) |
| **PartyLayer** facade (Console / Nightly / Send / Cantor8) | 🧪 | 🧪 | 🧪 | 🧪 | 🧪 | Swap + LP add/remove via operator-discovery (wired). Needs the @partylayer binding + DEX-94 live pass |
| **Loop** (via PartyLayer or direct) | ✅ | ✅ | ❌ | ❌ | ❌ | refuses third-party DARs (`utility-*` allowlist only) |

Cells marked 🧪 are **planned capability**, validated by the DEX-91 probe and the
DEX-94 live DvP run — not yet proven. The matrix in `partylayer-probe.md` is filled
from that run.

## Recommended wallet paths

- **Local development / CI:** `mock-provider`, or `token-standard-provider`
  against LocalNet.
- **LocalNet end-to-end with a real wallet:** the **Splice / Amulet** wallet on the
  `token-standard-v2-upcoming` branch — the reference CIP-0103 wallet, and the
  realistic hosted-E2E target. (Loop is **not** a target: its allowlist excludes
  our DAR.)
- **Multi-wallet / demo UX:** **PartyLayer** as the connector once DEX-91/92 land —
  one integration reaching Console / Nightly / Send / Cantor8, with the canonical
  accept flow (DEX-90) underneath so DvP works through any of them that sign our
  DAR command and surface (or let the operator recover) the created cids.

## Proven vs planned (so builders aren't misled)

- **Proven on LocalNet today:** read paths + OTC accept-settle through the existing
  providers; the full LP/swap DvP *Daml + composer + backend* path (DEX-90, green
  across daml/backend/web suites).
- **Planned / pending live validation:** Amulet-driven DvP (DEX-94), and the entire
  PartyLayer column (DEX-91 probe → DEX-92 provider → DEX-93 UI). This doc's 🧪
  cells will flip to ✅ as those land; do not read them as working today.
