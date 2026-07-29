# Cross-registry pairs

*Design decision for pairing instruments from two different Token Standard V2 registries — Canton Coin against USDCx, either against a DA Utilities token, either against our own.*

Tree: `main` @ `cdc1cb8`. Every file:line below is from that commit.

---

## 1. The crux

**No — two registry admins cannot co-authorize one settlement, the standard forbids the attempt, and the DEX does not need it.**

That sentence is the whole design. `SettlementFactory` is admin-scoped *by the interface*, not by any implementation choice. `SettlementFactoryView` carries exactly one `admin : Party` (`vendor/splice/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml:370-371`); the interface doc says a factory "enables the net settlement of a batch of allocations for the same instrument admin" (`:379`); and the choice argument is normative — "All transfer legs MUST have the same instrument admin as the one of the factory" (`:400-402`). The standard's validator enforces it per allocation: `requireMatchExpected ("allocation.admin", allocation.admin) admin` (`vendor/splice/token-standard/splice-token-standard-utils/daml/Splice/TokenStandard/Utils/Internal/Allocations.daml:435`). A heterogeneous batch is not merely unsupported; it is non-conformant.

What actually happens instead is that each admin authorizes *its own* batch, from inside its own factory's subtree, and the batches are made atomic by living in the same Daml transaction. The mechanism:

- `SettlementFactory_SettleBatch` is `controller actors` (`AllocationV2.daml:433`), and the standard's default implementation checks only the executors: `checkActors actors [settlement.executors]` (`Allocations.daml:379`).
- The admin's authority is not supplied by the caller. It is already in scope inside the choice body, because the contract carrying the interface is signed by its admin. The implementation then injects it: `actors = allocView.allocation.admin :: allocView.settlement.executors` (`Allocations.daml:386-388`).
- Amulet does exactly this. The `V2.SettlementFactory` instance sits on `ExternalPartyAmuletRules`, whose sole signatory is the DSO (`vendor/splice/daml/splice-amulet/daml/Splice/ExternalPartyAmuletRules.daml:48`, `:52`, instance at `:141-147`), and `AmuletAllocationV2.allocation_settleImpl` accepts precisely `[dso :: allocation.settlement.executors]` (`vendor/splice/daml/splice-amulet/daml/Splice/AmuletAllocationV2.daml:98`).
- Our own registry already implements the same expansion (`trading/CantonDex/Registry/V2.daml:427` `signatory admin`; `:688-691` `expandedActors = if admin \`elem\` arg.actors then arg.actors else admin :: arg.actors`).

Upstream states this normatively and gives the motivation — app providers hitting this exact wall: "The `V2.Allocation_Settle` choice always only requires authorization from the `executors` and the instrument `admin`. Apps can thus call `V2.SettlementFactory_SettleBatch` using `executors` authority only" (`vendor/splice/token-standard/V2_VALIDATION.md:96-98`).

The practical consequence is the one that matters commercially: **the DSO is never asked anything.** It pre-authorized settlement once, when it created `ExternalPartyAmuletRules` — a contract upstream describes as "intended to get archived and recreated as rarely as possible" (`ExternalPartyAmuletRules.daml:45-47`). No admin submits, no admin signs, no admin appears in `actAs`, no governance action, no CIP.

This is not theory here. **This repository already settles a DvP across two independent registries in one transaction, with the foreign admin absent from `actAs`.** `PoolLiquidityRules_SettleAddLiquidity` issues two `SettlementFactory_SettleBatch` calls in one choice body — the base/quote batch under `pool.admin` (`trading/CantonDex/Dex/PoolLiquidityRules.daml:375`) and the LP-mint batch under `pool.lpRegistrar` (`:398`) — each with its own choice context (`:285-289`), and each with its *own leg subset* (`:377` versus `:400`). `RealRegistryDvpTests` runs that path with base and quote under the upstream `TestTokenV2_RegistryV2` and the LP mint under ours, in a single `submit (foldMap actAs [fx.operator, fx.lpRegistrar] ...)` (`trading-tests/CantonDex/Tests/RealRegistryDvpTests.daml:226`, factories wired at `:213-215`). `fx.ttAdmin` — the foreign registry's admin party — is nowhere in `actAs`. The negative control at `:255-268` blanks that registry's context and the settle aborts, proving the split is load-bearing rather than cosmetic.

Two corollaries worth stating because they invert common assumptions.

**Atomicity is free.** DvP atomicity comes from Daml transaction atomicity, not from batch count. N `SettleBatch` exercises in one choice body commit or roll back together, exactly as one does. `OrderMatchExecution_Execute` stays a single choice and a single submission. There is no principal-risk exposure introduced by splitting the batch, and no justification is owed for it. The design constraint "must not split into two independently-committable batches" is satisfied by construction.

**Netting is not lost on the order path.** Coverage is computed per instrument, not across instruments — ours iterates `forA_ (TextMap.toList needed)` per instrument id (`trading/CantonDex/Registry/V2.daml:257-260`), and Amulet's is scoped to the single Amulet instrument. A DEX order pays exactly one instrument and receives exactly one other, so no cross-instrument offset was ever available. Splitting by admin costs the order book nothing in capital efficiency. (This is genuinely different for the AMM, where a swap's input and output slices are both in play; see §4.)

The one thing that *can* defeat this, and which I could not verify from this tree, is **synchronizer confinement** — see §4 and §5.

---

## 2. What to build

The blocker is entirely app-layer. `OrderMatchExecution_Execute` takes one `factoryCid` and one `extraArgs` (`trading/CantonDex/Dex/OrderMatchExecution.daml:136-140`), asserts the two orders share an admin (`:182`), and issues a single `SettleBatch` (`:242-247`). `Order` carries one `admin : Party` and two bare `Text` ids (`trading/CantonDex/Dex/Order.daml:71-76`). That is the whole of it.

