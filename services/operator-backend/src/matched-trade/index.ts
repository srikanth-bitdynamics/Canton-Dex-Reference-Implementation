// MatchedTrade flow.

import type { ContractId, DisclosedContract } from "@canton-dex/registry-client";
import type { RegistryDiscovery } from "@canton-dex/registry-client";

import { asChoiceContext } from "../ledger/choice-context.js";
import { mergeDisclosures } from "../ledger/disclosure.js";
import { LedgerSubmitter } from "../ledger/index.js";
import { recoverCreatedAllocations } from "../ledger/recover.js";
import { discoverBatchesByAdmin } from "../settlement/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import type {
  Party,
  Time,
  V2AllocationSpecification,
  V2SettlementInfo,
  V2TransferLeg,
} from "../types.js";

export interface MatchedTradeRequestAllocationsInput {
  tradeCid: ContractId<"MatchedTrade">;
}

/** One non-venue authorizer's TradeAllocationRequest and its on-ledger view. */
export interface TradeAllocationRequestView {
  requestCid: ContractId<"TradeAllocationRequest">;
  settlement: V2SettlementInfo;
  requestedAt: Time;
  // One specification per admin the authorizer touches, so the wallet accepts
  // the request and authors every AllocationFactory_Allocate in one command.
  allocations: V2AllocationSpecification[];
}

