// Order flow. Same shape as RFQ; see RFQ comments for the worked example.

import type { ContractId } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { LedgerSubmitter } from "../ledger/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import type { Order, Party, V2TransferLeg } from "../types.js";

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
    return this.ledger.query<Order>({
      templateId: "CantonDex.Dex.Order:Order",
      observingParty: this.operatorParty,
    });
  }
}
