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
  allocationRequestCids: ContractId<"TradeAllocationRequest">[];
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
        commandId: `mt-settle:${input.tradeCid}`,
        disclosure: adminEntries.flatMap((e) => e.disclosure as never),
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
          contractId: input.tradeCid,
          choice: "MatchedTrade_Settle",
          argument: {
            batchesByAdmin: Object.fromEntries(
              adminEntries.map((e) => [
                e.admin,
                {
                  tag: "SettlementBatchV2",
                  allocationCids: e.batch.allocationCids,
                  factoryCid: e.factoryCid,
                  extraArgs: e.extraArgs,
                },
              ]),
            ),
            allocationRequests: input.allocationRequestCids,
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
