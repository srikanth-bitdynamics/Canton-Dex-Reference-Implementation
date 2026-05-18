# V2 MainNet Migration Plan

The DEX currently consumes the Token Standard V2 surface via the
vendored PR-5333 DARs under `vendor/splice-pr5333/`. When V2 lands on
MainNet (target: EOM July 2026, per Simon Meier @ DA), we switch to the
upstream packages.

## Why this matters

- PR-5333 vendors a draft of V2. Upstream may rename modules, tighten
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
   - Delete `vendor/splice-pr5333/` and replace with the upstream
     `splice/token-standard/*` packages at the stable release tag.
   - Update `daml.yaml` `data-dependencies:` to reference the new paths.
   - Update `pr5333-tests/daml.yaml` similarly (or rename to
     `tests/daml.yaml` once we drop the pr5333 prefix).

3. **Update Daml imports.**
   - Run `grep -rn "splice-pr5333\|Splice.Api.Token..*V2\|pr5333"` and
     fix-up any qualified module names that changed.
   - The vendored modules use `V2` suffixes (e.g.,
     `AllocationFactoryV2`). Upstream may drop the suffix once V1 is
     retired — adjust as needed.

4. **Re-run Daml build and tests.**
   - `daml build` for the root package.
   - `daml test` from `pr5333-tests/`.
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
   - Use `scripts/deploy-testnet.sh` (DEX-30) to deploy the new DARs.
   - Hit the e2e smoke test (`scripts/e2e-smoke.sh`, DEX-21).
   - Verify the docker-compose path with the new images.

8. **Cut a release.**
   - Tag `v0.1.0-mainnet` (or similar) once tests pass.
   - Update README's Daml SDK and V2 references.
   - Archive the `vendor/splice-pr5333/` notes in
     `docs/source-dependency-status.md`.

## Risk areas

- **PR-5333 choice signatures.** Some choices in the draft V2 took
  arguments that may not survive into the stable release (e.g.,
  `nextIterationFunding` shape). Audit each choice the DEX exercises:
  `OrderFundingRequest_Bind`, `Pool_Initialize`, `Pool_AddLiquidity`,
  `Pool_RemoveLiquidity`, `Pool_Swap`, `Rfq_Accept`,
  `MatchedTrade_RequestAllocations`, `MatchedTrade_Settle`,
  `AllocationFactory_Allocate`, `SettlementFactory_SettleBatch`,
  `Allocation_Adjust`, `Allocation_Cancel`.
- **BatchingUtilityV2 surface.** The wallet's multi-action composition
  uses this. If upstream renames or tightens it, the Token Standard
  provider needs an update.
- **LP token policy.** Lives entirely in our package, but signals
  through `MintRequest` / `BurnRequest` patterns mirrored from the
  registry. If the registry user guide changes its naming, the DEX-side
  mirror should be re-aligned (cosmetic only — no functional change).

## Backout plan

If the upstream V2 release has a regression that blocks us, we keep
`vendor/splice-pr5333/` in a sibling branch. The migration is
mechanical (paths + hashes), so reverting is a single `git revert`
plus a fresh `daml build`.

## See also

- `docs/source-dependency-status.md` — current vendoring rationale.
- `docs/v2-alignment-audit.md` — flow-by-flow V2 surface mapping.
