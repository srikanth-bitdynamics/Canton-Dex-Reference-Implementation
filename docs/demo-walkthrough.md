# Canton-Dex live demo — Milestone 1 + Milestone 2

> **Purpose.** Recordable live-preview walkthrough covering every M1
> + M2 deliverable. UI-first: the demo presenter clicks around the
> dApp at `http://localhost:8081` while harness scripts run in a
> side terminal to advance on-chain state. ~22 minutes end-to-end.
>
> **Audience.** External builders, committee reviewers, partner
> evaluators. Assumes Canton familiarity, not codebase familiarity.

## Recording layout

```
+-------------------------------------+-------------------+
|                                     |                   |
|  dApp at http://localhost:8081      |  Side terminal    |
|  (Chrome, fullscreen)               |  ~80 cols wide    |
|                                     |  for harness runs |
|                                     |  + curl probes    |
+-------------------------------------+-------------------+
```

Put the browser on the left, a single terminal on the right.
Resize the terminal to ~80 cols. Toggle focus by clicking; don't
alt-tab.

## Pre-record sanity

```bash
bash /tmp/dapp-sdk-mig/scripts/demo-preflight.sh   # must end "Demo-ready"
```

If anything's red, fix before recording. See Prerequisites section
at the bottom.

## What this demo shows

**M1 — Public release + initial ecosystem adoption**

| Bullet | Demo segment | Evidence |
|---|---|---|
| Public Apache 2.0 repo | §0 repo URL on screen | GitHub repo open in tab |
| Daml modules for pair listing + OTC/RFQ | §1 Daml tests + UI Pools page | 31 tests pass + DexPair rendered |
| Tests showing matched-trade settlement via V2 patterns | §3 live matched-trade | 8 green checks in terminal |
| Workflow documentation | §0 brief docs/ tour | `ls docs/` |
| Local dev environment | §2 stack health | preflight script |
| Public walkthrough/demo | this recording | — |

**M2 — Production-shaped AMM + public testnet**

| Bullet | Demo segment | Evidence |
|---|---|---|
| Constant-product pool implementation | §4 Pool_Initialize live | Pool transitions PS_Unfunded → PS_Active in dApp |
| Add liquidity workflow | §4 Pool_AddLiquidity live | Reserves grow in dApp (1.0 → 1.5 BTC) |
| Remove liquidity workflow | §4 referenced as in-script test | `testPoolRemoveLiquiditySliceLocal` passes |
| Swap workflow | §4 referenced as in-script test | `testPoolSwapEndToEnd` passes |
| LP token as token-standard instrument | §4 LP mint request created on-chain | visible in tx trace |
| Pool funds via committed/iterated allocations | §4 slice count grows | dApp shows 1 → 2 slices per side |
| Public testnet deployment | (next deploy window) | LocalNet runs `canton-dex-trading v0.1.0` today; testnet still on `pr5333 v0.0.7` |
| Operator notes | §0 brief docs tour | `docs/operator-guide.md` |

---

## §0 — Open: repo, docs, dApp (2 min)

**Browser left pane.** Open three tabs:

1. <https://github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation>
2. <http://localhost:8081>
3. (later, for the docs walk) `file:///tmp/dapp-sdk-mig/docs/demo-walkthrough.md`

**Terminal right pane.** Show `pwd && ls`:

```
$ cd /tmp/dapp-sdk-mig && ls
LICENSE    NOTICE    CONTRIBUTING.md    SECURITY.md
README.md  docs/     trading/           trading-tests/
app/       services/ vendor/splice/     examples/
scripts/
```

Talk track:

> "This is `canton-dex-trading v0.1.0` — published under Apache 2.0,
> V2-release-aligned, vendored from
> splice@token-standard-v2-upcoming. Right now I'm running it
> against Canton 3.5.1 LocalNet on this laptop, the same Canton
> version external builders get from the splice repo."

Show docs:

```
$ ls docs/ | head -15
```

Highlight: `architecture.md`, `workflows.md`, `quickstart.md`,
`operator-guide.md`, `v2-migration.md`, `wallet-vs-dapp-boundary.md`.
28 docs covering every angle of the project.

