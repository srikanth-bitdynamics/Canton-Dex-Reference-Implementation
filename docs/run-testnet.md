# Run against the deployed testnet

Concrete recipe to bring up the dApp wired to the real Canton testnet
at `5.75.216.246:7575`, with the DEX DARs uploaded and an initial
`DexPair` + `Pool` already on-ledger.

## Deployed state on the testnet

| Asset | Value |
| --- | --- |
| Validator | `http://5.75.216.246:7575` (Canton 3.4.12-SNAPSHOT, plain HTTP) |
| Synchronizer | `global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337` |
| `canton-dex-trading` package id (v0.0.6 — current) | `7d66ae82d6de725fda3a12cb4e2e9704a51a4d36f43e426a1ef3fb2573c17fe8` |
| metadata-v1 (testnet-vetted) | `4ded6b668cb3b64f7a88a30874cd41c75829f5e064b3fbbadf41ec7e8363354f` |
| Operator party | `bitdynamicsab-testnet-1::1220ed51edaa87ffb050d0533224995ff9e8c211e513bf94b867670d19b909112f6f` |
| LP registrar party | `amm-dex-testnet-1::1220ed51edaa87ffb050d0533224995ff9e8c211e513bf94b867670d19b909112f6f` |
| Admin party | `LYRA-Admin::1220ed51edaa87ffb050d0533224995ff9e8c211e513bf94b867670d19b909112f6f` |
| User id (JWT `sub`) | `ledger-api-user` (ParticipantAdmin, CanActAs ≥ 400 parties) |
| DexPair CID (BTC/USDC) | `0020b3bf71c43ba5ec04a4fa0a620207698594f4bac7303abe207e0e33284ef4a8ca121220224fe644ba3dc9478281151a15cf43cc30401aacdaff966af82e839b76386385` |
| Pool CID (BTC/USDC, Unfunded) | `001a8ecaeba0644871d7a5019c2dea7ec00bd0685ac7cbcaa301ded863c438ee30ca1212204da4ed3783bc8a26c84a3874666ebf9fcb0d16a7f0fa16746f6c5cb291474172` |

Other V2 token-standard package ids uploaded alongside our DEX:

```
holding-v2                  b2e23c1a42a66d3286a2b8a8df3fad8db99d580a330ed3d871b58953dfd42565
allocation-v2               dc9ba9de147bbbe5d155c58dbf10ebabab22436b42a6a005be37fb7052546ab1
allocation-request-v2       6912769cdaef394ba7d5b8b6771000a882ef7dc283c96ad5364d753ab567bd10
allocation-instruction-v2   24d26b2de29f3d15fd4832fa5bfabcac331638f4b8aa91e6c37125a70fe7f676
transfer-events-v2          eef21cbd76e205fcd6a5a928332dbb2bc5a80c6eb294ed30b6eeddbc9c2d73c1
transfer-instruction-v2     202b778de9b527c24d0d205b8b3743d1dbfdb2340455ff81542d11814143f5f4
canton-dex-trading v0.0.6    7d66ae82d6de725fda3a12cb4e2e9704a51a4d36f43e426a1ef3fb2573c17fe8
```

These were built against the testnet-vetted `metadata-v1` (`4ded6b66…`)
so vetting succeeds without disturbing pre-existing apps (amulet,
wallet, daml-finance) that reference the same `metadata-v1`. See the
"build hash alignment" note below for why.

## Quickstart (3 terminals)

The operator backend authenticates against the participant via a JWT.
How you obtain it is environment-specific (see your validator's user
management). The backend reads it from `CANTON_LEDGER_TOKEN` and never
writes it to disk.

You will also need the participant's URL, the synchronizer id, and the
party ids the operator should `actAs`. These are validator-level facts
issued when the operator party is allocated.

### Terminal 1 — operator-backend pointed at testnet

```bash
cd services/operator-backend

# Provide your participant JWT via env, e.g.:
#   export CANTON_LEDGER_TOKEN="$(your-jwt-fetch-command)"
# DO NOT commit the JWT or write it to disk.

CANTON_LEDGER_URL="http://<your-participant-host>:7575" \
CANTON_OPERATOR="bitdynamicsab-testnet-1::1220ed51edaa87ffb050d0533224995ff9e8c211e513bf94b867670d19b909112f6f" \
CANTON_LP_REGISTRAR="amm-dex-testnet-1::1220ed51edaa87ffb050d0533224995ff9e8c211e513bf94b867670d19b909112f6f" \
CANTON_ADMIN="LYRA-Admin::1220ed51edaa87ffb050d0533224995ff9e8c211e513bf94b867670d19b909112f6f" \
CANTON_NETWORK="canton:devnet-utility" \
CANTON_SYNCHRONIZER="global-domain::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337" \
CANTON_DEX_PACKAGE_ID="7d66ae82d6de725fda3a12cb4e2e9704a51a4d36f43e426a1ef3fb2573c17fe8" \
PORT=8080 \
npm run testnet
```

### Terminal 2 — UI

```bash
cd app/web
npm run build && npm run preview
```

### Terminal 3 — smoke-test

```bash
curl -s http://127.0.0.1:8080/v1/context | python3 -m json.tool
curl -s http://127.0.0.1:8080/v1/status  | python3 -m json.tool
curl -s http://127.0.0.1:8080/v1/pools   | python3 -m json.tool
curl -s http://127.0.0.1:8080/v1/pairs   | python3 -m json.tool
```

