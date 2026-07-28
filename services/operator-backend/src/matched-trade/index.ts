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
   * Trade allocation requests to consume. Normally EMPTY: the settle archives
   * each as its first act, and a counterparty that funded via
   * AllocationRequest_Accept has already archived its own. Pass only cids that
   * are provably still active.
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
        // The settle archives holdings that are `signatory admin, owner`,
        // which the operator cannot see. `admin` is the instrument's registry
        // admin, so the disclosure has to come from that registry's
        // per-allocation choice context, not from readAs. Until
        // registry-client serves it, this needs a co-hosted registry.
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
        // Same visibility constraint as the settle.
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
