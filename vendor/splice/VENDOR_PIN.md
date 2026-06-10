# Vendored Token Standard pin

This file records exactly which upstream Splice Token Standard sources the
`vendor/splice/` tree was synced from. It is the in-tree, authoritative pin;
previously this information lived only in a git commit message.

| Field | Value |
| --- | --- |
| Upstream repo | https://github.com/hyperledger-labs/splice |
| Branch | `token-standard-v2-upcoming` |
| Commit (recorded tip) | `9340178a` |
| Pin recorded in git commit | `a75326d7e3225c46f64d06ad9006b986a665ba0e` (2026-05-28) |
| In-tree `VERSION` | `0.6.3` (see [`VERSION`](VERSION)) |
| `LATEST_RELEASE` | `0.6.2` (see [`LATEST_RELEASE`](LATEST_RELEASE)) |

## Notes

- This is a **pre-release** branch, not released Token Standard V2. The branch
  carries iterated-settlement and committed-allocation semantics that the DEX
  depends on but that are not yet part of a released TSV2. See
  [`../../docs/allocation-surface.md`](../../docs/allocation-surface.md) for the
  field-by-field delta.
- `9340178a` is the short commit hash as recorded in the vendoring commit
  message (`a75326d`, "vendor: re-vendor token-standard V2 from
  token-standard-v2-upcoming tip 9340178a"). The full 40-character hash is not
  reproduced in-tree; treat `9340178a` as the recorded upstream tip. To recover
  the full hash, resolve `9340178a` against
  https://github.com/hyperledger-labs/splice on the
  `token-standard-v2-upcoming` branch.
- Only the Daml package sources + `daml.yaml` were synced. The `cli/` tooling
  and the docs under `token-standard/` are reference-only and were left
  untouched at vendoring time.

## Migration commitment

This is not a long-term fork. When the upcoming allocation semantics land in a
released Token Standard V2, `vendor/splice/` will be re-pinned to that release
and this pin updated accordingly.
