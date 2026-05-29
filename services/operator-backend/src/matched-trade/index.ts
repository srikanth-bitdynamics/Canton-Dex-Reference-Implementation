// MatchedTrade flow.

import type { ContractId } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { LedgerSubmitter } from "../ledger/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import type { Party } from "../types.js";

const emptyExtraArgs = {
  context: { values: {} },
  meta: { values: {} },
};

export interface MatchedTradeRequestAllocationsInput {
  tradeCid: ContractId<"MatchedTrade">;
}

export interface MatchedTradeSettleInput {
  tradeCid: ContractId<"MatchedTrade">;
  batchesByAdmin: Map<Party, SettlementBatchV2>;
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
      disclosure: unknown[];
    }> = [];
    for (const [admin, batch] of input.batchesByAdmin) {
      const factories = await this.registry.getFactories(admin);
      adminEntries.push({
        admin,
        batch,
        factoryCid: factories.settlementFactoryCid,
        disclosure: factories.disclosure,
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
                  extraArgs: emptyExtraArgs,
                },
              ]),
            ),
            allocationRequests: input.allocationRequestCids,
          },
        },
      }),
    );
  }

  async cancel(
    tradeCid: ContractId<"MatchedTrade">,
    allocationCids: ContractId<"Allocation">[],
    requestCids: ContractId<"TradeAllocationRequest">[],
  ): Promise<unknown> {
    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `mt-cancel:${tradeCid}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
          contractId: tradeCid,
          choice: "MatchedTrade_Cancel",
          argument: {
            allocationsToCancel: allocationCids.map((cid) => [
              cid,
              emptyExtraArgs,
            ]),
            allocationRequestCids: requestCids,
          },
        },
      }),
    );
  }
}
