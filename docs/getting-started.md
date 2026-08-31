# Getting started: choose what you want to prove

This is Step 3 of the
[canonical newcomer learning path](README.md#canonical-newcomer-learning-path).
Steps 1–2 establish the Canton/Daml vocabulary and system boundary. This page
installs the tools and turns that model into three increasingly realistic
local proofs.

This repository has three useful local experiences, but they do not prove the
same thing. Start by choosing the result you need:

| Mode | What you run | What it proves | What it does **not** prove |
|---|---|---|---|
| **1. Browser preview** | React dApp + operator backend + seeded `InMemoryLedger` | The screens render, reads and quotes are wired, and wallet intents have the expected shape | Daml authorization, wallet signatures, Token Standard allocations, or value settlement |
| **2. Daml-engine tests** | `dpm test` through the repository scripts | Daml choices, party authorization, atomicity, rounding, and value conservation in the Daml Script runner | The browser, backend, JSON Ledger API, or a multi-node Canton deployment |
| **3. Live Canton proof** | `scripts/run-dpm-sandbox-proof.sh` | A real throwaway Canton process, JSON Ledger API, package upload, distinct LP/swapper parties, and add → quote-bound swap → partial remove DvP (delivery-versus-payment) settlement | Browser/backend HTTP integration, external-wallet compatibility, production-grade rights/topology, persistent state, or production readiness |

Within this step, run Mode 1, then Mode 2, then Mode 3. You may jump directly
to a mode when you only need its proof, but a first-time reader should keep the
order. Mode 3 is a separate throwaway Canton proof; it does not turn the Mode 1
browser preview into a live wallet dApp.

If `template`, `choice`, `party`, `participant`, or `DAR` are still unfamiliar,
pause and return to Step 1, the
[Canton and Daml primer](concepts/canton-daml-primer.md).

## Prerequisites

### For the browser preview

- [Node.js 24 or newer](https://nodejs.org/en/download).
- npm 10 or newer (installed with Node.js).
- [Git](https://git-scm.com/downloads/).
- `curl` is optional, but useful for checking the backend independently of the
  browser.

Check the installed versions:

```bash
node --version   # expected: v24.x.x or newer
npm --version    # expected: 10.x.x or newer
git --version
```

<a id="additional-tools-for-daml-builds-and-tests"></a>

### Additional tools for Daml builds, tests, and the live proof

- A JDK 17 or newer. CI uses
  [Eclipse Temurin 17](https://adoptium.net/temurin/releases/?version=17).
- [DPM](https://archived.docs.digitalasset.com/build/3.5/dpm/manual-install.html), the
  Daml Package Manager.
- The Daml SDK pinned by this repository: 3.5.2.
- Bash and `curl` for the default live-Canton proof.

Digital Asset keeps the version-pinned 3.5 manuals in its official documentation
archive. The links above intentionally use that archive so their commands match
this repository's SDK instead of a newer toolchain.

If Daml syntax itself is new, complete Digital Asset's official
[Get started with Daml](https://archived.docs.digitalasset.com/build/3.5/tutorials/get-started/index.html)
tutorial and its
[basic contracts lesson](https://archived.docs.digitalasset.com/build/3.5/tutorials/smart-contracts/contracts.html)
before the first code-change tutorial. The repository primer explains this
application's mental model; the official tutorial teaches the language.

After installing Java and DPM, install the pinned SDK once:

```bash
java -version
dpm --version
dpm install 3.5.2
```

`dpm --version` reports the DPM version, not the Daml SDK version. The
`sdk-version: 3.5.2` entries in `trading/daml.yaml` and
`trading-tests/daml.yaml` select the installed SDK when those packages build.

The Token Standard dependencies are committed DAR files under
`vendor/splice/dars/`; a first build does not need to download or compile
Splice source. Their release and package IDs are recorded in
[`../vendor/splice/VENDOR_PIN.md`](../vendor/splice/VENDOR_PIN.md).

## Mode 1: run the browser preview

The preview uses seeded TypeScript objects, not a Canton participant. Keep the
backend and frontend running in separate terminals: each development server is
a foreground process.

### 1. Clone and install

Run these one-time setup commands in any terminal:

```bash
git clone https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation.git
cd Canton-Dex-Reference-Implementation

(cd services/operator-backend && npm ci)
(cd app/web && npm ci && cp .env.example .env.local)
```

If you already cloned the repository, start from its root and run only the two
parenthesized install commands.

### 2. Terminal 1 — start the backend

From the repository root:

```bash
cd services/operator-backend
ALLOWED_ORIGINS=http://localhost:5173 npm run dev
```

`ALLOWED_ORIGINS` is required. The backend denies cross-origin browser access
when this allowlist is absent; the fact that `curl` works does not mean the
browser is allowed to read the same endpoint.

Leave the process running. A successful start ends with lines like:

```text
[operator-backend] dev server listening at http://127.0.0.1:8080
[operator-backend] parties: operator=operator-demo, lpRegistrar=lp-registrar-demo, admin=admin-demo, trader=trader-demo
```

The backend seeds:

- one active `BTC/USDC` pair and constant-product pool;
- two reserve slices per side;
- `0.2500000000 BTC` and `5000.0000000000 USDC` for `trader-demo`.

### 3. Terminal 2 — start the dApp

Open a second terminal at the repository root:

```bash
cd app/web
npm run dev
```

Vite prints a local URL, normally:

```text
Local:   http://localhost:5173/
```

Open <http://localhost:5173>. The Trade and Pools pages should show the seeded
`BTC/USDC` market. Connect **Mock Wallet (dev)** to view the seeded
`trader-demo` portfolio. The header must say `in-memory preview`, the status pill
must say `Preview · no Canton`, and the page warning must state that wallet
actions do not settle token value. Those labels are part of the safety boundary.

### 4. Terminal 3 — verify the boundary

Use a third terminal to distinguish a backend problem from a browser problem:

```bash
curl -sS http://localhost:8080/v1/status
curl -sS http://localhost:8080/v1/pairs
curl -sS http://localhost:8080/v1/pools
```

The status response contains the following stable fields; `slot` and
`serverTime` change on every run:

```json
{"network":"preview:in-memory","slot":0,"synced":true,"serverTime":"<ISO-8601 timestamp>"}
```

The pair and pool responses are JSON arrays containing `BTC`, `USDC`, and
`BTC-USDC`. If those commands succeed but the dApp reports a network error,
check that Terminal 1 includes exactly the origin printed by Vite in
`ALLOWED_ORIGINS`.

<a id="exercising-write-paths-in-demo-mode"></a>

### What is safe to explore in this mode

Use the preview to:

- inspect seeded pairs, pool reserves, prices, holdings, and order-book views;
- request a swap quote and observe fee and price-impact changes;
- inspect the screens and the wallet handoff sequence;
- see which HTTP calls the dApp makes in the browser developer tools.

Do not use it as evidence that a trade settled. The Mock Wallet waits briefly,
logs the intent, and returns fake contract IDs such as `#mock-…:0`. It has no
key and signs nothing. The backend's `InMemoryLedger` implements selected
TypeScript handlers and does not enforce Daml authorization or Token Standard
value conservation.

Write routes are deliberately closed by default. Without an operator token or
the development bypass, a state-changing request returns:

```json
{"error":"state-changing routes require DEX_OPERATOR_API_TOKEN to be configured (or DEX_DEV_OPEN=1 for the dev server)","code":"unauthorized"}
```

with HTTP status `401`.

To inspect more of the UI's write orchestration, stop Terminal 1 with
`Ctrl+C` and restart it with the explicit development-only bypass:

```bash
ALLOWED_ORIGINS=http://localhost:5173 DEX_DEV_OPEN=1 npm run dev
```

This bypass opens the non-admin operator-write gate and permits the seeded
short party names. Administrative `/v1/admin/*` routes still require
`OPERATOR_ADMIN_TOKEN`. The bypass does not create wallet signatures or V2
allocations. Canonical swap, order-funding, and liquidity paths can reach an
unimplemented multi-step Daml choice and return HTTP `501` with:

```json
{"error":"choice … is not implemented by the in-memory dev ledger. This flow requires a real Canton participant…","code":"not_supported","requestId":"…"}
```

That is an expected boundary of Mode 1, not a completed exchange flow. Never
set `DEX_DEV_OPEN=1` outside this local dev server.

## Mode 2: run the Daml-engine proofs

From the repository root:

```bash
dpm install 3.5.2
bash scripts/run-local-daml-tests.sh
```

The script first builds
`trading/.daml/dist/canton-dex-trading-v2-1.0.0.dar`, then runs the
`trading-tests` package. A successful run includes:

```text
==> Building canton-dex-trading-v2 (deps: vendor/splice/dars/*.dar)
canton-dex-trading-v2 built successfully.
…
testRealRegistryDvpSwapSettles: ok
```

At this revision, the package declares 118 Daml Script tests. Every displayed
test must end in `ok`, and the command must exit with status 0.
Workflow-specific mock-registry modules prove choreography without holdings;
real-holding suites prove value movement inside the Daml engine. The
[testing reference](reference/testing.md) explains that distinction, and the
[Daml proof map](reference/daml-proof-map.md) lists focused commands.

To run only the real-holding swap proof after the DAR has been built:

```bash
cd trading-tests
dpm test -p testRealRegistryDvpSwapSettles
```

This mode runs the Daml engine in the Script test runner. It is materially
stronger than the TypeScript `InMemoryLedger`, but it is still not a running
Canton participant and does not exercise the browser or JSON Ledger API.

Step 4, [Trace one AMM swap from formula to Daml settlement](tutorials/amm-first-walkthrough.md),
will unpack what that test proves after you complete the live checkpoint below.

<a id="mode-3-integrate-with-a-live-canton-participant"></a>

## Mode 3: run the default live-Canton proof

The default live path uses the Canton sandbox bundled with the pinned DPM SDK.
It requires no Canton DevKit, Docker, external wallet, or pre-existing network.
From the repository root run:

```bash
bash scripts/run-dpm-sandbox-proof.sh
```

The script performs the integration work that Mode 2 deliberately skips:

1. installs SDK 3.5.2 idempotently and builds the DEX DAR;
2. reserves all six Canton ports and starts a throwaway `dpm sandbox` on those
   loopback ports;
3. waits for the JSON Ledger API to become ready;
4. creates one unrestricted user only inside this unauthenticated local
   sandbox, then uses three parties: the bootstrap operator/admin/LP-registrar,
   a distinct LP/trader, and a distinct swapper;
5. uploads the current trading DAR selected by `trading/daml.yaml`; that DAR
   carries its Token Standard dependency closure;
6. creates real registry, holding, pool, slice, and LP-policy state;
7. executes add liquidity → quote-bound swap → half-LP removal through the
   JSON Ledger API;
8. checks balances, exact reserves, reserve-slice reconciliation after every
   phase, LP holding/supply/policy consistency, `x*y` nondecrease,
   reserve-per-LP, and total value conservation;
9. stops Canton and removes the temporary state after a pass (logs are kept on
   failure).

The visible phases include:

```text
==> Installing the pinned SDK and building the DEX
==> Starting throwaway Canton sandbox on reserved loopback ports
==> Uploading the package closure
==> Running the live-Canton DvP proof
==> PASS: portable live-Canton proof completed
    The throwaway sandbox is now stopping; no persistent ledger state remains.
```

If a phase fails, the script exits non-zero and prints the preserved temporary
directory containing `canton.log` and `canton.stdout.log`.

### What this live proof establishes

This is the first local mode that starts Canton and submits through the real
JSON Ledger API. A pass establishes that the current package closure uploads
and that real V2 holdings move atomically across an add, a snapshot-bound swap,
and a partial LP redemption. The assertions cover both accounting state and
its backing slices, not merely successful command submission.

The LP/trader and swapper are separate from the operator and from each other.
Operator, asset admin, and LP registrar deliberately share the bootstrap
party; one unrestricted sandbox-only user can act for all three parties.
Authentication is disabled and its bearer value is a non-secret placeholder.
The proof therefore does **not** establish:

- production-grade separation of operator, admin, and registrar credentials;
- the operator HTTP server or React browser path;
- a CIP-0103, PartyLayer, WalletConnect, or other external wallet;
- a persistent Splice LocalNet or multi-participant topology;
- production identity, security, operations, governance, or compliance.

Read [Local Canton from a clean clone](guides/localnet.md) for every phase and
failure mode. That guide also documents an **optional** persistent DevKit
LocalNet. `canton-devkit` is a separately distributed development helper; the
DEX code and DARs have no runtime dependency on it. If it is not already
available in your environment, use the DPM sandbox path.

### From live proof to live browser integration

A real browser settlement is a larger deployment. It additionally needs full
Canton party IDs and separated ledger rights, long-lived registry and market
state, backend package/contract configuration, credentials, explicit CORS, and
a compatible wallet that returns enough correlation data for settlement.
Continue with:

- [Run on a testnet](guides/run-on-testnet.md) — participant-backed backend and
  wallet configuration.
- [Deployment](guides/deployment.md) — backend/Docker environment and bootstrap
  options.
- [Validator test plan](guides/validator-test-plan.md) — validate the configured
  live system rather than assuming it works.
- [Testing reference](reference/testing.md) — the proof boundary of every test
  layer and live driver.

Do not call the browser path complete until a real trader party's pre-trade and
post-trade holdings differ by the expected amounts and the corresponding Canton
transaction is visible to the authorized parties.

## Repository map for a first code read

| Path | Read it for | Skip on the first pass |
|---|---|---|
| `trading/CantonDex/Dex/` | DEX templates and choices: pair, pool, swap, liquidity, order, RFQ | registry internals |
| `trading/CantonDex/Registry/V2.daml` | Reference holdings, allocations, and batch settlement | detailed choice context until the workflow is clear |
| `trading-tests/CantonDex/Tests/` | Executable examples and invariants | boilerplate fixtures; start from the named tests in the AMM tutorial |
| `services/operator-backend/src/` | HTTP orchestration, matcher, ledger adapters | production recovery on the first pass |
| `app/web/src/` | Pages, wallet intents, and API calls | individual wallet-provider implementations |
| `vendor/splice/dars/` | Pinned binary Token Standard dependencies | do not try to learn Daml from binary DARs |

The [Canton and Daml primer](concepts/canton-daml-primer.md) explains how these
layers meet. The [glossary](concepts/glossary.md) is the lookup page for names
encountered in code.

## Component checks

These checks are useful after the first preview. They are independent; none of
them turns Mode 1 into a real Canton settlement.

| Component | Command from repository root | Success signal | Limitation |
|---|---|---|---|
| Daml | `bash scripts/run-local-daml-tests.sh` | every Daml test is `ok`; exit 0 | Script runner, not a participant |
| Live Canton | `bash scripts/run-dpm-sandbox-proof.sh` | ends with `==> PASS: portable live-Canton proof completed`; exit 0 | unrestricted throwaway user and direct JSON API driver; no browser, external wallet, or operator HTTP server |
| Backend | `cd services/operator-backend && npm run typecheck && npm test` | TypeScript exits cleanly; TAP ends with `# fail 0` | mocked/in-memory ledgers unless live tests are explicitly configured |
| dApp | `cd app/web && npm test && npm run build` | Vitest reports all tests passed; Vite writes `dist/` | mocked browser/API environment |
| HTTP smoke | `bash scripts/backend-http-smoke.sh` | ends with `==> All backend HTTP smoke checks passed` | selected reads, quote, and auth gate only; no browser, wallet, or settlement |

Run `npm ci` in the backend and dApp directories before their component checks.
The HTTP smoke script expects backend dependencies to be installed already;
the DPM sandbox proof installs them itself when its `tsx` runner is absent.

## Troubleshooting

| Symptom | Meaning and fix |
|---|---|
| Browser says network/CORS error, but `curl` works | Restart the backend with `ALLOWED_ORIGINS=http://localhost:5173`; use the exact origin Vite printed. |
| A write returns `401` | Expected in the default preview. Use `DEX_DEV_OPEN=1` only if you intentionally want the local write-orchestration preview. |
| A flow returns `501 not_supported` | Expected when it needs an allocation-backed Daml choice absent from the TypeScript in-memory ledger. Use Mode 2 to prove the contract or Mode 3 for a real-ledger proof. |
| A result contains `#mock-…:0` | It came from Mock Wallet; it is not a Canton contract ID and proves no submission occurred. |
| `/v1/*` says “method not allowed” on port 8080 | Another process, often Docker, owns the port. Start the backend with `PORT=8091 ALLOWED_ORIGINS=http://localhost:5173 npm run dev`, then set `VITE_API_BASE=http://127.0.0.1:8091` in `app/web/.env.local` and restart Vite. |
| `dpm: command not found` | Install DPM using the prerequisites link, then open a new shell. |
| DPM cannot find SDK 3.5.2 | Run `dpm install 3.5.2`, then retry from a directory containing the relevant `daml.yaml`. |
| The DPM sandbox proof fails | Use the preserved log directory printed by the script; check Java 17, local memory, and port-binding errors. |
| Native npm dependency fails to install | Confirm Node 24 is active, remove only that component's `node_modules`, and rerun `npm ci` in the same component. |

**Next canonical step:** [AMM-first walkthrough](tutorials/amm-first-walkthrough.md).
Use the [testing reference](reference/testing.md) when you need the complete
proof matrix, or return to [all documentation](README.md).
