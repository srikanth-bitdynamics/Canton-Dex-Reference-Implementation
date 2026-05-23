# LocalNet wallet round-trip smoke

> **Purpose.** Validate the SDK provider end-to-end against a real
> CIP-0103 wallet round-trip. This is the **P2 gate** of Plan E:
> until this passes, Phases 3 + 4 (deleting the operator-relay
> providers + dropping the `/v1/wallet/submit` route) stay
> blocked, because deleting working code with no validated
> replacement would leave the dApp without a submission path.
>
> What "success" looks like in one sentence: clicking Connect Wallet
> in the dApp opens the gateway's account picker, picking an
> account returns a `WalletAccount`, and exercising an
> `accept-allocation-request` flow round-trips through the wallet
> gateway's `canton_prepareSignExecute` RPC and returns a
> `WalletResult` carrying the resulting `updateId`.

## Prerequisite stack (currently running on this box)

Confirm each is up before clicking through:

```bash
lsof -iTCP:5003 -sTCP:LISTEN -n -P   # Canton 3.5.1 JSON LAPI
lsof -iTCP:3030 -sTCP:LISTEN -n -P   # splice-wallet-kernel gateway
lsof -iTCP:8889 -sTCP:LISTEN -n -P   # mock-oauth2
lsof -iTCP:8090 -sTCP:LISTEN -n -P   # operator-backend
lsof -iTCP:8081 -sTCP:LISTEN -n -P   # dApp preview (built with VITE_ENABLE_SDK=1)
```

LocalNet state already seeded:

- Package: `canton-dex-trading 0.1.0`, hash
  `9e7bcabde7293eedf6e667261e2b528d1a09f2b2a2ebfb34fac4f25641f1d9c7`
- Parties (suffix `::1220d44f...c61424`): `dexOperator`,
  `dexLpRegistrar`, `dexAdmin`
- DexPair BTC/USDC CID:
  `00d2982e84b806ffc240bfda74088a2d3d192f9375ad02597c028182cd8a79bddf`
- Pool BTC/USDC PS_Unfunded CID:
  `00643441ba9916f81d1cfa3b4416dfd68054dff8e1161c4fc33add88d7c9f23ed2`

## Step 1 — confirm read paths work in the browser

Open `http://localhost:8081` in your browser. Expected:

- The Pools page lists one row: `BTC/USDC` Pool, status
  `PS_Unfunded`. Reserves: `0.0 / 0.0`. Comes from `/v1/pools`.
- The Trade page header shows the `BTC/USDC` pair from
  `/v1/pairs`. Order book empty.
- The Portfolio page shows "no holdings" (no holdings seeded yet).

If any of these don't render, stop and check the dApp console
for the actual API error. Common causes: stale build (`npm run
build` again with `VITE_ENABLE_SDK=1` set), wrong `VITE_API_BASE`
(should be `http://localhost:8090`).

## Step 2 — Connect Wallet → SDK provider

In the dApp's Connect Wallet menu, you should see (at minimum):

- Token Standard (legacy provider, still default)
- Canton (CIP-0103) (the SDK provider, behind `VITE_ENABLE_SDK=1`)
- Mock (dev only)
- WalletConnect (if `VITE_WC_PROJECT_ID` is set; it isn't in
  this env)

Pick **Canton (CIP-0103)**.

Expected behaviour:

1. The dApp calls `sdkInit()`. The SDK opens a websocket to the
   wallet gateway at `ws://localhost:3030/api/v0/dapp`. Watch
   `tail -f /tmp/swk/log/*.log` (or the gateway's pm2 log) to
   see the dApp connect.
2. The dApp calls `sdkConnect()`. The SDK should present a
   network picker — pick `canton:local-oauth` (the one the
   gateway has configured against the local Canton at `:5003`).
3. The gateway redirects through the mock-oauth2 IDP at `:8889`.
   For the `authorization_code` flow this is a popup. Approve.
4. Back in the dApp, `sdkListAccounts()` returns one or more
   `Wallet` records. The SDK picks the `primary` one and the
   provider stores it as the connected `WalletAccount`.
5. The header switches to "Connected as `<party>` (Canton
   CIP-0103)".

If the wallet picker shows zero wallets, the gateway has no
adapters registered — see "Troubleshooting" below.

## Step 3 — accept-allocation-request round-trip

This is the single intent currently composable through pure V2
allocation primitives (the others require a Phase-2 backend
refactor, see Plan D). You need an `OrderAllocationRequest` for
the connected party to accept.