### 2.1 The shape

**One batch per leg, keyed by that leg's instrument admin, both inside `OrderMatchExecution_Execute`.**

```
base batch  @ baseInstrument.admin   legs = [base-delivery]
quote batch @ quoteInstrument.admin  legs = [quote-payment]
```

The standard requires each batch's allocations to cover its legs exactly — `requiredAuthorizations = concatMap transferLegSidesWithAuthorizer transferLegs` where `transferLegSidesWithAuthorizer leg = [(leg.sender, senderSide leg), (leg.receiver, receiverSide leg)]` (`Allocations.daml:164-165`), checked for both missing and superfluous authorizations (`:459-460`). So each batch needs two allocations:

| batch | sender side | receiver side |
|---|---|---|
| base @ `baseInstrument.admin` | seller's **funding** allocation | buyer's **receipt** allocation |
| quote @ `quoteInstrument.admin` | buyer's **funding** allocation | seller's **receipt** allocation |

The funding allocation is what exists today, unchanged in shape: `transferLegSides = []`, `nextIterationFunding = Some {payInstrument: lockAmount}`, `committed = True` (`Order.daml:193-201`), under the admin of the asset the trader *pays*. That admin is already computed — `lockInstrumentId = case side of Bid -> quoteInstrumentId; Ask -> baseInstrumentId` (`trading/CantonDex/Dex/OrderFundingRequest.daml:46-48`). It stays one allocation per order, one `Order.allocationCid`, one `Order_Cancel` against one registry.

The receipt allocation is new, and it is **minted at match time by the operator, not pre-authored by the trader**. Shape: all `ReceiverSide` legs for the fill, `nextIterationFunding = None`, `committed = False`, `inputHoldingCids = []`, `actors = [trader]`. It locks nothing, it is created and consumed inside the settling transaction, and it never rests on a foreign registry.

### 2.2 Why operator-minted receipts, not a second pre-authored allocation

Upstream's `OTCTradeAllocationRequest` emits one `AllocationSpecification` per `(authorizer, admin)` (`vendor/splice/token-standard/examples/splice-token-test-trading-app-v2/daml/Splice/Testing/Apps/TradingAppV2.daml:140-149`), and that is the obvious port. It is the wrong shape for a CLOB, for four reasons:

1. **The counterparty does not exist yet.** An OTC trade knows both sides before allocations are requested; a resting order does not. A pre-authored receive-side allocation therefore has to be leg-less (`transferLegSides = []`) with `nextIterationFunding = Some empty` and `committed = True` to survive iterated settlement across partial fills — which is *not* the standard's receipt shape, and is precisely the open-ended construct `ensureIsReceiptAllocation` exists to prevent.
2. **It doubles the lifecycle across two independent clocks.** Two committed allocations per order, two expiry regimes, two cancels. Amulet expires allocations at `min(settlementDeadline, now + 90 days)` (`AmuletAllocationV2.daml:223`, `:226`, `:228-231`) and bumps only on settle (`:233-239`), so a quiet resting order never self-heals. If one side is expired out from under the order, `Order_Cancel`'s `exercise allocCid cancelArg` (`Order.daml:158-160`) aborts on the dead cid and strands the *live* side — which for `committed = True` the trader cannot withdraw (`ensureWithdrawIsAllowed`, `Allocations.daml:279-287`). One funding allocation per order removes that failure class entirely.
3. **It is the pattern upstream documents.** "Apps need to create missing receipt allocations using their own delegation contracts from their traders. See the `TradingAppV2` implementation … Also note the use of `Splice.TokenStandard.Utils.ensureIsReceiptAllocation`" (`V2_VALIDATION.md:99-101`). The guard is vendored (`Allocations.daml:234-258`) and pins every field that matters: authorizer equals the trader's own account, `actors == [receiver]`, all legs `ReceiverSide`, `nextIterationFunding == None`, `committed == False`, `inputHoldingCids == []`, `extraArgs.meta == emptyMetadata`.
4. **Mint-and-settle-in-one-transaction against a real foreign registry already works here.** `PoolLiquidityRules` mints its operator-receiver allocations through the foreign `TestTokenV2` factory and settles them in the same choice body (`PoolLiquidityRules.daml:360-365` then `:375`), with the factory cid wired to `fx.ttFactoryCid` (`RealRegistryDvpTests.daml:213`). The only delta is that the authorizer becomes the trader instead of the operator.

**Where the trader's authority comes from — and this is the part that makes it cheap.** `OrderFundingRequest` is `signatory trader`, `observer operator` (`OrderFundingRequest.daml:20-21`), and `OrderFundingRequest_Bind` is `controller operator` (`:38-42`). Exercising that choice already puts the trader's authority in scope. So the delegation contract is created for free, inside the bind step the operator already performs, with **no additional trader signature and no new consent screen**. It is scoped to one order, dies with that order, and the trader can revoke it unilaterally.

### 2.3 Settlement identity — a defect that must be fixed anyway, and this design fixes it

`fetchAndValidateAllocations` requires every allocation in a batch to carry the *identical* `SettlementInfo` as the batch: `requireMatchExpected ("allocation.settlement", allocationView.settlement) settlement` (`Allocations.daml:434`).

