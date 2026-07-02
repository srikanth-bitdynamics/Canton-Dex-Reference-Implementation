# Security policy

## Supported versions

Only the `main` branch is supported. We do not backport fixes to
older tags or releases.

The `canton-dex-trading` Daml package version on the public testnet
is the deployed surface; older versions remain queryable via Daml
smart-upgrade but are not supported for new contracts.

## Reporting a vulnerability

Do not file a public issue for security problems. Instead, email the
maintainers (see `CODEOWNERS` or repo metadata) with:

- a clear description of the issue
- reproduction steps or proof of concept
- the version / commit hash affected
- your assessment of severity and exploitability

You will get an acknowledgement within a few business days. If the
report is valid we will discuss a coordinated disclosure timeline
with you; the default is 90 days from acknowledgement to public
disclosure.

## What counts

In scope:

- Contract bugs in the `trading/` Daml templates that allow
  unauthorized state transitions, asset movement, or settlement
  bypass.
- Operator-backend bugs in `services/operator-backend/` that leak
  secrets, allow privilege escalation, or accept malformed input
  that the participant rejects (e.g. submitting commands as the
  wrong party).
- dApp bugs in `app/web/` that misrepresent on-chain state in a way
  that could mislead a trader (e.g. showing a fake fill price).

Out of scope:

- Issues in vendored upstream (`vendor/splice*`); report those to
  upstream directly.
- General Canton synchronizer or participant bugs; those are
  outside this reference implementation.
- Reports that boil down to "the operator is trusted" (the
  reference assumes this; see `docs/concepts/architecture.md`).

## What we won't do

- Pay bug bounties. This is a reference implementation, not a
  production deployment.
- Treat AI-generated reports without a working reproduction as
  valid.
