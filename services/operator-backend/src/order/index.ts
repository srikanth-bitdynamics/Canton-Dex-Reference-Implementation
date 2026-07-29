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
  /** Null when the driver cannot report one. */
  updateId: string | null;
}

export interface MatchRunResult {
  buyCid: ContractId<"Order">;
  sellCid: ContractId<"Order">;
  quantity: string;
  price: string;
  /** Settlement reference this match settled under. */
  matchId: string;
  /** Order the remainder rolled forward to; null when the side filled fully. */
  buyRemainderCid?: ContractId<"Order"> | null;
  sellRemainderCid?: ContractId<"Order"> | null;
  error?: string;
}

/** Result of `OrderMatchExecution_Execute`. */
interface OrderMatchExecuteResult {
  /** Remainder allocation the settle rolled forward; null on a full fill. */
  buyerNextAllocationCid: ContractId<"Allocation"> | null;
  sellerNextAllocationCid: ContractId<"Allocation"> | null;
  /** Order the side's remainder rolled forward to; null when it closed out. */
  buyRemainderCid: ContractId<"Order"> | null;
  sellRemainderCid: ContractId<"Order"> | null;
}

/** Where an order stands part-way through a matching run. */
interface LiveOrder {
  cid: ContractId<"Order">;
  allocationCid: ContractId<"Allocation"> | null;
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
      // A funded cancel releases holdings that are `signatory admin, owner`,
      // which the operator cannot see. `order.admin` is the instrument's
      // registry admin, so the disclosure has to come from that registry's
      // choice context -- not yet served by registry-client.
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
    // The choice result carries holdings, not an update id, so it comes from
    // the driver where one is available.
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

  /**
   * Discover crossing orders for a pair and settle each one atomically via
   * `OrderMatchExecution_Execute`: a single submission that re-checks the fill
   * against both orders' own terms, builds the base/quote transfer legs, runs
   * the settle batch that consumes both funding allocations, rolls each order
   * onto the allocation that batch minted, and records the settled trade.
   *
   * One submission per match, so there is no window in which the funds have
   * moved but an order still points at the allocation the settle archived.
   *
   * Each match is settled independently; one failure doesn't abort the
   * rest of the run.
   */
  async runMatching(input: {
    baseInstrumentId: string;
    quoteInstrumentId: string;
    admin: Party;
  }): Promise<MatchRunResult[]> {
    const matches = await this.findMatches(input);
    if (matches.length === 0) return [];
    const [factories, ctx] = await Promise.all([
      this.registry.getFactories(input.admin),
      this.choiceContext(input.admin),
    ]);
    const out: MatchRunResult[] = [];
    // One order can fill against several counterparties in a single run, and
    // each fill archives it and consumes its allocation. Track what the
    // remainder rolled forward to so the next match targets the live contract
    // and the live allocation, not the archived ones.
    const live = new Map<string, LiveOrder>();
    // Orders a fill closed out. `matches` was computed against the book as it
    // stood at the start of the run, so it can still pair a closed-out order
    // with further counterparties; those submissions would name an archived
    // contract id and abort.
    const closed = new Set<string>();
    const stateOf = (o: Order): LiveOrder =>
      live.get(o.contractId) ?? {
        cid: o.contractId,
        allocationCid: o.allocationCid,
      };
    const advance = (o: Order, next: LiveOrder | null): void => {
      if (next) {
        live.set(o.contractId, next);
      } else {
        live.delete(o.contractId);
        closed.add(o.contractId);
      }
    };

    for (const m of matches) {
      if (closed.has(m.buy.contractId) || closed.has(m.sell.contractId)) continue;
      // Deterministic, replay-safe: derived from the matched order cids + the
      // cleared price/qty, NOT Date.now(), so a retry of the same match
      // collapses onto the cached submission rather than settling it twice.
      const matchId = `${m.buy.contractId.slice(0, 12)}:${m.sell.contractId.slice(0, 12)}:${m.price}:${m.quantity}`;
      try {
        const buy = stateOf(m.buy);
        const sell = stateOf(m.sell);
        if (!buy.allocationCid || !sell.allocationCid) {
          throw new Error(`match ${matchId}: a matched order has no funding allocation`);
        }
        const acct = (owner: Party): V2Account => ({
          owner,
          provider: null,
          id: "",
        });
        const executed = await retryOnContention(() =>
          this.ledger.submit<OrderMatchExecuteResult>({
            actAs: [this.operatorParty],
            // The settle fetches each order's funding allocation and the
            // holdings it locked -- `signatory admin, owner`, which the
            // operator is not a stakeholder of. readAs the instrument admin so
            // it can see them; without it the settle fails CONTRACT_NOT_FOUND
            // on the funding it is trying to move. Both orders share an admin
            // (asserted by the choice), so one entry covers both sides.
            readAs: [input.admin],
            commandId: `order-match:${matchId}`,
            // Factory + choice-context disclosure for the registry's own
            // contracts.
            disclosure: [...factories.disclosure, ...ctx.disclosure],
            command: {
              kind: "createAndExercise",
              templateId:
                "CantonDex.Dex.OrderMatchExecution:OrderMatchExecution",
              argument: {
                operator: this.operatorParty,
                matchId,
                match: {
                  buyerAccount: acct(m.buy.trader),
                  sellerAccount: acct(m.sell.trader),
                  baseInstrumentId: m.buy.baseInstrumentId,
                  quoteInstrumentId: m.buy.quoteInstrumentId,
                  fillQty: m.quantity,
                  fillPrice: m.price,
                },
                buyOrderCid: buy.cid,
                sellOrderCid: sell.cid,
                buyerAllocationCid: buy.allocationCid,
                sellerAllocationCid: sell.allocationCid,
                // Ignored by the choice, retained for upgrade compatibility.
                // The budget is read off each side's own allocation, so the
                // operator declares nothing here.
                buyerCommittedFunding: {},
                sellerCommittedFunding: {},
              },
              choice: "OrderMatchExecution_Execute",
              choiceArgument: {
                factoryCid: factories.settlementFactoryCid,
                extraArgs: ctx.extraArgs,
              },
            },
          }),
        );
        // The choice rolled both orders forward onto the allocations its own
        // settle minted, so the run only has to follow what it returned.
        const buyNext = executed.buyerNextAllocationCid ?? null;
        const buyRemainderCid = executed.buyRemainderCid ?? null;
        advance(
          m.buy,
          buyRemainderCid && { cid: buyRemainderCid, allocationCid: buyNext },
        );
        const sellNext = executed.sellerNextAllocationCid ?? null;
        const sellRemainderCid = executed.sellRemainderCid ?? null;
        advance(
          m.sell,
          sellRemainderCid && { cid: sellRemainderCid, allocationCid: sellNext },
        );
        out.push({
          buyCid: m.buy.contractId,
          sellCid: m.sell.contractId,
          quantity: m.quantity,
          price: m.price,
          matchId,
          buyRemainderCid,
          sellRemainderCid,
        });
      } catch (e) {
        out.push({
          buyCid: m.buy.contractId,
          sellCid: m.sell.contractId,
          quantity: m.quantity,
          price: m.price,
          matchId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return out;
  }
}
