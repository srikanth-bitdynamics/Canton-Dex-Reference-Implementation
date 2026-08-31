// Order lifecycle: recover the trader-created intent, bind it to a pending
// order, attach the trader-authored funding allocation, then match or cancel.

import type { ContractId } from "@canton-dex/registry-client";
import type { RegistryDiscovery } from "@canton-dex/registry-client";

import { asChoiceContext, emptyExtraArgs } from "../ledger/choice-context.js";
import { mergeDisclosures } from "../ledger/disclosure.js";
import { LedgerSubmitter, type SubmitRequest } from "../ledger/index.js";
import {
  recoverCreatedAllocations,
  recoverCreatedFundingRequest,
} from "../ledger/recover.js";
import { discoverBatchesByAdmin } from "../settlement/index.js";
import { retryOnContention } from "../ledger/submit-with-retry.js";
import type {
  InstrumentId,
  Order,
  Party,
  V2Account,
  V2AllocationSpecification,
  V2SettlementInfo,
} from "../types.js";
import {
  aggregateBook,
  eqInstrument,
  matchOrdersForPair,
  type Match,
  type BookLevel,
} from "./matching.js";
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
  // One specification per distinct admin: the funding spec under the lock
  // admin, plus a receipt spec under the counter admin for a cross-admin pair.
  // A single-admin pair exposes one.
  allocationSpecs: V2AllocationSpecification[];
}

export interface OrderFundResult {
  orderCid: ContractId<"Order">;
  // The bound allocations keyed by admin (GenMap: array of [admin, cid] pairs).
  allocationCidsByAdmin: Array<[Party, ContractId<"Allocation">]>;
}

export interface OrderFundInput {
  orderCid: ContractId<"Order">;
  // The trader-authored funding allocations: one for a single-admin pair, two
  // (lock admin + counter admin) for a cross-admin pair. `Order_Fund` binds
  // each by matching its allocation view to the request's expected spec, so the
  // list order is immaterial. Omitted when `updateId` is given.
  allocationCids?: ContractId<"Allocation">[];
  // Legacy single-admin alias for `allocationCids`.
  allocationCid?: ContractId<"Allocation">;
  // Operator-discovery path (updateId-only wallet, e.g. PartyLayer): the order's
  // funding allocations are recovered from the transaction tree. The count is
  // derived from the order's pair admins (or `expectedAllocations`).
  updateId?: string | null;
  // Overrides the recovered-allocation count on the updateId path.
  expectedAllocations?: number;
  // The OrderAllocationRequest created at bind, when known and still live.
  // Optional: Order_Fund derives the expected specs from the order and archives
  // this request best-effort only if still live, so funding succeeds even when
  // the wallet already consumed it via standard acceptance.
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
  // The allocations each side's settle rolled forward, keyed by admin; empty
  // when the fill closed that side out. GenMap: array of [admin, cid] pairs.
  buyerNextAllocationCidsByAdmin: Array<[Party, ContractId<"Allocation">]>;
  sellerNextAllocationCidsByAdmin: Array<[Party, ContractId<"Allocation">]>;
  /** Order the side's remainder rolled forward to; null when it closed out. */
  buyRemainderCid: ContractId<"Order"> | null;
  sellRemainderCid: ContractId<"Order"> | null;
}

/** Where an order stands part-way through a matching run. */
interface LiveOrder {
  cid: ContractId<"Order">;
  allocationCidsByAdmin: Array<[Party, ContractId<"Allocation">]>;
}

function basicAccount(owner: Party): V2Account {
  return { owner, provider: null, id: "" };
}

