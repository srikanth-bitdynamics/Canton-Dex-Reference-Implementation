# Choice Context & Disclosure Retrieval Spec

Defines what the DEX operator backend must attach to each transaction
it submits, in terms of registry-supplied disclosed contracts and
choice-context fields. Mirrors the Registry Utility user guide's
"Note: Before the command is submitted by the UI, an API call is being
made (in the background) to an endpoint to retrieve required additional
choice context (including disclosure)..." pattern.

## Endpoints the operator queries

Per registry, the operator backend fetches:

| Endpoint                                   | Returns                                   | Used by |
|--------------------------------------------|-------------------------------------------|---------|
| `GET /registry/instrument-config/:id`      | `InstrumentConfiguration` + disclosure    | Order, Pool, MatchedTrade, Rfq |
| `GET /registry/credentials?holder=:p`      | `Credential[]` for that party             | MintRequest_Accept, TransferOffer_Accept |
| `GET /registry/factories/:admin`           | `(AllocationFactory, SettlementFactory)` CIDs + disclosure | `PoolRules_Swap`, matched-trade settle |
| `GET /registry/choice-context/:admin`      | `ChoiceContextRef` (`context` + disclosure) | Pool, MatchedTrade, any registry-touching token-standard choice |
| `GET /registry/transfer-rule/:id`          | `TransferRule` (if any)                   | TransferOffer_Accept |
| `GET /registry/preapprovals?receiver=:p`   | `TransferPreapproval[]` for that receiver | TransferOffer_AcceptPreapproved |

These endpoints are spec; the actual registry implementation may use
different paths. The operator-backend's `registry-client` module is
the single integration point.

## Choice-context-bearing arguments

Each registry-touching choice the DEX exercises has a **context
shape** the operator must satisfy. Listed here as `(choice, required
context)` pairs.

### Allocation creation

`V2.AllocationFactory.AllocationFactory_Allocate`

Required inputs:
- `actors : [Party]` — the trader (for prefunded order or trade
  allocation) or operator (for committed pool-fund allocation).
- `allocation : V2.AllocationSpecification` — with `admin` set
  correctly; `nextIterationFunding` for prefunded shapes; `committed =
  True` for pool-fund shapes.
- `requestedAt : Time` — current ledger time (operator passes through
  from the request).
- `inputHoldingCids : [ContractId V2.Holding]` — chosen by the
  trader's wallet from their ACS to cover the funding amount.
- `extraArgs.context` — registry-specific context (typically empty for
  test registries; production may carry credential proofs or rate
  limits).

### Allocation request acceptance

`V2.AllocationRequest_Accept` (on `TradeAllocationRequest` or
`OrderAllocationRequest`)

Required inputs:
- `actors : [Party]` — typically `[trader]`. Operator can also accept if
  the implementation allows.
- `extraArgs.context` — empty for the reference self-registry; production
  registries may require their own context fields.

The wallet composes this with `AllocationFactory_Allocate` in the
same submission to avoid creating duplicate allocations.

### Settlement

`V2.SettlementFactory.SettlementFactory_SettleBatch`

Required inputs:
- `settlement : V2.SettlementInfo` — exactly the
  `mkOtcTradeSettlementInfo` output (or `poolSettlementInfo`).
- `transferLegs : [V2.TransferLeg]` — the legs being settled, in the
  order the allocations expect.
- `allocations : [V2.FinalizedAllocation]` — every allocation whose
  authorizer participates in the legs. For iterated settlement, each
  finalized allocation carries any settlement-time
  `extraTransferLegSides` and the desired `nextIterationFunding`.
- `actors : [Party]` — `[venue/operator]`.
- `extraArgs.context` — registry-supplied choice context for the
  allocation admin. Self-registries may return empty context.

### Iterated settlement

`V2.FinalizedAllocation.extraTransferLegSides` and
`V2.FinalizedAllocation.nextIterationFunding` on
`SettlementFactory_SettleBatch`.

Required inputs:
- `extraTransferLegSides` — concrete settlement leg-sides supplied by
  the app choice once the trade or pool action is known.
- `nextIterationFunding` — `Some` when the settlement should create a
  next-iteration allocation for remaining pool/order funding; `None`
  when the allocation terminates at this settlement.
- `extraArgs.context` — registry-supplied choice context for the
  settlement admin. Self-registries may return empty context.

### Mint accept

`MintRequest_Accept`

Required inputs:
- `configCid : ContractId InstrumentConfiguration` — fetched from the
  registry-client.
- `issuerClaims : [Credential]` — fetched from the credentials
  endpoint, keyed by the requestor's party. Empty list iff the config's
  `issuerRequirements` is empty (open issuance).

### Burn accept

`BurnRequest_Accept`

Same shape as Mint accept.

### Transfer accept

`TransferOffer_Accept`

Required inputs:
- `configCid : ContractId InstrumentConfiguration`
- `senderClaims : [Credential]` — sender's holder claims.
- `receiverClaims : [Credential]` — receiver's holder claims.

### Transfer accept (preapproved)

`TransferOffer_AcceptPreapproved`

Required inputs:
- `preapprovalCid : ContractId TransferPreapproval` — fetched via
  preapprovals endpoint.
- `configCid : ContractId InstrumentConfiguration`
- `senderClaims : [Credential]` — sender's holder claims.

## Disclosure retrieval pattern

The operator backend caches:

1. `InstrumentConfiguration` CIDs and their associated explicit-
   disclosure payloads, keyed by `instrumentId`. Refreshed on archive
   events.
2. Allocation/Settlement factory CIDs per admin. Refreshed on admin
   re-publish (the registry archives + recreates).
3. `TransferPreapproval` CIDs, keyed by `(receiver, admin)`.
4. Credentials, keyed by `(holder, instrumentId)` — short TTL because
   credentials can be revoked.

The cache keys are hashed; cache invalidation listens to a
`registryEventStream` (server-sent events from the registry's
disclosure endpoint).

## Failure modes the backend must handle

| Failure | Recovery |
|---|---|
| Stale `InstrumentConfiguration` CID (archived since cache fetch) | Refetch and retry once |
| Missing credential for required claim | Surface to the wallet UI; operator does not synthesize credentials |
| Factory CID stale | Refetch from `factories/:admin`; backoff on repeated failures |
| Preapproval revoked between fetch and submit | Fall back to offer/accept flow |
| Settlement batch rejected by factory | Cancel the trade, surface to operator monitoring |

The operator backend's `registry-client` module provides typed
errors for each so the calling code path can recover correctly.