Then open <http://localhost:4173>. The header pill shows the live
testnet network + slot. The Pools page renders the on-chain Pool
(unfunded). Trader-authority writes still require a connected wallet
(WalletConnect path) and a synchronizer-vetted `AllocationFactory`
instance — see "Not yet wired" below.

## Build-hash alignment (lesson learned)

The first probe upload failed with `KNOWN_PACKAGE_VERSION`. Root cause:
this testnet has TWO `splice-api-token-metadata-v1 v1.0.0` packages
loaded, with different Daml package hashes (`25952a7c…` and
`4ded6b66…`). Only `4ded6b66` is vetted on the synchronizer (used by
amulet/wallet/daml-finance). Our local V2 vendored DARs were built
against `25952a7c`, so vetting their transitive metadata-v1 dep
collided.

Fix: built our V2 chain against the testnet-vetted `4ded6b66` metadata
DAR (found at `~/CantonAMM/Canton-AMM/lib/splice-api-token-metadata-v1-1.0.0.dar`
on the EC2). Step-by-step:

1. `cp $THAT_DAR vendor/splice/.../splice-api-token-metadata-v1/.daml/dist/splice-api-token-metadata-v1-current.dar`
2. Skip rebuilding `metadata-v1` itself; rebuild every other V2
   package via `(cd vendor/splice/token-standard/$pkg && daml build)`.
3. Rebuild `canton-dex-trading` (`cd trading && daml build`).
4. All 25 trading-tests still pass against the new metadata hash.

## Full V2-standard registry trade on the live testnet

`scripts/testnet-v2registry-trade.ts` drives a real trade through
**`CantonDex.Registry.V2.Registry`** — a registry implementing every
CIP-0056 on-ledger interface: `V2.Holding`, `V2.AllocationFactory`,
`V2.Allocation` (including iterated-settlement funding),
`V2.SettlementFactory`, `V2.TransferFactory`, `V2.TransferInstruction`,
`TransferEventsV2.EventLog`. Plus `InstrumentConfig` (decimals, supply
cap, credential reqs), `Credential` (issuer-signed claims), and
`Registry_RegisterInstrument` / `Registry_Mint` / `Registry_Burn`
workflows.

Tested run:

```
=== create Registry (full V2 standard) ===                                ✓
=== Registry_RegisterInstrument (BTC, supply cap 1M) ===                  ✓
=== Registry_Mint 25 BTC → alice (enforces cap + cred) ===                ✓
=== pre-state: alice 25 BTC, bob 0 BTC ===                                ✓
=== create MatchedTrade ===                                               ✓
=== MatchedTrade_RequestAllocations ===                                   ✓
=== alice: Accept + AllocationFactory_Allocate (coverage check) ===       ✓
=== bob: Accept + AllocationFactory_Allocate (receipt) ===                ✓
=== MatchedTrade_Settle (V2 SettlementFactory_SettleBatch) ===            ✓ (offset 714724)
=== post-state: bob has 10 BTC, supply intact ===
  bob holding: amount=10.0000000000, cid=00d00bd39a2170b3f1…
✅ FULL V2 STANDARD REGISTRY — REAL TRADE complete on testnet
```

Configure with `CANTON_DEX_PACKAGE_ID=518e614a12a08c594c385da32cb49b6d24ca6a8653eea982047670066579bf64`
(canton-dex-trading v0.0.5, the full-V2 build).

### V2-spec design choices baked into Registry.V2

- **Receiver-side holdings are minted inside `Allocation_Settle`**, not
  inside the SettlementFactory. Each allocation is signed by admin +
  its authorizer, so when the receiver's allocation settles, it has
  the authority to mint the receiver's new holding. The factory only
  drives per-allocation settle calls.
- **`SettlementFactory_SettleBatch` expands `arg.actors` to include
  the admin** before forwarding to `Allocation_Settle`. V2 spec
  requires settle actors to include executors + admin, but the typical
  caller (a DEX) passes only executors. The factory injects admin
  from its own signatories.
- **`AllocationFactory_Allocate` enforces per-instrument coverage**:
  sum of input-holding amounts per instrument id must be ≥ outflow
  for that instrument across the authorizer's sender-side legs.
- **Settlement enforces funding conservation**: each
  extra leg-side's net outflow must be covered by the current
  `nextIterationFunding` budget; consumed amount is debited from the
  next-iteration budget. Required for `PoolRules_Swap` and order partial-
  fill roll-forward.

## Not yet wired

The end-to-end happy path still needs:

- **`AllocationFactory` and `SettlementFactory` instances** for our V2
  packages on this synchronizer. `bitdynamicsab-testnet-1` (or another
  admin) needs to create instances and surface their CIDs into
  `CANTON_ALLOC_FACTORY_CID` / `CANTON_SETTLE_FACTORY_CID` env vars.
  Without this, swap / add-liquidity / order intents complete the
  wallet handoff but the operator cannot drive first funding or
  `PoolRules_Swap` against real factories.
- **WalletConnect project id** in `app/web/.env.local`. With one set,
  the Connect Wallet button opens the real WalletConnect modal; sessions
  request CIP-0103 methods (`canton_listAccounts`, `canton_prepareExecute`,
  `canton_signMessage`). Until then the Mock provider stands in.
- **Holdings minted to a trader party** so the Portfolio page shows
  non-empty balances. Goes through the registry's Mint workflow once a
  trader party with credentials exists.
