# Audit scope

This audit targets the source and build inputs identified by the annotated
`audit-2026-09-20` tag on `main`. The tag identifies a review baseline, not an
audit result or a production approval. Subsequent changes require a new commit
and an explicit review delta; the tag must not be moved.

Generate the source and DAR checksums from a clean checkout with:

```sh
bash scripts/run-local-daml-tests.sh
node scripts/audit-manifest.mjs > /tmp/canton-dex-audit-manifest.json
```

The manifest records the full source commit, the source tree, tracked-file
checksums, dependency pins and the built trading DAR. Supply it with the CI
results and deployment evidence to the reviewers. A moving branch name or a
package name alone does not identify the reviewed release.

## Included components

| Component | Paths | Review focus |
| --- | --- | --- |
| DEX and reference token registry | `trading/CantonDex/` | Controllers, visibility, ownership, issuance, settlement, arithmetic and lifecycle rules |
| Contract tests | `trading-tests/` | Positive and negative proofs; fidelity to the stated invariants |
| Operator backend | `services/operator-backend/src/` | Caller authorization, command construction, contexts, disclosures, retries, recovery, indexing and persistence |
| Registry discovery client | `services/registry-client/src/` | Per-admin routing, response validation, authentication and operation-specific contexts |
| Browser application | `app/web/src/` | Account and network binding, wallet authorization, funding selection, receipts and error recovery |
| Configuration and deployment inputs | `.github/workflows/`, `scripts/`, Dockerfiles, Compose files, package locks and Daml manifests | Reproducibility, authority exposure, defaults and dependency selection |
| Documentation | `README.md`, `SECURITY.md`, `docs/`, this file | Agreement between claims, supported configurations and actual enforcement |

Tests and documentation are evidence and specifications for the review, not
substitutes for reviewing the executable code. Any new public onboarding or
submission adapter included in this release is part of the backend and browser
scope; it cannot be excluded merely because it is enabled only on testnet.

## Contract properties to review

- Instrument identity includes both the administering party and textual ID.
- Allocations are bound to the intended party, asset, settlement and amounts.
- A caller cannot mint, burn, allocate or release another party's holdings
  without the required authority.
- Per-admin settlement batches contain exactly the relevant transfer legs and
  authorizations. Failure of one registry operation rolls back the full Daml
  transaction, including reserve and LP-supply changes.
- LP issuance matches the accepted deposit and pool share calculation;
  redemption consumes the required LP holdings and pays the correct reserves.
- Slice backing, aggregate reserves and LP supply remain consistent across
  add, swap, partial remove, complete remove and retries.
- Rounding, dust, slippage, deadlines, cancellation and iterated funding cannot
  increase an executor's authority beyond the allocation it received.
- Orders and RFQs retain owner binding, price/quantity constraints and
  protections against duplicate settlement and self-trading where enforced.

## Backend and wallet properties to review

- Party IDs are identifiers, not authentication credentials. Party-scoped
  requests must bind to an authenticated caller or ledger-proven authority.
- Operator, registrar, participant-administration and trader authority remain
  separate. Privileged credentials never enter the browser bundle.
- Contexts and disclosed contracts are resolved for the exact operation and
  instrument admin. Missing context fails closed.
- Funding uses real, correctly owned holdings with the intended full
  instrument identity; another asset with the same textual name cannot fund it.
- A successful wallet authorization is not reported as successful settlement.
  Recovery uses the committed update and cannot select unrelated allocations.
- Retries, timeouts, database restarts and duplicate submissions cannot credit
  shares twice, repeat payouts or silently forget locked allocations.
- Public onboarding and submission limits apply before privileged work and
  survive the documented deployment lifecycle.

## Deployment boundary

The reference contracts do not depend on a particular website or participant
identifier. A participant executing the relevant contracts must install and vet
the required release packages and dependencies. Additional participants also
need compatible Canton/Splice versions, synchronizer connectivity, party
authorization, registry credentials where applicable and working discovery and
submission integrations.

The designated testnet deployment hosts its user parties on the operator's
configured participant. This is a deployment profile, not a contract-level
restriction on other participants. Connecting a wallet hosted elsewhere does
not move that wallet's party onto this participant.

CC and USDCx remain administered by Splice/DSO and DA Utilities respectively.
Installing their packages locally does not make the DEX their issuer. The
reference LP registry is a separate issuer component using the TSv2 interfaces;
its ownership by the DEX operator does not make its tokens off-chain balances.

The optional [hosted profile](HOSTED_TESTNET.md) adds browser-generated keys,
encrypted key backups, strict topology/transaction validation and externally
signed submission. Its full browser and backend implementation is in scope.
The retired operator-signed hosted branch and its faucet are not reused.
Review request authentication, secret isolation, backup loss, browser-origin
trust, key revocation, resource limits and ambiguous submission outcomes.

## Known limitations

- LP holdings exist on-ledger, but pool reserves are operator-controlled.
  Redemption requires the operator and LP registrar. There is no unilateral
  holder emergency withdrawal from reserve slices.
- Hosted users control external signing keys, but the browser and served
  frontend are trusted while unlocked. The operator still runs the confirming
  participant. Lost keys have no operator reset; automatic key rotation and
  topology-based session revocation are not implemented.
- Public account creation does not fund the account. Real CC/USDCx acquisition,
  issuer onboarding, incoming-transfer acceptance and traffic funding remain
  deployment prerequisites. The embedded adapter is not a general-purpose wallet.
- A TSv2 interface implementation does not guarantee every wallet supports its
  concrete package, version or operation. Loop's unvetted LP package is a known
  integration restriction, not a reason to bypass ledger authorization.
- The reference registry's credential records are illustrative. Its supplied
  claim checks are not production credential verification; holder requirements
  are not enforced as a production credential policy. Use empty requirements
  for the reference profile.
- Pool reserve totals remain a serialization point. Separate slices avoid an
  unbounded allocation list on pool state but do not establish horizontal AMM
  throughput.
- Pool state trusts its signing operator; see the documented parallel-state
  and reconciliation-completeness assumptions.
- The upgrade check is not evidence of compatibility when no deployed baseline
  DAR is provided. Existing testnet contracts must match the recorded package
  lineage and deployment artifact.

## Evidence boundaries

| Evidence | Establishes | Does not establish |
| --- | --- | --- |
| TypeScript tests | Application behavior under the tested dependencies and fixtures | Canton execution or wallet compatibility |
| Daml Script tests | Contract execution and assertions in the test environment | Public onboarding or independent participant topology |
| Throwaway Canton proof | Actual JSON Ledger API add/swap/remove execution | Real testnet CC/USDCx or independent user signing |
| External signing sandbox proof | User-key topology, rejection of unsigned submission, signed order and LP receipt allocation, browser hash validation | Funded live CC/USDCx settlement or another participant |
| Testnet transaction records | The specific parties, assets, packages and topology exercised | Untested wallets, participants or future versions |

For a claim of live interoperability, retain update IDs and configuration for
an add/swap/remove cycle against actual testnet CC and USDCx plus the reference
LP registry. For a claim of independent user control, include user-controlled
signing. For support across participants, include a second user-hosting
participant with the required packages vetted. Do not label these checks passed
until their corresponding evidence exists.

Upstream Canton, Splice, DA Utilities, third-party wallets and their operations
are external dependencies. Their implementations are outside this repository's
audit, while the assumptions and integrations this repository makes about them
are in scope. Traffic fees, external asset availability, validator operations,
key custody services and package vetting remain deployment responsibilities.
