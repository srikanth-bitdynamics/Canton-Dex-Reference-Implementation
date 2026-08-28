// Order lifecycle: recover the trader-created intent, bind it to a pending
// order, attach the trader-authored funding allocation, then match or cancel.

import type { ContractId } from "@canton-dex/registry-client";
import type { RegistryDiscovery } from "@canton-dex/registry-client";

import { asChoiceContext } from "../ledger/choice-context.js";
import { mergeDisclosures } from "../ledger/disclosure.js";
import { LedgerSubmitter, type SubmitRequest } from "../ledger/index.js";
import {
  recoverCreatedAllocations,
  recoverCreatedFundingRequest,
} from "../ledger/recover.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import type {
  Order,
  Party,
  V2Account,
  V2AllocationSpecification,
  V2SettlementInfo,
} from "../types.js";
import { aggregateBook, matchOrdersForPair, type Match, type BookLevel } from "./matching.js";
import { rootLogger } from "../lib/logger.js";

const log = rootLogger.child({ component: "order" });

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
  /** Verified caller party when per-caller binding is enabled. */
  requireTrader?: Party;
}

export interface OrderBindResult {
  orderCid: ContractId<"Order">;
  allocationRequestCid: ContractId<"OrderAllocationRequest">;
  settlement: V2SettlementInfo;
  allocationSpec: V2AllocationSpecification;
}

export interface OrderFundInput {
  orderCid: ContractId<"Order">;
  // Explicit created cid (dApp-return path); omitted when `updateId` is given.
  allocationCid?: ContractId<"Allocation">;
  // Operator-discovery path (updateId-only wallet, e.g. PartyLayer): the order's
  // single funding allocation is recovered from the transaction tree.
  updateId?: string | null;
  // The OrderAllocationRequest created at bind. Order_Fund consumes it together
  // with the pending order after validating the allocation specification.
  allocationRequestCid?: ContractId<"OrderAllocationRequest"> | null;
  /** Verified caller party when per-caller binding is enabled. */
  requireTrader?: Party;
}

/** Thrown when a caller tries to mutate another trader's order workflow. */
export class OrderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderAuthError";
  }
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

function basicAccount(owner: Party): V2Account {
  return { owner, provider: null, id: "" };
}

export class OrderService {
  constructor(
    private readonly ledger: LedgerSubmitter,
    private readonly registry: RegistryDiscovery,
    private readonly operatorParty: Party,
  ) {}