export interface MatchedTradeSettleInput {
  tradeCid: ContractId<"MatchedTrade">;
  /**
   * The connected party's finalized allocation cids grouped by registry admin.
   * Omitted on the updateId path, where the operator recovers them from the
   * committed transaction tree and groups them by the trade's own admins.
   */
  batchesByAdmin?: Map<Party, SettlementBatchV2>;
  /**
   * Operator-discovery path (updateId-only wallet, e.g. PartyLayer): the
   * connected party's authored allocations are recovered from the tree, one per
   * admin, in the trade's admin order.
   */
  updateId?: string | null;
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

/**
 * The connected party's allocations for one admin. The trade is the source of
 * truth for which legs each admin owns, so a batch never carries its own legs.
 */
export interface SettlementBatchV2 {
  allocationCids: ContractId<"Allocation">[];
}

// Mirrors Daml `AllocationV2.FinalizedAllocation`: a created allocation cid the
// settle binds, with no extra sides or roll-forward funding.
interface FinalizedAllocation {
  allocationCid: ContractId<"Allocation">;
  extraTransferLegSides: never[];
  nextIterationFunding: null;
}

// On-ledger `MatchedTrade.TradeLeg`: the instrument admin travels alongside the
// transfer leg, whose own `instrumentId` is only the text id.
interface TradeLeg {
  admin: Party;
  leg: V2TransferLeg;
}

interface MatchedTradeContract {
  contractId: ContractId<"MatchedTrade">;
  venue: Party;
  tradeLegs?: TradeLeg[];
}

interface TradeAllocationRequestContract {
  contractId: ContractId<"TradeAllocationRequest">;
  settlement: V2SettlementInfo;
  settleAt: Time | null;
  requestedAt: Time;
  allocations: V2AllocationSpecification[];
}

function finalize(allocationCids: ContractId<"Allocation">[]): FinalizedAllocation[] {
  return allocationCids.map((allocationCid) => ({
    allocationCid,
    extraTransferLegSides: [],
    nextIterationFunding: null,
  }));
}

export class MatchedTradeService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly registry: RegistryDiscovery,
    private readonly operatorParty: Party,
  ) {}

  async requestAllocations(
    input: MatchedTradeRequestAllocationsInput,
  ): Promise<TradeAllocationRequestView[]> {
    const requestCids = await retryOnContention(() =>
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
    if (requestCids.length === 0) return [];
    // The operator is a settlement executor on each request, so it reads the
    // AllocationRequest view (settlement, requestedAt, allocation specs) the
    // wallet needs to accept the request and author its allocations.
    const requests = await this.ledger.query<TradeAllocationRequestContract>({
      templateId: "CantonDex.Dex.MatchedTrade:TradeAllocationRequest",
      observingParty: this.operatorParty,
    });
    const byCid = new Map(requests.map((r) => [r.contractId, r]));
    return requestCids.map((requestCid) => {
      const req = byCid.get(requestCid);
      if (!req) {
        throw new Error(`TradeAllocationRequest ${requestCid} not found after create`);
      }
      return {
        requestCid,
        settlement: req.settlement,
        requestedAt: req.requestedAt,
        allocations: req.allocations,
      };
    });
  }

  async settle(input: MatchedTradeSettleInput): Promise<unknown> {
    let batchesByAdmin = input.batchesByAdmin;
    if (input.updateId) {
      // The trade is the source of truth for its admins; the connected party
      // authors one allocation per admin it touches, created in the trade's
      // admin order, so the recovered cids line up with the sorted admins.
      const admins = await this.tradeAdmins(input.tradeCid);
      const { allocationCids } = await recoverCreatedAllocations(
        this.ledger,
        this.operatorParty,
        input.updateId,
        admins.length,
      );
      batchesByAdmin = new Map(
        admins.map((admin, i) => [
          admin,
          { allocationCids: [allocationCids[i]!] as ContractId<"Allocation">[] },
        ]),
      );
    }
    if (!batchesByAdmin) {
      throw new Error(
        "matched trade settle: supply allocationCidsByAdmin or an updateId to recover them",
      );
    }

    // Each admin's finalized allocations, keyed by admin (GenMap: array of
    // [key, value] pairs). Built once and threaded into both the preview and
    // the final settle so the registry context matches what settlement runs.
    const finalizedByAdmin: Array<[Party, FinalizedAllocation[]]> = [
      ...batchesByAdmin,
    ].map(([admin, batch]) => [admin, finalize(batch.allocationCids)]);

    // The trade derives each admin's legs on-ledger; the preview returns the
    // exact per-admin settlement arguments so each registry returns context for
    // what final settlement will exercise. The caller supplies only the
    // finalized allocations, which reference cids the trade cannot know.
    const preview = await retryOnContention(() =>
      this.ledger.submit<Array<[Party, Record<string, unknown>]>>({
        actAs: [this.operatorParty],
        commandId: `mt-settle-preview:${input.tradeCid}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
          contractId: input.tradeCid,
          choice: "MatchedTrade_PreviewSettlement",
          argument: { allocationsByAdmin: finalizedByAdmin },
        },
      }),
    );

    // One settlement factory per admin, discovered on the registry-returned
    // context alone (no readAs on any instrument admin) and merged into a
    // single transaction-wide disclosure set.
    const { batchesByAdmin: discovered, disclosure } = await discoverBatchesByAdmin(
      this.registry,
      preview,
    );
    const finalizedMap = new Map(finalizedByAdmin);

    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        // The settle archives holdings that are `signatory admin, owner`,
        // which the operator cannot see. `admin` is the instrument's registry
        // admin, so registry discovery supplies the transaction-wide
        // disclosures needed to validate every per-admin batch.
        commandId: `mt-settle:${input.tradeCid}`,
        disclosure,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
          contractId: input.tradeCid,
          choice: "MatchedTrade_Settle",
          argument: {
            // `batchesByAdmin : Map.Map Party SettlementBatchV2` is a Daml
            // GenMap, whose JSON encoding is an ARRAY of [key, value] pairs.
            // `SettlementBatchV2` is a plain record of `V2.FinalizedAllocation`
            // with no variant tag; it carries no legs, since the choice derives
            // them from the trade.
            batchesByAdmin: discovered.map(([admin, batch]) => [
              admin,
              {
                allocations: finalizedMap.get(admin) ?? [],
                factoryCid: batch.factoryCid,
                extraArgs: batch.extraArgs,
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
      disclosure: DisclosedContract[];
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
      const contexts = await Promise.all(
        allocationCids.map((cid) => this.registry.getAllocationCancelContext(admin, cid)),
      );
      adminEntries.push({
        disclosure: mergeDisclosures(...contexts.map((ctx) => ctx.disclosure)),
        allocationsToCancel: allocationCids.map((cid, index) => [
          cid,
          asChoiceContext(contexts[index]!).extraArgs,
        ]),
      });
    }

    return retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        // Same visibility constraint as the settle.
        commandId: `mt-cancel:${input.tradeCid}`,
        disclosure: mergeDisclosures(...adminEntries.map((e) => e.disclosure)),
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

  // The distinct instrument admins the trade settles under, in the same sorted
  // order the trade's own `Map Party` grouping (and each authorizer's specs)
  // use, so recovered allocations can be grouped without reading their payload.
  private async tradeAdmins(tradeCid: ContractId<"MatchedTrade">): Promise<Party[]> {
    const trades = await this.ledger.query<MatchedTradeContract>({
      templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
      observingParty: this.operatorParty,
    });
    const trade = trades.find((t) => t.contractId === tradeCid);
    if (!trade) throw new Error(`MatchedTrade ${tradeCid} not found`);
    const admins = [...new Set((trade.tradeLegs ?? []).map((tl) => tl.admin))].sort();
    if (admins.length === 0) throw new Error(`MatchedTrade ${tradeCid} has no legs`);
    return admins;
  }
}
