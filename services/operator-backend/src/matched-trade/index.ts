// MatchedTrade flow.

import type { ContractId } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { fetchChoiceContext, type ChoiceContext } from "../ledger/choice-context.js";
import { LedgerSubmitter } from "../ledger/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import type { Party } from "../types.js";

export interface MatchedTradeRequestAllocationsInput {
  tradeCid: ContractId<"MatchedTrade">;
}

export interface MatchedTradeSettleInput {
  tradeCid: ContractId<"MatchedTrade">;
  batchesByAdmin: Map<Party, SettlementBatchV2>;
  /**
   * Trade allocation requests to consume. Normally EMPTY.
   *
   * MatchedTrade_Settle fetches and archives each of these as its first act,
   * but a counterparty that authored its allocation via
   * AllocationRequest_Accept has already archived its own request. Passing a
   * consumed cid therefore aborts the choice before a single holding is read
   * -- and fails looking exactly like a visibility error. Supply cids only for
   * requests that are provably still active.
   */
  allocationRequestCids: ContractId<"TradeAllocationRequest">[];
  /** When set, fees accrue against the pair; null/omitted = no accrual. */
  dexPairCid?: ContractId<"DexPair"> | null;
}

export interface MatchedTradeCancelInput {
  tradeCid: ContractId<"MatchedTrade">;
  allocationsByAdmin: Map<Party, ContractId<"Allocation">[]>;
  allocationRequestCids: ContractId<"TradeAllocationRequest">[];
}

export interface SettlementBatchV2 {
  allocationCids: ContractId<"Allocation">[];
}

export class MatchedTradeService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly registry: RegistryClient,
    private readonly operatorParty: Party,
  ) {}

  private choiceContext(admin: Party): Promise<ChoiceContext> {
    return fetchChoiceContext(this.registry, admin);
  }

  async requestAllocations(
    input: MatchedTradeRequestAllocationsInput,
  ): Promise<ContractId<"TradeAllocationRequest">[]> {
    return retryOnContention(() =>
      this.ledger.submit<ContractId<"TradeAllocationRequest">[]>({
        actAs: [this.operatorParty],
        commandId: `mt-req:${input.tradeCid}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
          contractId: input.tradeCid,
          choice: "MatchedTrade_RequestAllocations",
          argument: {},
        },
      }),
    );
  }

  async settle(input: MatchedTradeSettleInput): Promise<unknown> {
    const adminEntries: Array<{
      admin: Party;
      batch: SettlementBatchV2;
      factoryCid: ContractId<"SettlementFactory">;
      extraArgs: {
        context: { values: Record<string, unknown> };
        meta: { values: Record<string, unknown> };
      };
      disclosure: unknown[];
    }> = [];
    for (const [admin, batch] of input.batchesByAdmin) {
      const [factories, ctx] = await Promise.all([
        this.registry.getFactories(admin),
        this.choiceContext(admin),
      ]);
      adminEntries.push({
        admin,
        batch,
        factoryCid: factories.settlementFactoryCid,
        extraArgs: ctx.extraArgs,
        disclosure: [...factories.disclosure, ...ctx.disclosure],
      });
    }

    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        // MatchedTrade_Settle reaches SettlementFactory_SettleBatch ->
        // Allocation_Settle -> allocation_settleImpl, which FETCHES and
        // ARCHIVES the locked holdings behind each counterparty allocation. A
        // registry Holding is `signatory admin, owner`, so the operator is not
        // a stakeholder and cannot see them; without this the settle fails
        // CONTRACT_NOT_FOUND on a counterparty's own collateral, exactly as
        // the pool settles did. Read as each batch's admin -- a signatory of
        // every holding it issued, wherever the owner is hosted.
        readAs: Array.from(new Set(adminEntries.map((e) => e.admin))),
        commandId: `mt-settle:${input.tradeCid}`,
        disclosure: adminEntries.flatMap((e) => e.disclosure as never),
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
          contractId: input.tradeCid,
          choice: "MatchedTrade_Settle",
          argument: {
            // `batchesByAdmin : Map.Map Party SettlementBatchV2` is a Daml
            // GenMap, whose JSON encoding is an ARRAY of [key, value] pairs.
            // An object encodes a TextMap, which this is not -- that is why
            // this choice had never once decoded. And SettlementBatchV2 is a
            // plain record (MatchedTrade.daml:73-77), not the vendored
            // upstream variant: no `tag`, and the field is `allocations` of
            // V2.FinalizedAllocation, not `allocationCids`.
            //
            // The encoding below is the one proven against the live
            // participant in scripts/testnet-v2registry-trade.ts.
            batchesByAdmin: adminEntries.map((e) => [
              e.admin,
              {
                allocations: e.batch.allocationCids.map((allocationCid) => ({
                  allocationCid,
                  extraTransferLegSides: [],
                  nextIterationFunding: null,
                })),
                factoryCid: e.factoryCid,
                extraArgs: e.extraArgs,
              },
            ]),
            allocationRequests: input.allocationRequestCids,
            dexPairCid: input.dexPairCid ?? null,
          },
        },
      }),
    );
  }

  async cancel(input: MatchedTradeCancelInput): Promise<unknown> {
    const adminEntries: Array<{
      disclosure: unknown[];
      allocationsToCancel: Array<
        [
          ContractId<"Allocation">,
          {
            context: { values: Record<string, unknown> };
            meta: { values: Record<string, unknown> };
          },
        ]
      >;
    }> = [];
    for (const [admin, allocationCids] of input.allocationsByAdmin) {
      const ctx = await this.choiceContext(admin);
      adminEntries.push({
        disclosure: ctx.disclosure,
        allocationsToCancel: allocationCids.map((cid) => [cid, ctx.extraArgs]),
      });
    }

    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        // Same reason as the settle: MatchedTrade_Cancel reaches
        // allocation_cancelImpl, which fetches each locked holding, archives
        // it and re-creates it unlocked.
        readAs: Array.from(new Set(input.allocationsByAdmin.keys())),
        commandId: `mt-cancel:${input.tradeCid}`,
        disclosure: adminEntries.flatMap((e) => e.disclosure as never),
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
          contractId: input.tradeCid,
          choice: "MatchedTrade_Cancel",
          argument: {
            allocationsToCancel: adminEntries.flatMap((e) => e.allocationsToCancel),
            allocationRequestCids: input.allocationRequestCids,
          },
        },
      }),
    );
  }
}
