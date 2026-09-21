# Audit scope

## Milestone 4 boundary

The milestone commissions a security audit of the reference Daml package.
The explicit scope is recorded in the
[Milestone 4 clarification dated 8 September 2026](https://github.com/canton-foundation/canton-dev-fund/pull/108#issuecomment-5589893920):

> a single third-party security audit of the reference Daml package

That clarification separates the security audit from the maintenance milestone.
The audit follows a frozen Milestone 3 scope and deployment-critical workflows.
The original proposal's broader reference-implementation deliverables do not
make every repository component part of this audit engagement.

The review target is `canton-dex-trading-v2`, built from `trading/daml.yaml`
(current package version `1.4.0`, Daml SDK `3.5.2`). Review the complete
first-party Daml package, including its DEX workflows, LP logic, reference
registry, instrument contracts and shared helpers. Its contract behavior for
parties on different participants is in scope; this is not a review limited to
a particular hosted demo or wallet.

## Included code and supporting material

| Material | Audit treatment |
| --- | --- |
| All Daml source under `trading/CantonDex/` | Primary review target: every template, interface implementation, choice and helper compiled into the reference package |
| `Dex/` | Pairs, orders, RFQs, matched trades, pool state, slices, allocation requests, settlement rules and policy receipts |
| `Lp/`, `Registry/`, `Instrument/`, `Trading/`, `Testing/` | LP issuance/redemption, reference token registry, instrument lifecycle, shared workflow logic and reference implementations included in the package |
| `trading-tests/` | Supporting Daml tests and fixtures; assess coverage and whether the tests substantiate the package's stated invariants |
| `trading/daml.yaml`, dependency DARs and build scripts | Reproduce and identify the reviewed artifact and its dependency versions |
| Architecture, workflow, custody and token-standard documentation | Specifications, assumptions and known limitations supporting the Daml review |

The package boundary, rather than a list of selected templates, defines the
review target. New Daml modules included in the frozen package are not excluded
because they are helpers, examples or reference-registry code. Upstream Canton,
Daml and Splice implementations are dependencies, not separate audit targets;
review this package's use of their interfaces and its assumptions about them.

## Outside this audit engagement

The following implementations are outside the milestone's Daml-package audit:

- Frontend application and browser UI (`app/web/`).
- Operator backend and registry discovery client (`services/`).
- Wallet adapters, browser key storage, session authentication and third-party
  wallet implementations.
- Participant infrastructure, server configuration, deployment operations and
  the live website.
- The operator-signed demo on `testnet-hosted-party-onboarding`.

These components may be supplied as integration context or used by a test
harness. Their presence in the repository or in a source-checksum manifest does
not make them audited. If an off-ledger assumption affects a Daml security
property, state that assumption and its consequences in the audit report.
A full application or infrastructure security review would be a separate scope.

## Frozen source and artifact

Use a clean checkout of `main` pinned to a full commit ID for the handoff.
Record the Daml package ID, DAR checksum, compiler version and dependency pins.
The existing annotated `audit-2026-09-20` tag identifies an earlier review
baseline, not an audit result or a production approval. Do not move that tag.
For a later handoff commit, identify any changes to the Daml source and build
inputs explicitly; documentation and off-ledger changes must not be mistaken
for changes to the audited package.

Generate the build evidence and source manifest with:

```sh
bash scripts/run-local-daml-tests.sh
node scripts/audit-manifest.mjs > /tmp/canton-dex-audit-manifest.json
```

The manifest records the full source commit, source tree, tracked-file checksums,
dependency pins and built trading DAR. It inventories the repository for
provenance; the audit boundary remains the Daml package defined above. Supply
Daml test output and relevant CI results alongside it. A moving branch name or
package name alone does not identify the reviewed release.

The public demo uses a separate hosting branch and older package lineage.
Its deployment and successful transactions do not establish correctness of the
Daml package handed to the auditors. Evidence must identify the exact package
and source revision exercised.

## Contract properties to review

- Signatories, controllers, observers, visibility and delegated authority for
  every workflow, including transactions involving independently hosted parties.
- Instrument identity includes both the administering party and textual ID.
- Allocations are bound to the intended party, asset, settlement and amounts.
- A caller cannot mint, burn, allocate or release another party's holdings
  without the authority required by the contract's stated model.
- Per-admin settlement batches contain the relevant transfer legs and
  authorizations. Failure of one registry operation rolls back the full Daml
  transaction, including reserve and LP-supply changes.
- LP issuance matches accepted deposits and pool share calculations; redemption
  consumes the required LP holdings and pays the correct reserves.
- Slice backing, aggregate reserves and LP supply remain consistent across
  add, swap, partial remove, complete remove and repeated settlement attempts.
- Rounding, dust, slippage, deadlines, cancellation and iterated funding cannot
  expand an executor's authority beyond the allocation it received.
- Orders and RFQs retain owner binding, price/quantity constraints and
  protections against duplicate settlement and self-trading where enforced.
- Token-standard choices receive the required context and authority, with
  external registry assumptions made explicit at the contract boundary.

## Known contract limitations and trust assumptions

- LP holdings are on-ledger, but pool reserves are operator-controlled.
  Redemption requires the operator and LP registrar. There is no unilateral
  holder emergency withdrawal from reserve slices.
- The reference registry's credential records and claim checks are illustrative,
  not production credential verification. Holder requirements are not enforced
  as a production credential policy; the reference profile uses empty requirements.
- Pool reserve totals remain a serialization point. Separate slices do not
  establish horizontal AMM throughput.
- Pool state trusts its signing operator. Review the documented parallel-state
  and reconciliation-completeness assumptions.
- Daml atomicity applies to final settlement. Separate allocation authorizations
  can leave funds locked when the overall application workflow is interrupted;
  review the contract cancellation, expiry and recovery paths.
- Package vetting, compatible participant versions, registry credentials and
  off-ledger orchestration remain integration prerequisites. A Daml audit alone
  does not establish compatibility with every wallet or participant.
- Upgrade compatibility is not established without an applicable baseline DAR.
  Existing contracts must match the reviewed package lineage and artifact.

## Evidence and report

Daml Script tests and Canton transaction proofs support the review; they do not
replace it. Distinguish reference-asset tests from real CC/USDCx transactions,
and single-participant execution from independent-participant evidence. Browser
and backend test results are supporting integration information, not evidence
that those implementations received a security audit.

The audit report or published summary must identify the reviewed commit,
package, exclusions, assumptions and remaining findings. Record a fix or an
accepted-risk disposition with rationale for every critical/high finding,
consistent with the milestone's remediation and maintenance commitments.