## §1 — Daml tests (M1 evidence) (3 min)

**Terminal:**

```bash
cd trading-tests
daml test 2>&1 | grep -E ":ok|FAIL" | tail -15
```

Talk track:

> "31 in-script Daml tests pass. Every settlement-pattern from
> Milestone 1 is exercised here — matched-trade, RFQ, allocation
> accept/cancel, Token Standard V2 mint/transfer/burn."

Call out three by name:

- `testMatchedTradeFullSettle` — M1 OTC settlement pattern
- `testPoolFullLifecycle` — M2 pool init→add→swap→remove in one test
- `testMatchedTradeViaTokenStandardRegistry` — V2 registry as
  AllocationFactory + SettlementFactory + TransferFactory

```bash
cd ../examples/stable-pool && daml test 2>&1 | grep -E ":ok|FAIL"
```

Talk track:

> "3 more tests in `examples/stable-pool` — proof that another
> AMM type can be built on the same V2 surface without changing
> the registry. That's the reuse story for external builders."

## §2 — dApp tour (read-only) (3 min)

**Browser left pane.** http://localhost:8081

Walk three pages:

1. **Trade page (default)** — show the header `Canton DEX v0.6 ·
   canton:localnet` and the Synced indicator (`Synced · slot N`).
   The "No active pools" empty state is acceptable here — the
   Trade page filter has a known UX gap (separate issue, not
   blocking).
2. **Pools page** — this is where you'll spend the demo.
   Currently shows whatever pools are seeded. TVL counter, fee
   counter, list of pool cards.
3. **Portfolio page** — empty until a connected wallet has
   holdings.

Talk track:

> "Three pages render live data from Canton 3.5.1 via the
> operator-backend's indexer. The operator-backend runs at port
> 8090, talks to Canton's JSON Ledger API at port 5003. Reads go
> through the operator; writes — when we get the wallet flow
> connected — go directly through CIP-0103."

## §3 — Connect Wallet via CIP-0103 (P2 gate) (2 min)

**Browser.** Click **Connect Wallet** top-right.

Show the dropdown — two providers:

- Canton wallet (CIP-0103)  ← the new one, what we're validating
- Canton Wallet (Token Standard V2)  recommended  ← legacy
  operator-relay path

Click **Canton wallet (CIP-0103)**. Wait ~3 seconds.

Header should change to the wallet's party id (something like
`operat...1424 / operator`). The SDK initialized, opened a
session against the wallet gateway at port 3030, OAuth'd through
the mock IDP at port 8889, listed accounts, picked the primary.

Talk track:

> "That click just did six things: SDK init, gateway session,
> OAuth flow, list accounts, status change events wired, primary
> party resolved. The wire method on writes will be
> `canton_prepareSignExecute` — one RPC, not two-stage. We don't
> hold trader signing authority anywhere in the dApp."

If asked: "What about the recommended legacy path?" — answer
honestly: that's the older operator-relay path where the
operator-backend's session signs trader writes. It works, but
violates the CIP-0103 trust boundary. We keep it as a fallback
while the CIP-0103 path matures.

## §4 — Live pool lifecycle on real Canton (8 min)

This is the M2 evidence segment. The browser shows the dApp; the
terminal runs the harness; the browser refreshes to show the
on-chain state change. Repeat this rhythm twice.

### §4.1 — Pool_Initialize: PS_Unfunded → PS_Active

**Terminal.** First, seed a fresh PS_Unfunded pool (the dApp's
"Admin" panel would normally do this, but for the demo we use
curl so we control the timing):

