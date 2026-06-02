# V2 MainNet Migration Plan

The DEX currently consumes the Token Standard V2 surface via the
vendored `token-standard-v2-upcoming` DARs under `vendor/splice/`. When V2 lands on
MainNet (target: EOM July 2026 per proposal [M7][proposal-m7], confirmed
by Simon Meier @ DA on 2026-05-18), we switch to the upstream packages.

[proposal-m7]: https://github.com/canton-foundation/canton-dev-fund/blob/main/proposals/proposal-token-standard-v2.md#milestones-and-deliverables

## V1 → V2 migration is not a flag day

A common misconception is that V2 release is an instrument-level
migration event — V1 holdings get "upgraded" to V2 holdings. That is
not how the upstream maintainers have framed it.

Per [CIP-0112 §5 — Backwards compatibility][cip-0112-§5]:

[cip-0112-§5]: https://github.com/bame-da/cips/blob/20a32aa7b219fa6d4ea5aa568d530eaed360fbb1/cip-0112/cip-0112.md#5-backwards-compatibility

- **V1 contracts continue to exist.** Existing V1 `Holding`,
  `TransferInstruction`, `Allocation`, etc. contracts are not archived,
  rewritten, or auto-converted when V2 ships.
- **Issuers ship V2 implementations alongside V1.** An asset like
  Canton Coin will implement *both* the V1 and V2 interface choices on
  the same templates. Wallets and dApps that speak V2 can interact with
  those assets via the V2 surface; wallets that speak only V1 continue
  working unchanged. This is the "dual implementation" strategy Simon
  referenced explicitly on 2026-05-18.
- **When dual-implementation is live for the assets we care about**
  (Canton Coin, USDCx, future RWA tokens), the DEX automatically gains
  the ability to trade them natively — no DEX code change required at
  the asset's switchover moment. Our DEX always speaks V2; the question
  is whether the asset on the other side does yet.

Practical implication: the DEX's migration is **upstream package
adoption**, not asset migration. We swap our vendored DARs for the
upstream release; the on-ledger asset universe migrates independently
of us.

## Our vendoring source

We track the `token-standard-v2-upcoming` branch of
<https://github.com/canton-network/splice>, per Simon's recommendation on
2026-05-18 to "upgrade to the .dars from that branch to also incorporate
other changes" beyond the earlier draft allocation surface.

Current state (2026-05-18):

- `vendor/splice/` — V2 snapshot of `token-standard-v2-upcoming` with the
  allocation functionality the trading surface consumes: committed
  allocations, `nextIterationFunding`, settlement batches, and per-side
  transfer-leg sides.

Branch-tip refresh experiment on 2026-05-18 surfaced that the upstream
branch has continued to refactor the allocation API on the way to release —
specifically shifting iterated-settlement detail into
`FinalizedAllocation.extraTransferLegSides` and
`nextIterationFunding`. We migrate against the current
`token-standard-v2-upcoming` surface rather than an older draft shape.

## Why this matters

- The vendored branch is still pre-release. Upstream may rename modules, tighten
  argument types, or change choice signatures.
- Until the switch, every DAR hash referenced in `daml.yaml` is a
  pre-release; production deployments shouldn't pin to those forever.
- The frontend's Token Standard wallet provider composes commands
  against the same surface. The provider isn't aware of the package
  hash — but the operator backend's command composer is.

## Migration checklist

1. **Watch the upstream release.**
   - Track <https://github.com/canton-network/splice> for the V2 stable tag.
   - Subscribe to the canton-network announcements channel.

2. **Replace vendored DARs.**
   - Delete `vendor/splice/` and replace with the upstream
     `splice/token-standard/*` packages at the stable release tag.
   - Update `daml.yaml` `data-dependencies:` to reference the new paths.
   - Update `trading-tests/daml.yaml` similarly (or rename to
     `tests/daml.yaml` once we drop the trading prefix).

3. **Update Daml imports.**
   - Run `grep -rn "splice\|Splice.Api.Token..*V2\|trading"` and
     fix-up any qualified module names that changed.
   - The vendored modules use `V2` suffixes (e.g.,
     `AllocationFactoryV2`). Upstream may drop the suffix once V1 is
     retired — adjust as needed.

4. **Re-run Daml build and tests.**
   - `daml build` for the root package.
   - `daml test` from `trading-tests/`.
   - `scripts/run-local-daml-tests.sh` should pass end-to-end.

5. **Update TS package hash references.**
   - `services/operator-backend/src/testnet-server.ts`:
     `CANTON_DEX_PACKAGE_ID` env var now reflects the post-migration
     package hash. The dev path doesn't care (in-memory ledger).
   - `services/operator-backend/src/ledger/json-api.ts`: `templateIdPrefix`
     consumer — verify nothing else hard-codes the prefix.

6. **Regenerate `.dar` artifacts.**
   - Delete `.daml/dist/` everywhere and rebuild from scratch.
   - Recompute the package hash; update `CANTON_DEX_PACKAGE_ID` in
     `.env.example` and any deployment config.

7. **Run E2E against testnet.**
   - Use `scripts/deploy-testnet.sh` to deploy the new DARs.
   - Hit the e2e smoke test (`scripts/e2e-smoke.sh`).
   - Verify the docker-compose path with the new images.

8. **Cut a release.**
   - Tag `v0.1.0-mainnet` (or similar) once tests pass.
   - Update README's Daml SDK and V2 references.
   - Archive the `vendor/splice/` notes in
     `docs/source-dependency-status.md`.

## Risk areas

- **V2 choice signatures.** Some choices in the pre-release V2 surface took
  arguments that may not survive into the stable release (e.g.,
  `nextIterationFunding` shape). Audit each choice the DEX exercises:
  `OrderFundingRequest_Bind`, `PoolRules_RequestSwap`, `PoolRules_Swap`,
  `PoolLiquidityRules_RequestAddLiquidity`,
  `PoolLiquidityRules_SettleAddLiquidity`,
  `PoolLiquidityRules_RequestRemoveLiquidity`,
  `PoolLiquidityRules_SettleRemoveLiquidity`, `Rfq_Accept`,
  `MatchedTrade_RequestAllocations`, `MatchedTrade_Settle`,
  `AllocationFactory_Allocate`, `SettlementFactory_SettleBatch`,
  `Allocation_Cancel`.
- **BatchingUtilityV2 surface.** The wallet's multi-action composition
  uses this. If upstream renames or tightens it, the Token Standard
  provider needs an update.
- **LP token policy.** Lives entirely in our package, but signals
  through `MintRequest` / `BurnRequest` patterns mirrored from the
  registry. If the registry user guide changes its naming, the DEX-side
  mirror should be re-aligned (cosmetic only — no functional change).

## Backout plan

If the upstream V2 release has a regression that blocks us, we keep
`vendor/splice/` in a sibling branch. The migration is
mechanical (paths + hashes), so reverting is a single `git revert`
plus a fresh `daml build`.

## See also

- `docs/source-dependency-status.md` — current vendoring rationale.
- `docs/v2-alignment-audit.md` — flow-by-flow V2 surface mapping.
- `docs/lp-token-versioning.md` — why LP versioning is decoupled from
  the registry-side V1→V2 upgrade story.
- `docs/registry-prerequisites.md` — the issuer-side force-upgrade
  pattern that lets V1 assets dual-implement V2 over time.
- [CIP-0112 §5](https://github.com/bame-da/cips/blob/20a32aa7b219fa6d4ea5aa568d530eaed360fbb1/cip-0112/cip-0112.md#5-backwards-compatibility) —
  canonical V1↔V2 backwards-compatibility framing.