// The distinct instrument admins an order's pair settles under: one when base
// and quote share a registry, two otherwise.
function pairAdmins(order: Order): Party[] {
  return order.baseInstrumentId.admin === order.quoteInstrumentId.admin
    ? [order.baseInstrumentId.admin]
    : [order.baseInstrumentId.admin, order.quoteInstrumentId.admin];
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
    if (!result.settlement || !result.allocationSpecs) {
      throw new Error("order bind: on-ledger result omitted funding terms");
    }
    return result;
  }

  async fund(input: OrderFundInput): Promise<OrderFundResult> {
    let allocationCids =
      input.allocationCids ??
      (input.allocationCid ? [input.allocationCid] : undefined);
    // The order is needed to authorize the caller and, on the updateId path, to
    // count the allocations the pair funds (one per distinct instrument admin).
    let order: Order | undefined;
    if (input.requireTrader !== undefined || (input.updateId && !allocationCids)) {
      order = (await this.listOpen()).find((row) => row.contractId === input.orderCid);
      if (!order) throw new Error(`Order ${input.orderCid} not found`);
    }
    if (input.requireTrader !== undefined && order!.trader !== input.requireTrader) {
      throw new OrderAuthError("caller may only fund its own order");
    }
    // Operator-discovery: recover the funding allocations from the tree when the
    // wallet returned only an updateId (e.g. PartyLayer).
    if (input.updateId) {
      const expected = input.expectedAllocations ?? (order ? pairAdmins(order).length : 1);
      const { allocationCids: recovered } = await recoverCreatedAllocations(
        this.ledger, this.operatorParty, input.updateId, expected,
      );
      allocationCids = recovered as ContractId<"Allocation">[];
    }
    if (!allocationCids || allocationCids.length === 0) {
      throw new Error("order fund: supply allocationCids or an updateId to recover them");
    }
    // Order_Fund derives the expected specs from the order itself and treats the
    // request cid as optional (archived best-effort only if still live), so
    // funding does not depend on a live request. On the operator-discovery path
    // the wallet accepted the request via standard acceptance, which already
    // archived it, so pass no cid; otherwise pass the caller's when known.
    const allocationRequestCid = input.updateId
      ? null
      : (input.allocationRequestCid ?? null);
    return retryOnContention(() =>
      this.ledger.submit<OrderFundResult>({
        actAs: [this.operatorParty],
        commandId: `order-fund:${input.orderCid}`,
        command: {
          kind: "exercise",
          templateId: "CantonDex.Dex.Order:Order",
          contractId: input.orderCid,
          choice: "Order_Fund",
          // Order_Fund binds each allocation by matching its view to the
          // order's per-admin spec, so the list is unkeyed.
          argument: {
            allocationCids,
            allocationRequestCid,
          },
        },
      }),
    );
  }

  async cancel(
    orderCid: ContractId<"Order">,
    requireTrader?: Party,
    allocationRequestCid?: ContractId<"OrderAllocationRequest"> | null,
  ): Promise<OrderCancelResult> {
    const order = (await this.listOpen()).find((o) => o.contractId === orderCid);
    if (!order) throw new Error(`Order ${orderCid} not found`);
    if (requireTrader !== undefined && order.trader !== requireTrader) {
      throw new OrderAuthError("caller may only cancel its own order");
    }
    // One cancel choice-context per allocation admin. Discovery is all-or-
    // nothing: a rejected context rejects the whole promise, so no allocation
    // is left half-released. A Pending order has no allocations and cancels
    // with an empty context map.
    const perAdmin = await Promise.all(
      order.allocationCidsByAdmin.map(async ([admin, allocationCid]) => {
        const discovered = await this.registry.getAllocationCancelContext(
          admin,
          allocationCid,
        );
        return { admin, ...asChoiceContext(discovered) };
      }),
    );
    const req: SubmitRequest = {
      actAs: [this.operatorParty],
      // Cancellation may release holdings visible only to the owner and
      // registry admin, so include each admin's choice context and disclosure.
      commandId: `order-cancel:${orderCid}`,
      disclosure: mergeDisclosures(...perAdmin.map((e) => e.disclosure)),
      command: {
        kind: "exercise",
        templateId: "CantonDex.Dex.Order:Order",
        contractId: orderCid,
        choice: "Order_Cancel",
        // GenMap: array of [admin, ExtraArgs] pairs.
        argument: { extraArgsByAdmin: perAdmin.map((e) => [e.admin, e.extraArgs]) },
      },
    };
    // The choice result carries holdings, not an update id, so it comes from
    // the driver where one is available.
    const result = await retryOnContention(async () => {
      const submitWithUpdateId = this.ledger.submitWithUpdateId;
      if (!submitWithUpdateId) {
        await this.ledger.submit<unknown>(req);
        return { updateId: null };
      }
      const { updateId } = await submitWithUpdateId.call(this.ledger, req);
      return { updateId };
    });
    // A Pending order cancelled during funding recovery leaves its
    // OrderAllocationRequest live (the wallet authored allocations without
    // accepting it). Withdraw it so the trader is not left with an
    // unfulfillable funding request. Best-effort: a wallet that accepted the
    // request via standard acceptance already archived it, so a
    // contract-not-found here is expected, not a failure of the cancel.
    if (allocationRequestCid) {
      try {
        await this.withdrawAllocationRequest(allocationRequestCid);
      } catch (e) {
        log.warn("funding-recovery withdraw skipped", {
          allocationRequestCid,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return result;
  }

  private async withdrawAllocationRequest(
    requestCid: ContractId<"OrderAllocationRequest">,
  ): Promise<void> {
    await retryOnContention(() =>
      this.ledger.submit({
        actAs: [this.operatorParty],
        commandId: `order-alloc-req-withdraw:${requestCid}`,
        command: {
          kind: "exerciseInterface",
          interfaceId:
            "#splice-api-token-allocation-request-v2:Splice.Api.Token.AllocationRequestV2:AllocationRequest",
          contractId: requestCid,
          choice: "AllocationRequest_Withdraw",
          argument: { actors: [this.operatorParty], extraArgs: emptyExtraArgs },
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
   * Discover crossing orders for the given pair. This is a pure read; the
   * operator submits selected results through OrderMatchExecution_Execute.
   */
  async findMatches(input: {
    baseInstrumentId: InstrumentId;
    quoteInstrumentId: InstrumentId;
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
    baseInstrumentId: InstrumentId;
    quoteInstrumentId: InstrumentId;
  }): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
    const orders = await this.listOpen();
    const forPair = orders.filter(
      (o) =>
        eqInstrument(o.baseInstrumentId, input.baseInstrumentId) &&
        eqInstrument(o.quoteInstrumentId, input.quoteInstrumentId),
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
    baseInstrumentId: InstrumentId;
    quoteInstrumentId: InstrumentId;
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
        allocationCidsByAdmin: o.allocationCidsByAdmin,
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
        if (buy.allocationCidsByAdmin.length === 0 || sell.allocationCidsByAdmin.length === 0) {
          throw new Error(`match ${matchId}: a matched order has no funding allocation`);
        }
        const executionArgument = {
          operator: this.operatorParty,
          matchId,
          match: {
            buyerAccount: basicAccount(m.buy.trader),
            sellerAccount: basicAccount(m.sell.trader),
            // MatchedOrderPair names each instrument by its bare text id; the
            // choice re-checks it against both orders' full InstrumentId.
            baseInstrumentId: m.buy.baseInstrumentId.id,
            quoteInstrumentId: m.buy.quoteInstrumentId.id,
            fillQty: m.quantity,
            fillPrice: m.price,
          },
          buyOrderCid: buy.cid,
          sellOrderCid: sell.cid,
          // GenMaps: array of [admin, cid] pairs. The choice verifies each
          // equals the order's own bound allocations.
          buyerAllocationCidsByAdmin: buy.allocationCidsByAdmin,
          sellerAllocationCidsByAdmin: sell.allocationCidsByAdmin,
        };
        const preview = await retryOnContention(() =>
          this.ledger.submit<Array<[Party, Record<string, unknown>]>>({
            actAs: [this.operatorParty],
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
        // Discover one settlement factory per instrument admin; the base and
        // quote legs of a cross-admin pair settle under two registries.
        const { batchesByAdmin, disclosure } = await discoverBatchesByAdmin(
          this.registry,
          preview,
        );
        const executed = await retryOnContention(() =>
          this.ledger.submit<OrderMatchExecuteResult>({
            actAs: [this.operatorParty],
            // No readAs on any instrument admin: every order allocation names
            // the operator as its settlement executor, so the operator already
            // sees them, and the merged registry disclosures cover each admin's
            // settlement factory.
            commandId: `order-match:${matchId}`,
            disclosure,
            command: {
              kind: "createAndExercise",
              templateId:
                "CantonDex.Dex.OrderMatchExecution:OrderMatchExecution",
              argument: executionArgument,
              choice: "OrderMatchExecution_Execute",
              choiceArgument: { batchesByAdmin },
            },
          }),
        );
        // The choice rolled both orders forward onto the allocations its own
        // settle minted, so the run only has to follow what it returned.
        const buyRemainderCid = executed.buyRemainderCid ?? null;
        advance(
          m.buy,
          buyRemainderCid && {
            cid: buyRemainderCid,
            allocationCidsByAdmin: executed.buyerNextAllocationCidsByAdmin ?? [],
          },
        );
        const sellRemainderCid = executed.sellRemainderCid ?? null;
        advance(
          m.sell,
          sellRemainderCid && {
            cid: sellRemainderCid,
            allocationCidsByAdmin: executed.sellerNextAllocationCidsByAdmin ?? [],
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
