// Order flow. Same shape as RFQ; see RFQ comments for the worked example.

import type { ContractId } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { LedgerSubmitter } from "../ledger/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import type { Order, Party, V2TransferLeg } from "../types.js";
import { aggregateBook, matchOrdersForPair, type Match, type BookLevel } from "./matching.js";

export type { Match, BookLevel };

export interface OrderBindInput {
  fundingRequestCid: ContractId<"OrderFundingRequest">;
  settlementRef: string;
}

export interface OrderBindResult {
  orderCid: ContractId<"Order">;
  allocationRequestCid: ContractId<"OrderAllocationRequest">;
}

export interface OrderFundInput {
  orderCid: ContractId<"Order">;
  allocationCid: ContractId<"Allocation">;
}

export interface OrderMatchInput {
  orderCid: ContractId<"Order">;
  matchTransferLegs: V2TransferLeg[];
  allowFutureIterations: boolean;
}

export class OrderService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly _registry: RegistryClient,
    private readonly operatorParty: Party,
  ) {}

  async bind(input: OrderBindInput): Promise<OrderBindResult> {
    return retryOnContention(() =>
      this.ledger.submit<OrderBindResult>({
        actAs: [this.operatorParty],
        commandId: `order-bind:${input.settlementRef}`,
        command: {
          kind: "exercise",
          templateId:
            "CantonDex.Dex.OrderFundingRequest:OrderFundingRequest",
          contractId: input.fundingRequestCid,
          choice: "OrderFundingRequest_Bind",
          argument: { settlementRef: input.settlementRef },
        },
      }),
    );
  }

  async fund(
    input: OrderFundInput,
  ): Promise<{ orderCid: ContractId<"Order"> }> {
    return retryOnContention(() =>
      this.ledger.submit<{ orderCid: ContractId<"Order"> }>({
        actAs: [this.operatorParty],
        commandId: `order-fund:${input.orderCid}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Order:Order",
          contractId: input.orderCid,
          choice: "Order_Fund",
          argument: { allocationCid: input.allocationCid },
        },
      }),
    );
  }

  async adjust(
    input: OrderMatchInput,
  ): Promise<{ adjustedAllocationCid: ContractId<"Allocation"> }> {
    return retryOnContention(() =>
      this.ledger.submit<{ adjustedAllocationCid: ContractId<"Allocation"> }>({
        actAs: [this.operatorParty],
        commandId: `order-adjust:${input.orderCid}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Order:Order",
          contractId: input.orderCid,
          choice: "Order_Adjust",
          argument: {
            matchTransferLegs: input.matchTransferLegs,
            allowFutureIterations: input.allowFutureIterations,
          },
        },
      }),
    );
  }

  async cancel(orderCid: ContractId<"Order">): Promise<void> {
    await retryOnContention(() =>
      this.ledger.submit<unknown>({
        actAs: [this.operatorParty],
        commandId: `order-cancel:${orderCid}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Order:Order",
          contractId: orderCid,
          choice: "Order_Cancel",
          argument: {},
        },
      }),
    );
  }

  async listOpen(): Promise<Order[]> {
    const stripPrefix = (s: string): string => (s.startsWith("OS_") ? s.slice(3) : s);
    const rows = await this.ledger.query<Order>({
      templateId: "CantonDex.Dex.Order:Order",
      observingParty: this.operatorParty,
    });
    return rows.map((o) => ({
      ...o,
      status: stripPrefix(String(o.status)) as Order["status"],
    }));
  }

  /**
   * Discover crossing orders for the given pair. Pure read; the operator
   * is responsible for taking the returned matches and driving them
   * through the TradingAppV2 settlement pattern.
   */
  async findMatches(input: {
    baseInstrumentId: string;
    quoteInstrumentId: string;
  }): Promise<Match[]> {
    const orders = await this.listOpen();
    return matchOrdersForPair(orders, {
      base: input.baseInstrumentId,
      quote: input.quoteInstrumentId,
    });
  }

  /**
   * Aggregated order-book depth ladders for the given pair.
   */
  async book(input: {
    baseInstrumentId: string;
    quoteInstrumentId: string;
  }): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
    const orders = await this.listOpen();
    const forPair = orders.filter(
      (o) =>
        o.baseInstrumentId === input.baseInstrumentId &&
        o.quoteInstrumentId === input.quoteInstrumentId,
    );
    return aggregateBook(forPair);
  }

  /**
   * Discover crossing orders for a pair and create a `MatchedTrade`
   * contract per match. This is the bridge from the pure matcher (which
   * returns abstract pairs) to the on-ledger TradingAppV2 settlement
   * pattern. Each MatchedTrade then becomes a target for
   * `MatchedTrade_RequestAllocations` → trader-side allocation accept →
   * `MatchedTrade_Settle` via the MatchedTradeService.
   *
   * Each match is created independently; one failure doesn't abort the
   * rest of the run.
   */
  async runMatching(input: {
    baseInstrumentId: string;
    quoteInstrumentId: string;
    venue: Party;
    admin: Party;
  }): Promise<Array<{
    buyCid: ContractId<"Order">;
    sellCid: ContractId<"Order">;
    quantity: string;
    price: string;
    matchedTradeCid?: ContractId<"MatchedTrade">;
    error?: string;
  }>> {
    const matches = await this.findMatches(input);
    const out: Array<{
      buyCid: ContractId<"Order">;
      sellCid: ContractId<"Order">;
      quantity: string;
      price: string;
      matchedTradeCid?: ContractId<"MatchedTrade">;
      error?: string;
    }> = [];
    for (const m of matches) {
      try {
        const quoteAmount = (
          Number(m.price) * Number(m.quantity)
        ).toFixed(10);
        const transferLegs = [
          {
            sender: m.buy.trader,
            receiver: m.sell.trader,
            instrumentId: m.buy.quoteInstrumentId,
            amount: quoteAmount,
            meta: { values: {} },
          },
          {
            sender: m.sell.trader,
            receiver: m.buy.trader,
            instrumentId: m.buy.baseInstrumentId,
            amount: m.quantity,
            meta: { values: {} },
          },
        ];
        const tradeCid = await retryOnContention(() =>
          this.ledger.submit<ContractId<"MatchedTrade">>({
            actAs: [input.venue],
            commandId: `match-${m.buy.contractId.slice(0, 12)}-${m.sell.contractId.slice(0, 12)}-${Date.now()}`,
            command: {
              kind: "create",
              templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
              argument: {
                venue: input.venue,
                admin: input.admin,
                transferLegs,
                settlementDeadline: null,
                policyReceipt: null,
              },
            },
          }),
        );
        out.push({
          buyCid: m.buy.contractId,
          sellCid: m.sell.contractId,
          quantity: m.quantity,
          price: m.price,
          matchedTradeCid: tradeCid,
        });
      } catch (e) {
        out.push({
          buyCid: m.buy.contractId,
          sellCid: m.sell.contractId,
          quantity: m.quantity,
          price: m.price,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return out;
  }
}
