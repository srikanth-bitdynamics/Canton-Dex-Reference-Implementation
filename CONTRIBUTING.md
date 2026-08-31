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
  finalized-allocation funding conservation, settlement actor expansion).
- **Small, documented extensions** that demonstrate a reusable workflow without
  obscuring the reference core.

## What we will likely push back on

- Adding production-only features (KYC, jurisdictional gating, complex
  oracle integrations) that obscure the reference. Those belong in
  forks, not here.
- Replacing well-tested patterns with personal preferences.
- Breaking deployed `canton-dex-trading-v2` package compatibility without a
  clear migration plan.

## Development workflow

1. Install DPM and Node.js 24. DPM resolves the Daml SDK 3.5.2 version pinned in
   `trading/daml.yaml`.
2. Build and test Daml: `bash scripts/run-local-daml-tests.sh`.
3. Check Daml package compatibility: `bash scripts/check-upgrade-compat.sh`.
4. Test the backend: `cd services/operator-backend && npm ci && npm run typecheck && npm test`.
5. Test the dApp: `cd app/web && npm ci && npx tsc --noEmit && npm test && npm run build`.
6. Build the docs site: `cd website && npm ci && npm run build`.

## Pull request expectations

- Daml changes: include a test, run the Daml and upgrade-check scripts above,
  and explain any public contract-surface change.
- Backend changes: TypeScript typecheck clean; include a `curl` example
  for any new endpoint in the PR description.
- UI changes: at minimum a screenshot of the affected page. If the change
  touches AMM data flow, run the self-contained DPM sandbox proof documented in
  `docs/guides/localnet.md`; controlled-testnet validation is an additional
  check when the contributor has access to such an environment.
- Avoid committing secrets, `.env` files, SQLite databases, private keys, or
  generated build output. The Token Standard DARs already pinned under
  `vendor/splice/dars/` are the intentional exception for binary dependencies.

## Licensing

By contributing you agree your contributions are licensed under
Apache 2.0 (the project license). For substantial vendored upstream
material, add an entry to `NOTICE`.

## Security disclosures

Do not file public issues for security problems. Contact the
maintainers (see repo metadata) directly.