Seed one as the operator (you can do this from the operator
backend admin UI, or by `curl` directly to the operator-backend
test endpoint if one exists). For the smoke we just want any
`AllocationRequest` template instance addressed to the connected
party.

Quickest path: use the test harness script with the LocalNet
package id (does NOT need browser):

```bash
cd /tmp/dapp-sdk-mig
CANTON_DEX_PACKAGE_ID=9e7bcabde7293eedf6e667261e2b528d1a09f2b2a2ebfb34fac4f25641f1d9c7 \
CANTON_LEDGER_URL=http://localhost:5003 \
CANTON_LEDGER_TOKEN="$(cat /tmp/ln-token.txt)" \
npx tsx scripts/testnet-v2registry-trade.ts
```

This creates the allocation request, the dApp's Activity / Inbox
page should refresh to show a pending allocation accept.

Click Accept on it. Expected:

1. The dApp calls `composeCommands(intent, ctx)` →
   `ComposedCommands{ commandId, commands, actAs }`.
2. The dApp calls `prepareExecuteAndWait({ commandId, commands,
   actAs })` from the SDK.
3. The SDK forwards over the websocket to the gateway as a
   `canton_prepareSignExecute` request.
4. The gateway prepares the submission, signs with the
   participant_admin user's CanActAs delegation (in this dev
   config — in prod this is the user's own key), executes, and
   returns the resolved transaction.
5. The dApp's `SdkProvider.submit()` resolves to
   `WalletResult{ submittedBy, primaryCid }`. The Activity page
   refreshes; the request is gone, replaced by a settled
   allocation event.

If you see this, the P2 gate is closed. Update task #6 to
completed and proceed with Plan E Phase 3 (delete operator-relay
providers).

## What to capture for the report

Either copy-paste from the browser devtools network tab or screenshot:

- The exact JSON-RPC method name on the wire — should be
  `canton_prepareSignExecute`. If it's something else (e.g.
  `canton_prepareExecute` or two separate `prepare` + `execute`
  calls) the SDK is on a different spec version than we assumed
  and `sdk-provider.ts` needs adjustment.
- The shape of the `params` field for that call.
- The shape of the result returned to the dApp (`tx` field —
  what we read `updateId` from in `sdk-provider.ts:158`).

## Troubleshooting

**Wallet picker shows zero wallets.** The gateway has no adapter
registered. Look at `/tmp/swk/wallet-gateway/test/config.json` —
the `kernel.clientType: "remote"` setting means the gateway
expects an external wallet to connect to it. For LocalNet
self-testing without a real wallet, either:

(a) Set `kernel.clientType: "local"` in the config and restart
the gateway. The gateway will then self-serve as both wallet and
dApp gateway, using the configured IDP and the local Canton at
`:5003` directly.

(b) Run one of the example wallets at
`/tmp/swk/examples/{ping,portfolio,walletconnect}` against the
gateway. None of these is full-featured but `walletconnect` is
closest.

**CORS error on `:3030`.** The gateway's `allowedOrigins` is
`["http://localhost:8080", "http://localhost:8081"]`. The dApp
must be served from one of those. Our preview is on `:8081`.

**Token audience mismatch.** Every JWT touching the JSON LAPI
must carry `aud=https://daml.com/jwt/aud/participant/participant1::1220d44fc1c3...`.
Look at `/tmp/ln-token.txt` for the working participant_admin
token; the gateway mints its own via the mock-oauth2 IDP.

**Wrong synchronizer id.** Expected:
`wallet::1220e7b23ea52eb5c672fb0b1cdbc916922ffed3dd7676c223a605664315e2d43edd`.
Visible at `GET /v2/state/connected-synchronizers?party=<any-local-party>`.

**Stale dApp build.** Vite caches aggressively. Hard-reload the
preview tab (Cmd-Shift-R) after any rebuild, or set
`VITE_ENABLE_SDK=1` directly in the shell that runs `npm run
build`.

## If this fails

Paste the failing JSON-RPC envelope (request + response) into the
chat. The diff is usually small — between what
`@canton-network/dapp-sdk@1.1.0` sends and what the gateway in
`hyperledger-labs/splice-wallet-kernel` accepts. Fixing it is one
of:

1. SDK version bump (try `^1.2.0` or `^2.0.0` if published).
2. SDK call surface change (e.g. `prepareExecuteAndWait` got
   renamed) — adjust `sdk-provider.ts:151`.
3. Network id selection — pass a specific `chainId` to
   `sdkInit({ chainId: "canton:local-oauth" })`.
