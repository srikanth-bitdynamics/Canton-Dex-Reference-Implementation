// Order flow. Same shape as RFQ; see RFQ comments for the worked example.

import type { ContractId } from "@canton-dex/registry-client";
import { RegistryClient } from "@canton-dex/registry-client";

import { fetchChoiceContext, type ChoiceContext } from "../ledger/choice-context.js";
import { LedgerSubmitter, type SubmitRequest } from "../ledger/index.js";
import {
  recoverCreatedAllocations,
  recoverCreatedFundingRequest,
} from "../ledger/recover.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import * as dec from "../pool/decimal.js";
import type { Order, Party, V2Account, V2TransferLeg } from "../types.js";
import { aggregateBook, matchOrdersForPair, type Match, type BookLevel } from "./matching.js";

export type { Match, BookLevel };

export interface OrderBindInput {
  // Explicit created cid (full-tree wallet path, e.g. token-standard); omitted
  // when `updateId` is given.
  fundingRequestCid?: ContractId<"OrderFundingRequest">;
  // Operator-discovery path (updateId-only wallet, e.g. CIP-0103 SDK /
  // PartyLayer): the funding request the wallet created is recovered from the
  // transaction tree.
  updateId?: string | null;
  settlementRef: string;
}

export interface OrderBindResult {
  orderCid: ContractId<"Order">;
  allocationRequestCid: ContractId<"OrderAllocationRequest">;
}

export interface OrderFundInput {
  orderCid: ContractId<"Order">;
  // Explicit created cid (dApp-return path); omitted when `updateId` is given.
  allocationCid?: ContractId<"Allocation">;
  // Operator-discovery path (updateId-only wallet, e.g. PartyLayer): the order's
  // single funding allocation is recovered from the transaction tree.
  updateId?: string | null;
  // The OrderAllocationRequest created at bind. Passed to Order_Fund so it is
  // consumed when the order is funded (the wallet no longer accepts it), instead
  // of lingering as a stale funding request.
  allocationRequestCid?: ContractId<"OrderAllocationRequest"> | null;
}

export interface OrderCancelResult {
  /**
   * Update id of the cancelling transaction, or null when the ledger driver
   * cannot report one (the in-memory ledger has no updates).
   */
  updateId: string | null;
}

export interface MatchRunResult {
  buyCid: ContractId<"Order">;
  sellCid: ContractId<"Order">;
  quantity: string;
  price: string;
  matchedTradeCid?: ContractId<"MatchedTrade">;
  /** Order the remainder rolled forward to; null when the side filled fully. */
  buyRemainderCid?: ContractId<"Order"> | null;
  sellRemainderCid?: ContractId<"Order"> | null;
  error?: string;
}

export interface OrderMatchInput {
  orderCid: ContractId<"Order">;
  matchTransferLegs: V2TransferLeg[];
  allowFutureIterations: boolean;
}

