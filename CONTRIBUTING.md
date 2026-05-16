# Contributing to Canton-Dex

Thanks for your interest. This is a reference implementation; the bar
for accepting changes is that they make the reference more useful to a
builder evaluating Canton + Token Standard V2.

## What changes are most welcome

- **Bug reports**: especially mismatches between the Daml templates,
  the operator backend, and the UI.
- **Documentation fixes**: quickstart, run-testnet, and the builder
  guide are the most exercised paths; clarity wins.
- **New test cases** that exercise V2-standard edge behaviour (e.g.
  `Allocation_Adjust` conservation, settlement actor expansion).
- **Reuse examples** that build on the reference (see
  `examples/`).

## What we will likely push back on

- Adding production-only features (KYC, jurisdictional gating, complex
  oracle integrations) that obscure the reference. Those belong in
  forks, not here.
- Replacing well-tested patterns with personal preferences.
- Breaking the smart-upgrade lineage on `canton-dex-pr5333` without a
  migration plan; see `docs/run-testnet.md` "Smart upgrade".

## Development workflow

1. Pre-reqs: Daml SDK 3.4.11, Node 20+, `tsx`.
2. Build: `bash scripts/build-pr5333-surface.sh`.
3. Test: `cd pr5333-tests && daml test`.
4. UI typecheck: `cd app/web && npx tsc --noEmit`.
5. Backend typecheck: `cd services/operator-backend && npx tsc --noEmit`.

## Pull request expectations

- Daml changes: include a test, run `daml test`, and explain any
  Optional-field additions for smart-upgrade compatibility.
- Backend changes: TypeScript typecheck clean; include a `curl` example
  for any new endpoint in the PR description.
- UI changes: at minimum a screenshot of the affected page; if the
  change touches data flow, also confirm against testnet.
- Avoid committing: secrets, `.env` files, sqlite databases, `.pem`
  keys, vendor binary blobs. The `.gitignore` should catch these.

## Licensing

By contributing you agree your contributions are licensed under
Apache 2.0 (the project license). For substantial vendored upstream
material, add an entry to `NOTICE`.

## Security disclosures

Do not file public issues for security problems. Contact the
maintainers (see repo metadata) directly.
