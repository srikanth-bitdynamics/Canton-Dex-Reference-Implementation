# Vendored Token Standard pin

> **Approach change (2026-07-22): the build consumes the canonical Splice
> release DARs, not rebuilt vendored sources.** The token-standard dependencies
> are committed DARs under `vendor/splice/dars/`, taken verbatim from the Splice
> **0.6.12** `splice-node` release bundle (built with SDK **3.5.2**). These carry
> the exact package ids the Testnet validator already vets, so
> `canton-dex-trading` built against them uploads cleanly and interoperates with
> real Amulet holdings. Rebuilding the standard from source yields *different*
> package ids and is rejected on a real participant (`KNOWN_PACKAGE_VERSION`).
> Refresh with `scripts/fetch-splice-dars.sh [version]`. The vendored **source**
> tree below is retained for reference only and is no longer built (slated for
> removal in a follow-up).

## Prior vendored-source pin (superseded by the above)

This file records exactly which upstream Splice Token Standard sources the
`vendor/splice/` tree was synced from. It is the in-tree, authoritative pin;
previously this information lived only in a git commit message.

| Field | Value |
| --- | --- |
| Upstream repo | https://github.com/canton-network/splice |
| Branch | `main` |
| Commit (recorded tip) | `93b3519c7d50c0e0ddd0fcfa55529537bf6e643c` |
| Commit date | 2026-06-30 |
| In-tree `VERSION` (upstream) | `0.6.11` |
| `LATEST_RELEASE` (upstream) | `0.6.10` |

## Notes

- Token Standard **V2** has landed on `canton-network/splice` `main`. The former
  `token-standard-v2-upcoming` branch (the previous pin) is now fully merged:
  it compared **0 commits ahead / 65 behind** `main` as of the sync on
  2026-06-30 (the load-bearing fact is the 0-ahead), and `token-standard/`
  exists on `main`. V2 becomes the default token standard from mid-July 2026.
  The vendored sources therefore now track stable `main` rather than the stale
  pre-release branch.
- Re-vendoring `main` (`93b3519c`) over the previous pin
  (`token-standard-v2-upcoming` tip `9340178a`, full hash
  `9340178a05833a7ae5e2c9ec242d9b416ebaa8b0`) produced **no material source
  drift** for the DEX: the only two `.daml` API sources that changed
  (`AllocationV2.daml`, `TransferInstructionV2.daml`) differ by
  documentation-comment text only. The `splice-token-standard-utils` and
  `examples/` packages carry an internal refactor (function renames, added
  deadline/lock validation), but they build clean and all `trading-tests`
  scenarios still pass. See
  [`../../docs/reference/allocation-surface.md`](../../docs/reference/allocation-surface.md) for the
  field-by-field allocation delta.
- **SDK version:** upstream `main` builds these packages with
  `sdk-version: 3.5.2`. The vendored `daml.yaml` files here are pinned to the
  repo's **`3.4.11`** toolchain instead: the main sources compile cleanly and all
  **70 `trading-tests` scenarios pass** under 3.4.11, so this repin adopts main's
  Token Standard V2 sources without forcing a toolchain change. Migrating the
  whole repo to SDK 3.5.2 (which uses DPM rather than the legacy Daml Assistant)
  is a separate, later step.
- `vendor/splice/daml/splice-util-token-standard-wallet/` (the wallet-side
  batching utility, incl. `BatchingUtilityV2`) is synced from the same pin
  (`93b3519c`), with its `daml.yaml` pinned to SDK `3.4.11` like the rest of
  the vendored tree. It is vendored as **reference source only** — the binary
  `../dars/*.dar` dependencies it declares are not vendored, nothing in this
  repo builds or consumes it.
- Sync scope: the API packages, `splice-token-standard-utils`, and the
  `examples/splice-test-token-v2` + `examples/splice-token-test-trading-app-v2`
  sources + `daml.yaml` were synced. The `cli/` tooling and the docs under
  `token-standard/` are reference-only and were left untouched. Three unused
  test-harness source sets remain at the previous pin (`9340178a`):
  `splice-token-standard-v1-test/`, `splice-token-standard-v2-test/`, and
  `examples/splice-test-token-v1/.../TestTokenV1.daml`. None of them is
  consumed by the DEX build, `trading/`, or `trading-tests/`.

## Migration commitment

This is not a long-term fork. The vendored tree tracks `canton-network/splice`
`main`. When a tagged Token Standard V2 release is cut, `vendor/splice/` should
be re-pinned to that release and this pin updated accordingly.