Today the order path violates this. Funding allocations are born with `id = "DexOrder-" <> refId`, unique per order (`Order.daml:63-66`, `:185-189`; on the wire `app/web/src/services/ledger.ts:802` `id: \`DexOrder-${settlementRef}\``), while the match settles under `id = mkOrderMatchRefId matchId` = `"OrderMatch-" <> matchId` (`OrderMatchExecution.daml:39`, `:209-213`). Three distinct `SettlementInfo` values in one batch. **Against any conformant registry the order path aborts before cross-registry is even reached.** It works on testnet only because our `settlementFactory_settleBatchImpl` never reads `arg.settlement` at all (`Registry/V2.daml:684-733`) and neither does `allocation_settleImpl` (`:218-297`). By contrast the pool path anchors on a pool-stable constant, `poolSettlement ... id = "DexPool"; cid = Some poolCid` (`trading/CantonDex/Dex/PoolModel.daml:136-141`), used identically at allocate and settle time — which is exactly why `RealRegistryDvpTests` passes and no order-path equivalent could.

A venue-wide constant settlement id is the obvious fix, and it is the wrong one: it collapses every DEX allocation on a pair into one indistinguishable settlement in the wallet's approval view, and it knowingly breaks "The `executors` MUST ensure that the triple of `(id, cid, meta)` is unique across settlements" (`AllocationV2.daml:34-35`).

**The per-leg split makes it unnecessary.** `fetchAndValidateAllocations admin arg` validates settlement against *that batch's* `arg.settlement` only. Nothing requires two batches in one transaction to share a `SettlementInfo`. So:

- the **base** batch carries the **ask order's** own settlement ref — the seller's funding allocation already has it, and the buyer's receipt is minted at match time under it;
- the **quote** batch carries the **bid order's** own settlement ref, symmetrically.

Per-order settlement identity is preserved, the uniqueness MUST is honoured, the wallet keeps its per-order label, and the blast radius of any one batch stays one order. `SettlementFactory_SettleBatch` is `nonconsuming` (`AllocationV2.daml:388`), so two calls on the same factory contract with different settlements in one transaction are legal — which is what happens when both instruments share an admin.

That last point matters for staging: **the split is unconditional.** We do not branch on `baseInstrument.admin == quoteInstrument.admin`. Same-admin pairs get two batches on the same factory. The shape is uniform, today's testnet pair exercises the same code path as a future Canton-Coin pair, and the conformance defect is fixed for the current deployment rather than only for the new one.

There is a privacy dividend too: each registry's `settlementFactory_settleBatchExtraObservers` now sees only its own leg. Ours returns `[]` (`Registry/V2.daml:678`); Amulet scopes observers to the account parties of the legs it is given (`ExternalPartyAmuletRules.daml:149-150`).

### 2.4 The Daml

```daml
-- trading/CantonDex/Dex/Order.daml
--
-- WAS: admin : Party  +  baseInstrumentId : Text  +  quoteInstrumentId : Text   (:71-76)
-- V2.InstrumentId is { admin : Party, id : Text }
--   (vendor/.../splice-api-token-holding-v2/.../HoldingV2.daml:12-20)
-- and is already round-tripped Daml -> JSON -> backend -> dApp for the LP token
--   (Pool.daml:46, Lp/Policy.daml:12+:22, services/operator-backend/src/types.ts:102,
--    app/web/src/types/contracts.ts:66).
template Order with
    operator : Party
    trader : Party
    baseInstrument : V2.InstrumentId
    quoteInstrument : V2.InstrumentId
    side : Side
    limitPrice : Decimal
    remainingQty : Decimal
    expiry : Optional Time
    status : OrderStatus
    allocationCid : Optional (ContractId V2.Allocation)
      -- ^ UNCHANGED: the one funding allocation, under (payInstrument this).admin.
    receiptDelegationCid : Optional (ContractId ReceiptDelegation)
      -- ^ Trader-signed permission for the operator to mint this order's
      --   receive-side allocation at match time.
    settlementRef : SettlementRef

payInstrument, receiveInstrument : Order -> V2.InstrumentId
payInstrument o     = case o.side of Bid -> o.quoteInstrument; Ask -> o.baseInstrument
receiveInstrument o = case o.side of Bid -> o.baseInstrument;  Ask -> o.quoteInstrument
```

```daml
-- trading/CantonDex/Dex/ReceiptDelegation.daml  (new)
--
-- Created inside OrderFundingRequest_Bind, which is `controller operator` on a
-- contract whose signatory is the trader (OrderFundingRequest.daml:20-21, :38-42),
-- so the trader's authority is already in scope. No extra signature, no consent
-- screen, scope = one order.
template ReceiptDelegation with
    operator : Party
    trader : Party
    receiveInstrument : V2.InstrumentId
  where
    signatory operator, trader

    choice ReceiptDelegation_Revoke : ()   controller trader   do pure ()
    choice ReceiptDelegation_Release : ()  controller operator do pure ()

    nonconsuming choice ReceiptDelegation_CreateReceipt : ContractId V2.Allocation
      with
        factoryCid : ContractId V2.AllocationFactory
        choiceArg  : V2.AllocationFactory_Allocate
      controller operator
      do
        -- Bind the delegation to ONE registry. ensureIsReceiptAllocation
        -- validates choiceArg only; it never inspects factoryCid
        -- (Allocations.daml:240-258), and AllocationFactory_Allocate is
        -- `controller actors` == [trader], so an unbound factoryCid would run
        -- arbitrary code with the trader's authority. Upstream's
        -- TradeSettlementAgreement_CreateReceiptAllocation has this same gap
        -- (TradingAppV2.daml:371-381); it is a test app.
        assertMsg "receipt admin is not the order's receive registry"
          (choiceArg.allocation.admin == receiveInstrument.admin)
        fv <- view <$> fetch factoryCid
        assertMsg "factory is not the receive instrument's registry"
          (fv.admin == receiveInstrument.admin)
        forA_ choiceArg.allocation.transferLegSides $ \s ->
          assertMsg "receipt leg instrument mismatch"
            (s.instrumentId == receiveInstrument.id)
        -- ReceiverSide-only, no funding, not committed, no input holdings,
        -- actors == [trader], no extraArgs.meta.
        ensureIsReceiptAllocation [operator] trader (Utils.basicAccount trader) choiceArg
        exercise factoryCid choiceArg >>= extractCompletedAllocation
```