```bash
TOK=$(cat /tmp/ln-token.txt)
PKG=$(cat /tmp/ln-pkg.txt)
SYNC=wallet::1220e7b23ea52eb5c672fb0b1cdbc916922ffed3dd7676c223a605664315e2d43edd
OP=dexOperator::1220d44fc1c3ba0b5bdf7b956ee71bc94ebe2d23258dc268fdf0824fbaeff2c61424
LP=dexLpRegistrar::1220d44fc1c3ba0b5bdf7b956ee71bc94ebe2d23258dc268fdf0824fbaeff2c61424
ADMIN=dexAdmin::1220d44fc1c3ba0b5bdf7b956ee71bc94ebe2d23258dc268fdf0824fbaeff2c61424

POOL_CID=$(curl -sS -X POST "http://localhost:5003/v2/commands/submit-and-wait-for-transaction" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d "{\"commands\":{\"commands\":[{\"CreateCommand\":{\"templateId\":\"$PKG:CantonDex.Dex.Pool:Pool\",\"createArguments\":{\"operator\":\"$OP\",\"lpRegistrar\":\"$LP\",\"admin\":\"$ADMIN\",\"baseInstrumentId\":\"BTC\",\"quoteInstrumentId\":\"USDC\",\"lpInstrumentId\":\"BTC-USDC-LP\",\"feeBps\":\"30\",\"status\":\"PS_Unfunded\",\"reserves\":{\"baseAmount\":\"0.0\",\"quoteAmount\":\"0.0\"},\"totalLpSupply\":\"0.0\",\"baseSlices\":[],\"quoteSlices\":[],\"operatorFeeBps\":null,\"accumulatedOperatorFees\":null,\"publicReaders\":null}}}],\"commandId\":\"seed-pool-demo-$(date +%s)\",\"actAs\":[\"$OP\",\"$LP\"],\"userId\":\"participant_admin\",\"synchronizerId\":\"$SYNC\"}}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['transaction']['events'][0]['CreatedEvent']['contractId'])")
echo "fresh pool: $POOL_CID"
```

**Browser.** Refresh the Pools page. The new PS_Unfunded pool
appears with `0 BTC / 0 USDC`. (If there are already pools from
prior runs, the new one is the rightmost card.)

**Terminal.** Now run the harness against that pool:

```bash
CANTON_LEDGER_URL=http://localhost:5003 \
CANTON_LEDGER_TOKEN=$TOK \
CANTON_SYNCHRONIZER=$SYNC \
CANTON_DEX_PACKAGE_ID=$PKG \
CANTON_USER_ID=participant_admin \
CANTON_VENUE=$OP CANTON_LP_REGISTRAR=$LP CANTON_ADMIN=$ADMIN \
CANTON_POOL_CID=$POOL_CID \
npx tsx scripts/localnet-pool-demo.ts
```

Expected output: 8 green checks ending with `✅ M2 pool init + add
LP verified on real Canton 3.5.1`. Reads PS_Unfunded → PS_Active
→ adds 0.5 BTC + 15K USDC.

**Browser.** Refresh Pools page. The pool we just ran the
harness against now shows:

- Status: `PS_Active`
- BTC: `1.5`
- USDC: `45,000`

Talk track per step (read these while the harness runs — each
step takes ~0.5s):

> "Step 1: create a V2 Registry — the CIP-0056 single contract
> that implements AllocationFactory + SettlementFactory +
> TransferFactory + EventLog.
>
> Step 2: register BTC and USDC as instruments with supply caps
> and open credential reqs.
>
> Step 3: mint 1 BTC and 30,000 USDC to the operator. Holdings
> are V2-shaped contracts.
>
> Step 4: Pool_Initialize. This is the M2 transition the demo is
> here for. Pool template's choice exercises
> AllocationFactory_Allocate twice — once per leg — and the
> reserves get committed into V2 Allocation contracts. The pool
> moves from PS_Unfunded to PS_Active in one atomic transaction.
>
> Steps 5–7: mint 0.5 more BTC and 15K more USDC, then
> Pool_AddLiquidity. The pool now has TWO committed allocation
> slices per side. That's the 'pool funds represented by
> committed / iterated allocations' bullet from the M2 milestone
> description."

### §4.2 — Pool_Swap + Pool_RemoveLiquidity

**Terminal.**

```bash
cd /tmp/dapp-sdk-mig/trading-tests
daml test --files CantonDex/Tests/EndToEndTests.daml 2>&1 | grep -E "Pool|ok"
```