export class OrderService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly registry: RegistryClient,
    private readonly operatorParty: Party,
  ) {}

  private choiceContext(admin: Party): Promise<ChoiceContext> {
    return fetchChoiceContext(this.registry, admin);
  }

  async bind(input: OrderBindInput): Promise<OrderBindResult> {
    // Operator-discovery: recover the OrderFundingRequest the wallet created
    // when it returned only an updateId (CIP-0103 SDK / PartyLayer). Mirrors
    // fund()'s allocation recovery — without this, an updateId-only wallet's
    // place-order fails downstream because the updateId is passed where a
    // contract id is expected ("cannot parse ContractId 1220...").
    let fundingRequestCid = input.fundingRequestCid;
    if (input.updateId) {
      fundingRequestCid = (await recoverCreatedFundingRequest(
        this.ledger,
        this.operatorParty,
        input.updateId,
      )) as ContractId<"OrderFundingRequest">;
    }
    if (!fundingRequestCid) {
      throw new Error(
        "order bind: supply fundingRequestCid or an updateId to recover it",
      );
    }
    return retryOnContention(() =>
      this.ledger.submit<OrderBindResult>({
        actAs: [this.operatorParty],
        commandId: `order-bind:${input.settlementRef}`,
        command: {
          kind: "exercise",
          templateId:
            "CantonDex.Dex.OrderFundingRequest:OrderFundingRequest",
          contractId: fundingRequestCid,
          choice: "OrderFundingRequest_Bind",
          argument: { settlementRef: input.settlementRef },
        },
      }),
    );
  }

  async fund(
    input: OrderFundInput,
  ): Promise<{ orderCid: ContractId<"Order"> }> {
    // Operator-discovery: recover the single funding allocation from the tree
    // when the wallet returned only an updateId (e.g. PartyLayer).
    let allocationCid = input.allocationCid;
    if (input.updateId) {
      const { allocationCids } = await recoverCreatedAllocations(
        this.ledger, this.operatorParty, input.updateId, 1,
      );
      allocationCid = allocationCids[0] as ContractId<"Allocation">;
    }
    if (!allocationCid) {
      throw new Error("order fund: supply allocationCid or an updateId to recover it");
    }
    return retryOnContention(() =>
      this.ledger.submit<{ orderCid: ContractId<"Order"> }>({
        actAs: [this.operatorParty],
        commandId: `order-fund:${input.orderCid}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Order:Order",
          contractId: input.orderCid,
          choice: "Order_Fund",
          // Optional Daml field: the cid as Some, or null for None.
          argument: {
            allocationCid,
            allocationRequestCid: input.allocationRequestCid ?? null,
          },
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

  async cancel(orderCid: ContractId<"Order">): Promise<OrderCancelResult> {
    const order = (await this.listOpen()).find((o) => o.contractId === orderCid);
    if (!order) throw new Error(`Order ${orderCid} not found`);
    const [factories, ctx] = await Promise.all([
      this.registry.getFactories(order.admin),
      this.choiceContext(order.admin),
    ]);
    const req: SubmitRequest = {
      actAs: [this.operatorParty],
      // Cancelling a FUNDED order releases the collateral holdings its
      // allocation locked, and a registry Holding is `signatory admin, owner`
      // -- the operator is not a stakeholder and cannot see it.
      //
      // Read as the ADMIN, not the trader: the admin is a signatory of every
      // holding it issued no matter where the owner is hosted, and the
      // backend's own token already reads the ACS as it.
      //
      // Conditional, because an UNFUNDED order has `allocationCid = None` and
      // Order_Cancel then fetches nothing at all. Attaching readAs there is
      // not merely useless -- `/v1/orders/:cid/cancel` is an unbound operator
      // route, so naming a party the token cannot read turns a cancel that
      // needs no visibility into a PERMISSION_DENIED. It also folds into the
      // `parties=` filter of the post-commit transaction-tree read
      // (json-api.ts), which would fail AFTER the cancel had committed.
      readAs: order.allocationCid ? [order.admin] : [],
      commandId: `order-cancel:${orderCid}`,
      disclosure: [...factories.disclosure, ...ctx.disclosure],
      command: {
        kind: "exercise",
        templateId: "CantonDex.Dex.Order:Order",
        contractId: orderCid,
        choice: "Order_Cancel",
        argument: { extraArgs: ctx.extraArgs },
      },
    };
    // Order_Cancel's own result carries the released holdings, not an update
    // id, so the updateId comes from the driver when it can report one (see
    // LedgerSubmitter.submitWithUpdateId). Callers that only need the effect
    // ignore it.
    return retryOnContention(async () => {
      const submitWithUpdateId = this.ledger.submitWithUpdateId;
      if (!submitWithUpdateId) {
        await this.ledger.submit<unknown>(req);
        return { updateId: null };
      }
      const { updateId } = await submitWithUpdateId.call(this.ledger, req);
      return { updateId };
    });
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

  /** Resolves to the remainder order's cid, or null on an exact full fill. */
  private recordFill(input: {
    orderCid: ContractId<"Order">;
    allocationCid: ContractId<"Allocation"> | null;
    filledQty: string;
  }): Promise<ContractId<"Order"> | null> {
    return retryOnContention(async () => {
      const remainder = await this.ledger.submit<ContractId<"Order"> | null>({
        actAs: [this.operatorParty],
        commandId: `order-fill:${input.orderCid}:${input.filledQty}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Order:Order",
          contractId: input.orderCid,
          choice: "Order_RecordPartialFill",
          argument: {
            filledQty: input.filledQty,
            // Carry the funding allocation onto the remainder; None would
            // leave the rolled-forward order unbacked and unmatchable.
            newAllocationCid: input.allocationCid,
          },
        },
      });
      return remainder ?? null;
    });
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
  }): Promise<MatchRunResult[]> {
    const matches = await this.findMatches(input);
    const out: MatchRunResult[] = [];
    // One order can fill against several counterparties in a single run, and
    // each fill archives it. Track the cid its remainder rolled forward to so
    // the next match exercises the live contract, not the archived one.
    const liveCid = new Map<string, ContractId<"Order">>();
    const cidOf = (o: Order): ContractId<"Order"> =>
      liveCid.get(o.contractId) ?? o.contractId;
    const setLive = (o: Order, remainder: ContractId<"Order"> | null): void => {
      if (remainder) liveCid.set(o.contractId, remainder);
      else liveCid.delete(o.contractId);
    };
    for (const m of matches) {
      let matchedTradeCid: ContractId<"MatchedTrade"> | undefined;
      try {
        // Quote-leg amount = price * quantity at 10dp, round-half-even, via
        // the BigInt decimal module so it agrees with the on-ledger Decimal
        // multiply to the last digit. Never IEEE-754 floats.
        const quoteAmount = dec.formatDecimal(
          dec.mul(dec.parseDecimal(m.price), dec.parseDecimal(m.quantity)),
        );
        // Mirrors mkMatchTransferLegs in OrderMatchExecution.daml: base
        // delivery first, then quote payment, each with a transferLegId and
        // Account-shaped parties. Typed, so a bare Party or a missing id is a
        // compile error rather than a rejected submission.
        const acct = (owner: Party): V2Account => ({
          owner,
          provider: null,
          id: "",
        });
        const transferLegs: V2TransferLeg[] = [
          {
            transferLegId: "base-delivery",
            sender: acct(m.sell.trader),
            receiver: acct(m.buy.trader),
            instrumentId: m.buy.baseInstrumentId,
            amount: m.quantity,
            meta: { values: {} } as never,
          },
          {
            transferLegId: "quote-payment",
            sender: acct(m.buy.trader),
            receiver: acct(m.sell.trader),
            instrumentId: m.buy.quoteInstrumentId,
            amount: quoteAmount,
            meta: { values: {} } as never,
          },
        ];
        // Deterministic, replay-safe commandId: derived once from
        // the matched order cids + the cleared price/qty, NOT Date.now(), so a
        // retry of the same match collapses onto the cached submission rather
        // than creating a duplicate MatchedTrade.
        const commandId = `match:${m.buy.contractId.slice(0, 12)}:${m.sell.contractId.slice(0, 12)}:${m.price}:${m.quantity}`;
        matchedTradeCid = await retryOnContention(() =>
          this.ledger.submit<ContractId<"MatchedTrade">>({
            actAs: [input.venue],
            commandId,
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
        // After the trade, not before: a fill recorded against a trade that
        // failed to create would shrink the order with nothing to settle it.
        const buyRemainderCid = await this.recordFill({
          orderCid: cidOf(m.buy),
          allocationCid: m.buy.allocationCid,
          filledQty: m.quantity,
        });
        setLive(m.buy, buyRemainderCid);
        const sellRemainderCid = await this.recordFill({
          orderCid: cidOf(m.sell),
          allocationCid: m.sell.allocationCid,
          filledQty: m.quantity,
        });
        setLive(m.sell, sellRemainderCid);
        out.push({
          buyCid: m.buy.contractId,
          sellCid: m.sell.contractId,
          quantity: m.quantity,
          price: m.price,
          matchedTradeCid,
          buyRemainderCid,
          sellRemainderCid,
        });
      } catch (e) {
        out.push({
          buyCid: m.buy.contractId,
          sellCid: m.sell.contractId,
          quantity: m.quantity,
          price: m.price,
          matchedTradeCid,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return out;
  }
}