```daml
-- trading/CantonDex/Dex/OrderMatchExecution.daml

-- Everything one registry contributes to one fill. Never merged across
-- registries: each carries its own choice context, and each registry only
-- resolves its own keys (RealRegistryDvpTests.daml:255-268). Allocate and
-- settle need DIFFERENT contexts on Amulet
-- (ExternalPartyAmuletRules.daml:445 vs AmuletAllocationV2.daml:129).
data RegistryLeg = RegistryLeg with
    allocFactoryCid  : ContractId V2.AllocationFactory
    settleFactoryCid : ContractId V2.SettlementFactory
    allocExtraArgs   : ExtraArgs
    settleExtraArgs  : ExtraArgs
  deriving (Eq, Show)

template OrderMatchExecution with
    operator : Party
    matchId : Text
    match : MatchedOrderPair          -- base/quoteInstrument now V2.InstrumentId
    buyOrderCid  : ContractId Order
    sellOrderCid : ContractId Order
    buyerAllocationCid  : ContractId V2.Allocation
    sellerAllocationCid : ContractId V2.Allocation
    buyerReceiptDelegationCid  : ContractId ReceiptDelegation
    sellerReceiptDelegationCid : ContractId ReceiptDelegation
  where
    signatory operator

    choice OrderMatchExecution_Execute : OrderMatch_ExecuteResult
      with
        baseRegistry  : RegistryLeg   -- WAS: factoryCid + extraArgs (:136-140)
        quoteRegistry : RegistryLeg
      controller operator             -- UNCHANGED: no admin in actAs
      do
        -- All existing guards at :151-206 carry over unchanged, including the
        -- allocation-belongs-to-this-order asserts (:167-170) whose comment
        -- records why they exist. Two new asserts bind the delegations the
        -- same way. DELETED: :182 "registry admin mismatch" -- subsumed by
        -- InstrumentId equality.

        let baseLeg  = mkBaseLeg match          -- seller -> buyer
            quoteLeg = mkQuoteLeg match         -- buyer  -> seller
            baseSettlement  = sellOrder.settlementRef   -- ask's own
            quoteSettlement = buyOrder.settlementRef    -- bid's own

        -- Per-leg remainder. remainderFunding (:71-84) summed outflows across
        -- ALL legs keyed by bare instrumentId; with two registries both
        -- plausibly naming a token "USDC" that silently cross-funds. Each side
        -- pays exactly one instrument, so scope it to that side's own leg.
        let sellerNext = sideRemainder sellOrder sellerAllocation match.sellerAccount baseLeg
            buyerNext  = sideRemainder buyOrder  buyerAllocation  match.buyerAccount  quoteLeg

        now <- getTime
        buyerReceiptCid <- exercise buyerReceiptDelegationCid
          ReceiptDelegation_CreateReceipt with
            factoryCid = baseRegistry.allocFactoryCid
            choiceArg  = mkReceiptAllocate baseSettlement match.buyerAccount
                           match.baseInstrument baseLeg now baseRegistry.allocExtraArgs
        sellerReceiptCid <- exercise sellerReceiptDelegationCid
          ReceiptDelegation_CreateReceipt with
            factoryCid = quoteRegistry.allocFactoryCid
            choiceArg  = mkReceiptAllocate quoteSettlement match.sellerAccount
                           match.quoteInstrument quoteLeg now quoteRegistry.allocExtraArgs

        -- Batch 1 -- the base instrument's registry.
        baseResult <- exercise baseRegistry.settleFactoryCid
          V2.SettlementFactory_SettleBatch with
            settlement   = baseSettlement
            transferLegs = [baseLeg]        -- PER-ADMIN SUBSET
            allocations =
              [ Utils.mkFinalizedAllocation sellerAllocationCid
                  (Utils.legsToSides match.sellerAccount [baseLeg]) sellerNext
              , nonIteratedAllocation buyerReceiptCid
              ]
            actors    = [operator]
            extraArgs = baseRegistry.settleExtraArgs

        -- Batch 2 -- the quote instrument's registry. Same transaction: if this
        -- aborts, batch 1 rolls back with it. That is the whole atomicity
        -- argument. Cf. PoolLiquidityRules.daml:375 + :398.
        quoteResult <- exercise quoteRegistry.settleFactoryCid
          V2.SettlementFactory_SettleBatch with
            settlement   = quoteSettlement
            transferLegs = [quoteLeg]
            allocations =
              [ Utils.mkFinalizedAllocation buyerAllocationCid
                  (Utils.legsToSides match.buyerAccount [quoteLeg]) buyerNext
              , nonIteratedAllocation sellerReceiptCid
              ]
            actors    = [operator]
            extraArgs = quoteRegistry.settleExtraArgs

        -- Result order is normative -- "In the same order as the `allocations`
        -- in the choice arguments" (AllocationV2.daml:449-451) -- so index 0 of
        -- each batch is that side's funding allocation and index 1 is its
        -- receipt, which never iterates. Replaces the [0]/[1] reads over one
        -- merged result at :249-255, which the split would have silently
        -- re-bound to the counterparty.
        (sellerNextCid, buyerNextCid) <- readOneFundingNext baseResult quoteResult

        buyRemainderCid  <- rollOrderForward buyOrderCid  buyOrder  match.fillQty buyerNext  buyerNextCid
        sellRemainderCid <- rollOrderForward sellOrderCid sellOrder match.fillQty sellerNext sellerNextCid
        -- SettledTrade records both InstrumentIds instead of one `admin`
        -- (MatchedTrade.daml:201), or the audit trail cannot reconstruct a
        -- cross-registry fill.
```