  async bind(input: OrderBindInput): Promise<OrderBindResult> {
    // Recover the created request from the transaction tree when a wallet
    // returns an update id instead of contract ids.
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
    if (input.requireTrader !== undefined) {
      const requests = await this.ledger.query<{ contractId: string; trader: Party }>({
        templateId: "CantonDex.Dex.OrderFundingRequest:OrderFundingRequest",
        observingParty: this.operatorParty,
      });
      const request = requests.find((row) => row.contractId === fundingRequestCid);
      if (!request) throw new Error(`Order funding request ${fundingRequestCid} not found`);
      if (request.trader !== input.requireTrader) {
        throw new OrderAuthError("caller may only bind its own order request");
      }
    }
    const result = await retryOnContention(() =>
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
    if (!result.settlement || !result.allocationSpec) {
      throw new Error("order bind: on-ledger result omitted funding terms");
    }
    return result;
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
    if (input.requireTrader !== undefined) {
      const order = (await this.listOpen()).find((row) => row.contractId === input.orderCid);
      if (!order) throw new Error(`Order ${input.orderCid} not found`);
      if (order.trader !== input.requireTrader) {
        throw new OrderAuthError("caller may only fund its own order");
      }
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

  async cancel(
    orderCid: ContractId<"Order">,
    requireTrader?: Party,
  ): Promise<OrderCancelResult> {
    const order = (await this.listOpen()).find((o) => o.contractId === orderCid);
    if (!order) throw new Error(`Order ${orderCid} not found`);
    if (requireTrader !== undefined && order.trader !== requireTrader) {
      throw new OrderAuthError("caller may only cancel its own order");
    }
    const discovered = order.allocationCid
      ? await this.registry.getAllocationCancelContext(order.admin, order.allocationCid)
      : { context: { values: {} }, disclosure: [] };
    const ctx = asChoiceContext(discovered);
    const req: SubmitRequest = {
      actAs: [this.operatorParty],
      // Cancellation may release holdings visible only to the owner and
      // registry admin, so include the registry's choice context and disclosure.
      commandId: `order-cancel:${orderCid}`,
      disclosure: mergeDisclosures(ctx.disclosure),
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
   * Discover crossing orders for the given pair. This is a pure read; the
   * operator submits selected results through OrderMatchExecution_Execute.
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
   * `OrderMatchExecution_Execute`: one value-moving submission that re-checks the fill
   * against both orders' own terms, builds the base/quote transfer legs, runs
   * the settle batch that consumes both funding allocations, rolls each order
   * onto the allocation that batch minted, and records the settled trade.
   *
   * A read-only Daml preview first supplies the registry with the exact batch.
   * The subsequent execute still moves funds, rolls orders, and records the
   * trade atomically.
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
        const executionArgument = {
          operator: this.operatorParty,
          matchId,
          match: {
            buyerAccount: basicAccount(m.buy.trader),
            sellerAccount: basicAccount(m.sell.trader),
            baseInstrumentId: m.buy.baseInstrumentId,
            quoteInstrumentId: m.buy.quoteInstrumentId,
            fillQty: m.quantity,
            fillPrice: m.price,
          },
          buyOrderCid: buy.cid,
          sellOrderCid: sell.cid,
          buyerAllocationCid: buy.allocationCid,
          sellerAllocationCid: sell.allocationCid,
          buyerCommittedFunding: {},
          sellerCommittedFunding: {},
        };
        const settlementArguments = await retryOnContention(() =>
          this.ledger.submit<Record<string, unknown>>({
            actAs: [this.operatorParty],
            readAs: [input.admin],
            commandId: `order-match-preview:${matchId}`,
            command: {
              kind: "createAndExercise",
              templateId:
                "CantonDex.Dex.OrderMatchExecution:OrderMatchExecution",
              argument: executionArgument,
              choice: "OrderMatchExecution_PreviewSettlement",
              choiceArgument: {},
            },
          }),
        );
        const factory = await this.registry.getSettlementFactory(
          input.admin,
          settlementArguments,
        );
        const ctx = asChoiceContext(factory);
        const executed = await retryOnContention(() =>
          this.ledger.submit<OrderMatchExecuteResult>({
            actAs: [this.operatorParty],
            readAs: [input.admin],
            commandId: `order-match:${matchId}`,
            disclosure: ctx.disclosure,
            command: {
              kind: "createAndExercise",
              templateId:
                "CantonDex.Dex.OrderMatchExecution:OrderMatchExecution",
              argument: executionArgument,
              choice: "OrderMatchExecution_Execute",
              choiceArgument: {
                factoryCid: factory.factoryCid,
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
          buyRemainderCid && {
            cid: buyRemainderCid,
            allocationCid: buyNext,
          },
        );
        const sellNext = executed.sellerNextAllocationCid ?? null;
        const sellRemainderCid = executed.sellRemainderCid ?? null;
        advance(
          m.sell,
          sellRemainderCid && {
            cid: sellRemainderCid,
            allocationCid: sellNext,
          },
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
        const error = e instanceof Error ? e.message : String(e);
        // Operator-side only. The public receipt gets the error-code token; the
        // full text stays here for diagnosing why a discovered cross would not
        // settle.
        log.warn("match settlement failed", {
          matchId,
          buyCid: m.buy.contractId,
          sellCid: m.sell.contractId,
          error,
        });
        out.push({
          buyCid: m.buy.contractId,
          sellCid: m.sell.contractId,
          quantity: m.quantity,
          price: m.price,
          matchId,
          error,
        });
      }
    }
    return out;
  }
}