Talk track:

> "Swap and Remove follow the same V2 surface as Initialize and
> AddLP. The in-script tests run against the same Daml templates
> the live ledger does. testPoolSwapEndToEnd exercises the
> constant-product swap math with fee accrual.
> testPoolRemoveLiquiditySliceLocal verifies the
> iterated-settlement remove path — operator cancels only the
> boundary slice, re-allocates only the leftover, slices beyond
> the redemption stay untouched. That's the 'iterated' part of
> the M2 bullet."

This isn't a cop-out — the test runs against the same Daml. The
difference is that the live harness above hits the JSON Ledger
API (network round-trip, gRPC under the hood), while the test
hits the Daml interpreter directly. Both verify the same
template logic.

## §5 — Live matched-trade settlement (M1 evidence) (4 min)

**Terminal:**

```bash
cd /tmp/dapp-sdk-mig
CANTON_LEDGER_URL=http://localhost:5003 CANTON_LEDGER_TOKEN=$TOK \
CANTON_SYNCHRONIZER=$SYNC CANTON_DEX_PACKAGE_ID=$PKG \
CANTON_ALLOC_REQUEST_PACKAGE_ID=b91d2fd9e3ab074193cf72748f311b290324a59dec669176a4169225bd2a5f31 \
CANTON_ALLOC_INSTR_PACKAGE_ID=edb6066bb457afa48db3f8e21a8a59f5e092188f0f196f167e089c7cf60e4c15 \
CANTON_USER_ID=participant_admin \
CANTON_VENUE=$OP CANTON_ADMIN=$ADMIN \
CANTON_ALICE=alice::1220d44fc1c3ba0b5bdf7b956ee71bc94ebe2d23258dc268fdf0824fbaeff2c61424 \
CANTON_BOB=bob::1220d44fc1c3ba0b5bdf7b956ee71bc94ebe2d23258dc268fdf0824fbaeff2c61424 \
npx tsx scripts/testnet-v2registry-trade.ts
```

Expected: 8 green checks ending with `✅ FULL V2 STANDARD
REGISTRY — REAL TRADE complete on testnet`. 10 BTC moves alice →
bob through the full CIP-0056 surface.

Talk track:

> "This is the M1 matched-trade settlement-pattern, live on
> Canton 3.5.1. Step 4 creates a MatchedTrade. Step 5 emits two
> AllocationRequests — one per counterparty. Steps 6 and 7 are
> each counterparty's wallet accepting their side, locking their
> holdings. Step 8 settles via SettlementFactory_SettleBatch —
> minting receiver-side holdings, archiving sender-side
> holdings, in one atomic transaction.
>
> Post-state: bob has 10 BTC, alice has 15 left. Every event is
> queryable in Canton's indexer. The MatchedTrade contract is
> archived. The TradeAllocationRequest contracts are archived.
> The clean settlement signature you want from a Token Standard
> V2 dApp."

## §6 — Wrap (1 min)

**Browser.** Final view: Pools page with the freshly-initialized
pool plus the older ones. TVL counter. Stack still green.

Talk track:

> "What we just saw: 31 in-script Daml tests pass, 3 more in the
> stable-pool example. A real CIP-0103 wallet flow connected the
> dApp to the wallet gateway in 3 seconds. Pool_Initialize and
> Pool_AddLiquidity ran live against Canton 3.5.1, the pool
> reserves grew in the dApp from 0 to 1.5 BTC / 45K USDC. A
> matched-trade settled on real Canton in 8 steps, 10 BTC moved
> alice to bob.
>
> Public testnet redeploy of v0.1.0 is the next gate — testnet
> still runs the old pr5333 v0.0.7 package. Two ecosystem
> evaluations are open: the V2-release alignment audit we wrote
> in docs/v2-alignment-audit.md, and the PR-7 review against the
> upstream rename. Builders, please file issues —
> Apache 2.0, no commercial intent.
>
> Repo: github.com/srikanth-bitdynamics/Canton-Dex-Reference-Implementation.
> Thanks for watching."