```daml
-- trading/CantonDex/Registry/V2.daml -- conformance hardening.
-- Our settleBatchImpl currently reads neither arg.settlement nor
-- arg.transferLegs (:684-733) and omits the executors check. That is what
-- hides the settlement-identity defect and MatchedTrade.daml:153 from every
-- test we have. Until this lands, a green Daml suite is not evidence.
      settlementFactory_settleBatchImpl _self arg = do
        checkActors arg.actors [arg.settlement.executors]     -- Allocations.daml:379
        validated <- fetchAndValidateAllocations admin arg     -- :434 settlement, :435
                                                               --   admin, :459-460 coverage
        ... existing per-instrument conservation check (:706-722) ...
        ... existing Allocation_Settle with expandedActors (:688-691, :725-732) ...
```

Also, independently: `MatchedTrade_Settle` passes the **full** `transferLegs` template field to every per-admin batch (`trading/CantonDex/Dex/MatchedTrade.daml:150-157`, specifically `:153`). Upstream passes the per-admin subset (`TradingAppV2.daml:203`). Against a conformant registry that aborts on `superfluous authorizations` (`Allocations.daml:460`) the moment a second admin exists. It is latent today only because our registry ignores the argument.

### 2.5 What it costs

Daml: `Order`, `OrderAllocationRequest`, `OrderFundingRequest`, `OrderMatchExecution`, `DexPair`, `MatchedTrade`/`TradeAllocationRequest`/`SettledTrade`, `Pool`, `Rfq` — nine `admin : Party` declaration sites across `trading/CantonDex/Dex/*.daml` (`DexPair.daml:25`, `OrderFundingRequest.daml:12`, `Order.daml:71` and `:172`, `MatchedTrade.daml:26`/`:105`/`:201`, `Pool.daml:39`, plus `Rfq_Accept`'s choice argument at `Rfq.daml:95`, which is a call-site change not a template migration). Fifteen modules under `trading/CantonDex/Dex/`, twelve Daml test modules under `trading-tests/CantonDex/Tests/`. Roughly two-thirds of the Daml work is mechanical retyping; the irreducible part is `OrderMatchExecution`, the new delegation template, and the registry hardening.

TypeScript: 36 `.ts`/`.tsx` files reference `baseInstrumentId`/`quoteInstrumentId`; 26 reference `context.admin`, `getFactories`, or `getChoiceContext`; 18 files subclass `RegistryClient` or define a stub. The genuinely new component is a per-admin registry directory — `RegistryClientConfig` has a single `baseUrl` (`services/registry-client/src/index.ts:35-42`) although every method and cache is already keyed by admin (`:48-57`, `:89`, `:110`).

Two backend items that no prior scoping caught and that will bite first:

- `services/operator-backend/src/ledger/recover.ts:9` filters created events by `"CantonDex.Registry.V2:Allocation"` and throws on a count mismatch (`:32-40`), called with `expectedAllocations = 1` from `order/index.ts:140-144`. This is the *only* path for updateId-only wallets — PartyLayer and the CIP-0103 SDK, i.e. the main branch's stated audience. A foreign registry's allocation template never matches, so the first cross-registry order placement fails *after* the wallet has committed. It needs interface-based classification, which in turn needs an `InterfaceFilter` branch in `services/operator-backend/src/ledger/json-api.ts:105-124`. The same change unblocks `/v1/holdings`, which today queries two concrete template ids (`services/operator-backend/src/http/index.ts:1477`) and therefore reports zero for any registry that is not ours.
- `getChoiceContext(admin)` is the wrong *shape*, not merely single-endpoint. Ours is argument-independent and TTL-cached (`registry-client/src/index.ts:110-120`, cache at `:55-57`); the real registry API is choice-argument-dependent, and Amulet's allocate and settle read different context (`ExternalPartyAmuletRules.daml:445` versus `AmuletAllocationV2.daml:129`). `runMatching` resolving one context per *run* (`order/index.ts:288-291`) and reusing it for every match (`:341`, `:363-366`) is free against an empty context and wrong against a real one.

Honest total for one engineer, excluding externally-gated work: **8–10 weeks.**

---

## 3. The custody claim, corrected

The brief states as a non-negotiable that "committed allocation legs today cap both the amount AND the destination." **That is false for the order path and always has been.** A resting order's allocation is created with `transferLegSides = []` and only `nextIterationFunding` (`Order.daml:196-199`; the generic constructor `Utils.mkPrefundedAllocationSpecification` does the same at `trading/CantonDex/Trading/Utils.daml:156-169`). It caps the **amount**. The destination is supplied by the executor at settle time via `FinalizedAllocation.extraTransferLegSides`, and no registry constrains it — `validateNextIterationArgs` checks only that amounts are positive (`Allocations.daml:402-415`), and Amulet's `validateAmuletTransferLegs` checks uniqueness, instrument and sign only (`AmuletAllocationV2.daml:213-219`). What bounds it is entirely app-layer: `OrderMatchExecution_Execute` re-derives every leg from the traders' own order terms and refuses anything outside them (`OrderMatchExecution.daml:167-206`).

A CLOB cannot avoid this. A resting maker cannot name a counterparty that does not exist yet. Upstream says so directly: asset owners "must only create allocations for `executors` that they trust to atomically settle trades involving their allocations" (`V2_VALIDATION.md:103-105`).

What the recommended design does about it:

- The **receive side becomes destination-capped by construction.** `ensureIsReceiptAllocation` forces `ReceiverSide`-only legs with `nextIterationFunding = None` (`Allocations.daml:250-253`), which means `validateNextIterationArgs` forbids executor-supplied extras on it. A pre-authored open-ended receive-side allocation would have had the opposite property. This is the single strongest reason to prefer the minted receipt.
- The **pay side stays amount-capped only**, bounded by the settlement deadline. That residual is irreducible at the app layer and must be documented as such rather than denied.
- Therefore **`settlementDeadline = None` must be forbidden.** Today `expiry` flows straight through (`Order.daml:197`; on the wire `app/web/src/services/ledger.ts:732`, `:810`), and GTC means `None`. On a conformant registry, `committed = True` with no deadline can *never* be withdrawn — `None -> failWithStatus (cannotWithdrawCommittedAllocationFailure None)` (`Allocations.daml:282-283`), message "Cannot withdraw a committed allocation that has no settlement deadline" (`:268`), and `canWithdraw = not committed || isSome settlementDeadline` (`:579`). Amulet enforces it (`AmuletAllocationV2.daml:81`) and its DSO-side expiry choice is not implemented (`:56`, `TODO(#4525)`). A GTC order backed by Canton Coin would be funds the trader can never unilaterally recover. Our own registry currently masks this: `allocation_withdrawImpl` (`Registry/V2.daml:316-330`) inspects neither `arg.actors` nor `committed` nor the deadline and releases unconditionally.

So: bound every order allocation with a real deadline, re-fund on approach, and rewrite the custody paragraph in `docs/concepts/liquidity-and-custody.md` to say what is true — amount capped, destination not, operator is a trusted executor for the deadline's duration, receive side capped by the standard's own receipt guard.

---

## 4. What this cannot do

**Pairs whose two registries are not on a common synchronizer.** A Canton transaction commits on exactly one synchronizer, so both registries' factories, both traders' holdings and allocations, and every disclosed context contract must be assigned to the same one, and all stakeholders' participants must be connected to it. Nothing in this repository tests this: Daml Script is single-domain, so `RealRegistryDvpTests` proves the authorization model and says nothing about topology. The submission attaches one process-wide `synchronizerId` (`services/operator-backend/src/ledger/json-api.ts:232-234`) while each `DisclosedContract` may carry its own (`services/registry-client/src/types.ts:65`), and nothing reconciles them. **This is the only thing that can turn "atomic" into "impossible", and no app-level construct rescues it** — reassignment must be initiated by a stakeholder of the contract, and the operator is not a stakeholder of a trader's locked Amulet. In practice this scopes cross-registry pairs to instruments sharing the Global Synchronizer. Verify before building (§5).

**V1-only registries.** `SettlementFactory` is a V2 construct; there is no V1 equivalent. DA Utilities is V1-only today, so Utilities tokens are unpairable until their V2 registry ships regardless of anything here.

**Registries whose allocate returns `Pending`.** The receipt must complete in one step. Verified for Amulet as vendored (`ExternalPartyAmuletRules.daml:489-493` — the `fundingAmount <= 0.0` branch creates no `LockedAmulet` and returns `Completed`) and for `TestTokenV2`. The standard permits `Pending`, and upstream refuses it too ("Receipt allocation with multi-step allocation workflows is not supported", `TradingAppV2.daml:388-389`). A pair whose registry does multi-step allocation cannot be listed.

**Non-basic accounts.** Amulet hard-fails `ensureBasicAccount "allocation.authorizer"` (`ExternalPartyAmuletRules.daml:449`), and `ensureIsReceiptAllocation` pins the authorizer to the trader's basic account (`Allocations.daml:246`). Provider-mediated / custodial trader accounts are out of scope.

**Resting orders outliving their collateral.** Amulet caps allocation lifetime at 90 days and bumps only on settle. Bounded deadlines and an expiry sweeper reduce this to an operational task; they do not eliminate it, and `Order_Cancel` must be made tolerant of an already-archived allocation rather than aborting on it (`Order.daml:152-163`).

**RFQ.** `Rfq.pair : Text` split by `splitPair` (`Rfq.daml:53`, `:150`, `:266-269`, which silently yields `("","")` on a malformed pair) cannot express two admins. RFQ stays single-registry until retyped; that is a separate, smaller piece of work.

**The AMM, initially.** Pools are staged after the order book (§5). Note the asymmetry with orders: a swap's swapper allocation carries the input sender side *and* every output receiver side in one allocation under one admin (`trading/CantonDex/Dex/PoolRules.daml:156-157`), and the positional next-iteration guard (`:169-177`) has to be re-derived per batch. Unlike the order book, a cross-registry pool genuinely does lose a netting affordance and needs its own receipt handling.

**Operator-side pricing and metadata for foreign instruments** until `getInstrumentConfig` is keyed on `(admin, id)` rather than bare id (`registry-client/src/index.ts:69-84`) and the indexer's `pairKey` (`indexer/index.ts:317`, schema at `indexer/db.ts:46-59`) is migrated.

---

## 5. Staging

Each stage is independently shippable and leaves the DEX working.

**Stage 0 — the gate (≈1 week, no code).** Establish whether Amulet's factories and a trader's locked Amulet can share a synchronizer with our registry's contracts on the target network, and whether the operator's participant can obtain the disclosures for both in one submission. Probe against DevNet from the validator host. If the answer is no, stop: nothing below rescues it. Also re-vendor `splice-amulet` — the current snapshot does not compile against the vendored token-standard (`ExternalPartyAmuletRules.daml:147` passes three arguments to a helper that takes four at `Allocations.daml:368-377`; `AmuletAllocationV2.daml:99` reads `allocation.settlement.settlementDeadline`, a field the vendored `SettlementInfo` does not have — it is on `AllocationSpecification` at `AllocationV2.daml:108`). Every Amulet claim in this document is "as vendored" until that is done.

**Stage 1 — off-ledger only (≈2–3 weeks). This is the stage that ships alongside the current testnet deployment without touching it.** No DAR, no Daml, no behaviour change. Build the admin→endpoint registry directory; reshape `getChoiceContext` into an argument-dependent per-call fetch and drop the per-admin cache; replace `FixedRegistry` (`services/operator-backend/src/testnet-server.ts:49-66`) and the stub subclasses with per-admin fixtures; add the `InterfaceFilter` branch to `json-api.ts` and move `recover.ts` and `/v1/holdings` onto the `HoldingV2` interface; introduce a canonical `(admin, id)` wire encoding derived from today's `admin` + `Text` fields and migrate the indexer `pairKey`. Every one of these is required by the later stages and none of them depends on them.

**Stage 2 — Daml: split the settle, single-admin (≈2 weeks).** Two batches per fill keyed by leg, per-order settlement per batch, the `ReceiptDelegation` template created in `OrderFundingRequest_Bind`, per-leg `remainderFunding`, per-batch next-iteration reads, the `MatchedTrade_Settle` leg-subset fix, and the `Registry.V2` conformance checks. `baseInstrument.admin == quoteInstrument.admin` throughout — both batches hit the same factory. **After this stage the order path settles against a conformant registry for the first time**, which is independently valuable and is the prerequisite for everything else. Write the order-path analogue of `RealRegistryDvpTests` here, against `TestTokenV2`; the fixture already exists (`RealRegistryDvpTests.daml:116-165`). New DAR; keep lineage by adding `receiptDelegationCid` as `Optional` at the end of the record (`docs/guides/builder-guide.md:199-207`).

**Stage 3 — Daml: the type change (≈2 weeks).** `admin : Party` + two `Text` → two `V2.InstrumentId` across the venue templates; per-leg factory and context resolution in the backend (copy `services/operator-backend/src/pool/index.ts:623-639`, `:839-844`, `:861-872`, which already resolves two admins and merges four disclosure sets); `/v1/orders/match` stops passing `context.admin` (`http/index.ts:669-673`); `DexContext` becomes per-admin or per-operation; the matching engine's `PairKey` becomes `(admin, id)`-keyed (`order/matching.ts:24-31`); flip `MULTI_ADMIN_PAIRS_SUPPORTED` (`services/operator-backend/test/dex-registry-admin-shape.test.ts:25`) and rewrite `docs/guides/registry-integration.md:208-227`. This is the stage that breaks upgrade lineage unless done additively (§6, decision 3).

**Stage 4 — dApp (≈1.5 weeks).** `admin` becomes required in holding selection (`app/web/src/services/ledger.ts:202-215`, `:268-290`) — optional today, so an id-only match can pick the wrong registry's holdings; `ASSETS` keyed by `(admin, id)` (`app/web/src/primitives/assets.ts`); pair pickers and RFQ call sites. The wallet composition layer needs almost nothing: `BatchingUtilityV2`'s holding map is already keyed by `ScopedAccount = (admin, account)` (`vendor/splice/daml/splice-util-token-standard-wallet/daml/Splice/Util/Token/Wallet/BatchingUtilityV2.daml:55-62`) and the dApp already buckets that way (`app/web/src/wallet/commands.ts:313-316`). Note that `BatchingUtilityV2` is `signatory user` / `controller user` (`:172`, `:184`) and its action vocabulary (`:116-138`) contains no settlement constructor at all — it solves wallet-side composition and contributes zero settlement authority. That is fine: settlement authority comes from the factories.

**Stage 5 — first real foreign pair (≈1 week + external).** Stand up a second `Registry.V2` instance under a different party as the integration harness (the template is already party-parameterised — `Registry.V2.daml:421-428` — so this is a second *contract*, not a second DAR), then Amulet.

**Stage 6 — AMM (≈2 weeks).** `PoolRules_Swap` and `PoolLiquidityRules` cross-registry. Deliberately last.

---

## 6. Decisions only the owner can make

**1. Receipt authorship.** Operator-minted at match time through a bind-time trader delegation, versus a second trader-pre-authored allocation carried in the same `AllocationRequest`. *Recommend minted.* It keeps one allocation and one cancel per order, uses the standard's own audited receipt shape, and costs no new consent screen because `OrderFundingRequest_Bind` already carries the trader's authority. Choosing pre-authored instead buys upstream-identical structure and a slightly smaller Daml surface, at the cost of a second committed allocation resting on a registry we do not control, with its own expiry clock and its own cancel — and a receive-side allocation that is *not* destination-capped.

**2. Settlement identity.** Per-order per-batch (the ask's ref on the base batch, the bid's on the quote batch), versus a venue-and-pair constant. *Recommend per-order.* It honours `AllocationV2.daml:34-35`, keeps the wallet's per-order label, and confines each batch to one order. The constant is simpler to reason about and would let base and quote share one batch when the admins coincide; it costs the uniqueness guarantee and collapses every allocation on the pair into one settlement in the trader's wallet.

**3. Upgrade lineage.** Additive `Optional` fields to preserve smart-upgrade lineage on the `canton-dex-trading 0.1.x` line (`trading/daml.yaml`), versus a clean retype plus package rename. *Recommend additive through Stage 2, clean retype at Stage 3 with a package rename and a planned testnet drain.* Carrying `admin : Party` + two `Text` alongside two `InstrumentId` fields forever is worse for a reference implementation than one honest break. But do the break once, at Stage 3, and drain the book first — `NOT_VALID_UPGRADE_PACKAGE` on a live deployment leaves existing contracts queryable but unupgradable (`docs/guides/operator-runbook.md:191-201`).

**4. GTC orders.** Forbid `settlementDeadline = None` on order allocations, versus keeping GTC. *Recommend forbidding it*, enforced in Daml on `OrderAllocationRequest` rather than only in the dApp, with GTC re-expressed as a rolling deadline the operator re-arms. Keeping GTC means a Canton Coin order the trader can never unilaterally recover.

**5. Uniform split versus branching.** Always two batches, versus one batch when the admins coincide. *Recommend always two.* It fixes today's conformance defect, makes the testnet pair exercise the production code path, and removes a branch from the hardest choice body in the codebase. The cost is two extra zero-funding allocate calls per fill — cheap against our registry, no lock against Amulet.

**6. AMM scope.** Cross-registry pools now, versus order book first. *Recommend order book first.* Pools carry a real netting cost the order book does not, plus multi-slice draw logic and positional guards that must be re-derived per batch, and none of it is on the critical path to the stated audience.

---

## 7. What would change this answer

**A standard change putting the admin back on `TransferLeg`.** Today `TransferLeg.instrumentId` is bare `Text` (`AllocationV2.daml:66`), so a leg list cannot self-describe two registries — which is why partitioning has to be done by the app. V1 carried a full `InstrumentId` on the leg; V2 deliberately flattened it when it introduced the admin-scoped batch. If that were reverted, leg partitioning would become mechanical and `MatchedTrade`'s leg-subset class of bug would become impossible. It would *not* change the authorization answer. Detect: the type of `TransferLeg.instrumentId` in `splice-api-token-allocation-v2`.

**A standard-level receipt affordance.** If `AllocationRequest` gained an explicit receipt-side convention, or `Splice.TokenStandard.Utils` gained a factory-bound receipt helper, the `ReceiptDelegation` template and its factory-cid hardening would be deleted outright. Detect: new exports from `Splice.TokenStandard.Utils`, or a new field on `AllocationRequestView`.

**DA Utilities V2.** Utilities tokens are unpairable while their registry is V1-only, because V1 has no `SettlementFactory`. Detect: `getFactories(utilitiesAdmin)` returning a settlement factory cid, or their published DAR depending on `splice-api-token-allocation-v2`.

**Amulet's DSO expiry choice landing** (`AmuletAllocationV2.daml:56`, `TODO(#4525)`). Today an Amulet allocation's `expiresAt` is computed and stored but nothing exercises it, so a committed no-deadline allocation is permanently stuck. Once the expiry choice ships, the failure mode changes from "stuck forever" to "expires on the DSO's schedule" — which makes the expiry sweeper (§4) mandatory rather than merely prudent, but makes GTC survivable. Detect: that TODO disappearing upstream.

**Canton cross-synchronizer atomic transactions**, or a reassignment affordance usable by a non-stakeholder. This is the only development that would lift the one hard constraint in §4. Detect: Canton release notes on multi-synchronizer transactions; or, negatively, confirm at Stage 0 that Amulet and any candidate registry already share the Global Synchronizer, which makes the question moot for the realistic pair set.

**A joint, two-admin-signed settlement factory.** Worth naming so it is not re-litigated. It would need a contract with `signatory adminA, adminB`, which requires the foreign admin to *exercise* a choice it controls — and no such choice exists in `ExternalPartyAmuletRules`, whose complete choice set is `ExternalPartyAmuletRules_ExpireAmuletAllocations` (`controller dso`, `:54-60`) and `ExternalPartyAmuletRules_CreateTransferCommand` (`controller sender`, `:76-89`). Neither creates a caller-supplied template. Adding one is an SV-governed `splice-amulet` change. Even granted, it would break three normative clauses of the standard, make our partitioning code the trust boundary for a registry's own assets, and buy nothing over per-admin batches — atomicity is already free and netting is already per-instrument. Detect: a standardized inter-registry propose/accept appearing upstream. Until then, treat it as unavailable and do not spend time on it.

---

## 8. Where I am uncertain

Stated plainly rather than hedged:

- **Synchronizer co-location is unverified and unverifiable from this tree.** It is a precondition of the atomicity claim, not a footnote. Stage 0 exists for it.
- **Every Amulet claim is "as vendored".** `vendor/splice/daml/splice-amulet` is a staler snapshot than `vendor/splice/token-standard` and the two do not compile against each other (`ExternalPartyAmuletRules.daml:147` versus `Allocations.daml:368-377`; `AmuletAllocationV2.daml:99` versus `AllocationV2.daml:36-51`). The delegation pattern — DSO-signed factory, `dso :: executors` actors — is identical in both, so no conclusion in §1 depends on the difference. Field-level behaviour of the zero-funding receipt does. Re-verify against upstream `main` or a DevNet probe before Stage 5.
- **The `view`-based factory-admin check in `ReceiptDelegation` is defence in depth, not a proof.** A malicious template implementing `V2.AllocationFactory` can report any admin in its view. The real backstop is Canton package vetting on the trader's participant, which is exactly null for traders hosted on the operator's own participant. Keep the delegation scoped to one order so a compromise costs one order rather than a trader's whole authority, and do not offer this path to hosted parties without saying so.
- **One-step completion of the receipt allocation is verified for two registries, not guaranteed by the standard.** If a candidate registry returns `Pending`, that pair cannot be listed; probe it before listing rather than discovering it in a failed fill.