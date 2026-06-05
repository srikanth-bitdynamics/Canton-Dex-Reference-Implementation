# DEX-91 — PartyLayer execution-capability probe

> Validate PartyLayer against the **exact** DEX wallet requirements before wiring
> it into the main UI (DEX-92/93) or live-testing DvP (DEX-94). PartyLayer is a
> wallet **connector** (CIP-0103), not a wallet and not a protocol layer.

## Outcome: **GO for DvP — via operator-discovery.** ✅

Most of the probe was resolved from the **published package type declarations**
(`@partylayer/sdk@0.4.1`, `@partylayer/core@0.3.1`, `@partylayer/react@0.4.5`) — no
live wallet required. The one architectural decision (dApp-return vs
operator-discovery for created cids) is now settled: **operator-discovery**,
because the submit result is `updateId`-only.

## Resolved from source

### API surface (what DEX-92 builds against)

`@partylayer/sdk`:
```ts
declare function createPartyLayer(config: PartyLayerConfig): PartyLayerClient;
// PartyLayerClient:
connect(options?: ConnectOptions): Promise<Session>;
disconnect(): Promise<void>;
getActiveSession(): Promise<Session | null>;
listWallets(filter?: WalletFilter): Promise<WalletInfo[]>;
signTransaction(params: SignTransactionParams): Promise<SignedTransaction>;
submitTransaction(params: SubmitTransactionParams): Promise<TxReceipt>;
ledgerApi(params: LedgerApiParams): Promise<LedgerApiResult>;
on/off(event, handler); asProvider(): CIP0103Provider;
```
`@partylayer/react`: `PartyLayerKit{ network: 'devnet'|'testnet'|'mainnet', appName, adapters[] }`,
`usePartyLayer()→client`, `useConnect`, `useWallets`, `useSubmitTransaction`,
`useLedgerApi`, `ConnectButton`, `WalletModal`.

### Q1 — signing is wallet-mediated ✅
`signTransaction`/`submitTransaction` execute through the wallet **adapter + session**;
there is no operator relay. Matches "writes go through the wallet."

### Q2/Q3 — created cids are NOT in the wallet result ❌ (decisive)
```ts
interface TxReceipt { transactionHash; submittedAt; commandId?; updateId?; }
interface CIP0103TxExecutedPayload { status: 'executed'; commandId;
  payload: { updateId: string; completionOffset: number }; }
```
The submit result carries **only `updateId`** (+ commandId/offset). There is **no
transaction tree, no `createdEvents`, no contract ids**. So the created
`Registry.V2:Allocation` cids and the `LiquidityAllocationAcceptance` cid (DEX-90)
**cannot** be read from the wallet result. → recovery must be operator-side.

### Q4 — lifecycle states ✅
`CIP0103TxStatus = 'pending'|'signed'|'executed'|'failed'`;
SDK `TransactionStatus = 'pending'|'submitted'|'committed'|'rejected'|'failed'`.
User-reject surfaces as `rejected`/`failed`. Maps cleanly to UI states.

### Q5 — adapters (no Amulet adapter) ⚠️
Published adapters: **Bron, Console, Nightly, Send, Cantor8, Loop** (+
`adapter-starter` template). **There is no Amulet/Splice adapter**, and the
`network` enum is `devnet|testnet|mainnet` (**no `localnet`**). Consequences:
- Our LocalNet reference wallet (**Amulet**) is **not** reached via PartyLayer —
  it stays on the existing `token-standard` / `sdk` providers.
- PartyLayer's value is reaching **Console / Nightly / Send / Cantor8 / Bron** through one integration.
- **Loop** is present but refuses third-party DARs (`utility-*` allowlist, Plan F) → out for our DAR.

## Decision and how it shapes DEX-92

**GO, via operator-discovery.** The `PartyLayerProvider.submit()` returns
`{ primaryCid: updateId }` and does **not** attempt to parse created cids. The
operator recovers them, reusing code already built in DEX-90:
- `updateId → /v2/updates/transaction-tree-by-id` (`json-api.ts`) → the created `Allocation` cids;
- `discoverAcceptance(lp, settlement.id)` → the `LiquidityAllocationAcceptance` cid.

So the dApp's `/settle` call, on the PartyLayer path, forwards the **settlement id**
(which it has from `/request`) instead of cids, and the operator discovers them.
(Alternative: the dApp itself calls `ledgerApi` GET the tree by `updateId` — but
operator-discovery is cleaner and reuses existing code.)

## Capability matrix

| Adapter | In PartyLayer | Signs our 3rd-party DAR cmd | DvP-ready (with operator-discovery) |
|---|---|---|---|
| Console | ✅ | 🧪 live | 🧪 |
| Nightly | ✅ | 🧪 live | 🧪 |
| Send | ✅ | 🧪 live | 🧪 |
| Cantor8 | ✅ | 🧪 live | 🧪 |
| Bron | ✅ | 🧪 live | 🧪 |
| Loop | ✅ | ❌ (utility-* allowlist) | ❌ |
| Amulet / Splice | ❌ (no adapter) | n/a — use token-standard/sdk provider | ✅ via existing provider |

## Remaining genuinely-live items (LocalNet/devnet — user-driven)

1. **Which adapter(s) sign our `canton-dex-trading` DAR command** (Console / Nightly
   / Send / Cantor8 / Bron). This is the only true unknown; the rest is resolved.
2. **Target network for the live run** — PartyLayer has no `localnet` mode, so
   either point `registryUrl` at LocalNet (+ possibly a `starter` adapter) or run
   the DvP E2E on **devnet**.
3. **Confirm `SubmitTransactionParams` accepts a raw Daml command tree**
   (`ExerciseCommand`) — the type name is known; confirm the field shape on first
   submit.

## Spike procedure (live)

> A complete, runnable spike implementing the loop below lives at
> **`spike/partylayer/`** (isolated Vite app; `npm install && npm run dev`). See
> its `README.md` for the turnkey runbook. The steps below are what it does.

1. `PartyLayerKit network=devnet appName=Canton-Dex adapters=[console,nightly,send,cantor8]`,
   mount `ConnectButton` on a throwaway route.
2. `useConnect().connect()`; capture the `Session` / party.
3. `useSubmitTransaction().submitTransaction({ commands: <a harmless Holding_Split> })`;
   log the `TxReceipt`. Confirm `updateId` present, signing happened in-wallet.
4. Submit a real `add-liquidity` batch (accept + 3 allocates from `/request`); log the receipt.
5. `useLedgerApi().ledgerApi({ requestMethod:'GET', resource:'/v2/updates/transaction-tree-by-id/<updateId>' })`
   and confirm the `Allocation` + `LiquidityAllocationAcceptance` creates are
   recoverable by `updateId` (proves the operator-discovery path end-to-end).
6. Record which adapters completed steps 3–4; fill the matrix's "Signs our DAR" column.