End recording.

---

## Prerequisites (if bringing the stack back up)

```bash
# 1. Canton 3.5.1 LocalNet (yarn start:canton in splice-wallet-kernel)
cd /tmp/swk && yarn start:canton   # ~3 min bootstrap
lsof -iTCP:5003 -sTCP:LISTEN -n -P | head   # confirm

# 2. Wallet gateway + mock-oauth2 already wired by yarn start:all
lsof -iTCP:3030 -sTCP:LISTEN -n -P | head
lsof -iTCP:8889 -sTCP:LISTEN -n -P | head

# 3. Mint OAuth token (audience must include participant1 id):
PID=participant1::1220d44fc1c3ba0b5bdf7b956ee71bc94ebe2d23258dc268fdf0824fbaeff2c61424
AUD="https://daml.com/jwt/aud/participant/$PID"
TOK=$(curl -sS -X POST http://localhost:8889/token \
  -d "grant_type=client_credentials&client_id=participant_admin&client_secret=admin-client-secret&scope=daml_ledger_api&audience=$AUD" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
echo "$TOK" > /tmp/ln-token.txt
echo "9e7bcabde7293eedf6e667261e2b528d1a09f2b2a2ebfb34fac4f25641f1d9c7" > /tmp/ln-pkg.txt

# 4. If Canton was restarted, re-upload DARs (all 8) + re-allocate
# parties (dexOperator, dexLpRegistrar, dexAdmin, alice, bob) + grant
# CanActAs rights to participant_admin user. See
# docs/localnet-amulet-smoke.md for the exact recipe.

# 5. Seed a starter DexPair + PS_Unfunded Pool so the dApp's
# Pools page isn't empty during the demo open:
# (paste curl payloads from this doc's §4.1 inline)

# 6. Boot operator-backend pointed at LocalNet
cd /tmp/dapp-sdk-mig/services/operator-backend
sed -i.bak "s|CANTON_LEDGER_TOKEN=.*|CANTON_LEDGER_TOKEN=$(cat /tmp/ln-token.txt)|" /tmp/operator-backend.env
set -a; . /tmp/operator-backend.env; set +a
node --import tsx src/testnet-server.ts > /tmp/op-backend.log 2>&1 &

# 7. Serve dApp on :8081 (gateway-allowed origin)
cd /tmp/dapp-sdk-mig/app/web
npm run build
npm run preview -- --port 8081 --host 127.0.0.1 > /tmp/dapp-preview.log 2>&1 &

# 8. Sanity-check
bash /tmp/dapp-sdk-mig/scripts/demo-preflight.sh
```

## Captured artefacts

After §4 + §5 execute, these CIDs exist on LocalNet:

- Multiple `Pool` contracts in PS_Active state (each previous
  init creates a new one; archived states stay queryable via
  indexer)
- Multiple `V2.Allocation` contracts backing the active pool's
  reserves
- The seeded `DexPair` BTC/USDC
- `Holding` contracts for alice / bob / operator across BTC + USDC
- Archived `MatchedTrade` + `TradeAllocationRequest`s from §5

Capture the run-ids from §4 (`pool-…`) and §5 (`v2reg-…`) for
the trace.

## Known UX gaps for the demo

- **Trade page** shows "No active pools" even when PS_Active
  pools exist. Filter mismatch with the Pools page. Logged as a
  follow-up, doesn't block the recording — just don't dwell on
  the Trade page beyond the brief read-only tour.
- **Pool_Swap** + **Pool_RemoveLiquidity** end-to-end via the
  live JSON LAPI requires more harness scaffolding than the demo
  budget permits. We reference the in-script tests as evidence
  for these two flows, which exercise the same templates. The
  next milestone closes this gap with full live harnesses.
- **Wallet round-trip on a write** (e.g. accept an allocation
  request through the dApp's Activity page) is not demoed —
  we've only validated the connect side of the SDK provider.
  Read paths render; write paths still default to the legacy
  operator-relay providers until the V2-allocation-request
  refactor lands (Plan D Phase 2).
