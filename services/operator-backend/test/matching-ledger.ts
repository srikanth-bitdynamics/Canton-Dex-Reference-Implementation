// Ledger stub modelling what OrderMatchExecution_Execute does on-ledger: the
// settle consumes both funding allocations and mints a next-iteration
// allocation only for a side whose reserved budget outlives its spend, both
// orders are archived and rolled onto those allocations in the SAME
// transaction, and a SettledTrade records the fill.
//
// The allocations carry their locked backing, so the registry's per-instrument
// coverage rule (`sent + next <= locked + received`, Registry/V2
// allocation_settleImpl) is enforced here too: a next-iteration funding above
// what the allocation holds aborts the whole execute, exactly as on-ledger.
//
// Amounts go through the project's 10dp round-half-even decimal module, never
// IEEE-754: the quote amount is a rounded Daml `Decimal`, and a double
// disagrees with it exactly where the residual budget collapses to nothing.

import * as dec from "../src/pool/decimal.js";
import type {
  LedgerCommand,
  LedgerEvent,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
} from "../src/ledger/index.js";
import type { Order, Party } from "../src/types.js";

export interface ExecuteArgument {
  operator: Party;
  matchId: string;
  match: {
    buyerAccount: { owner: Party };
    sellerAccount: { owner: Party };
    baseInstrumentId: string;
    quoteInstrumentId: string;
    fillQty: string;
    fillPrice: string;
  };
  buyOrderCid: string;
  sellOrderCid: string;
  buyerAllocationCid: string;
  sellerAllocationCid: string;
  /** Ignored, as on-ledger: the budget comes from the allocation. */
  buyerCommittedFunding: Record<string, string>;
  sellerCommittedFunding: Record<string, string>;
}

export type CreateAndExerciseCommand = Extract<
  LedgerCommand,
  { kind: "createAndExercise" }
>;

/** Instrument id -> scaled amount. */
type Funding = Map<string, bigint>;

interface LiveOrderRow {
  /** Current template payload, as the ACS would serve it. */
  order: Order;
  remainingQty: bigint;
  allocationCid: string | null;
}

interface LegRow {
  transferLegId: string;
  sender: { owner: Party };
  receiver: { owner: Party };
  amount: string;
  instrumentId: string;
}

export interface SettledTradeRow {
  contractId: string;
  operator: Party;
  admin: Party;
  matchId: string;
  settledAt: string;
  transferLegs: LegRow[];
}

interface ExecuteResult {
  buyerNextAllocationCid: string | null;
  sellerNextAllocationCid: string | null;
  buyRemainderCid: string | null;
  sellRemainderCid: string | null;
  settledTradeCid: string | null;
}

const SETTLED_AT = "2026-01-01T12:00:00Z";

function one(instrumentId: string, amount: bigint): Funding {
  return new Map([[instrumentId, amount]]);
}

export class MatchingLedger implements LedgerSubmitter {
  readonly submissions: SubmitRequest[] = [];
  readonly liveAllocations = new Set<string>();
  readonly liveOrders = new Map<string, LiveOrderRow>();
  readonly settledTrades: SettledTradeRow[] = [];
  /** Backing each live allocation locks, per instrument. */
  private readonly lockedBacking = new Map<string, Funding>();
  private nextAllocation = 1;
  private nextOrder = 1;

  constructor(orders: Order[]) {
    for (const o of orders) this.rest(o);
  }

  /**
   * Rest a funded order on the book, backed by the allocation its placement
   * locks: quote = remainingQty * limitPrice for a bid, base = remainingQty
   * for an ask (OrderFundingRequest_Bind's lock amount).
   */
  rest(o: Order): void {
    const qty = dec.parseDecimal(o.remainingQty);
    this.liveOrders.set(o.contractId, {
      order: o,
      remainingQty: qty,
      allocationCid: o.allocationCid ?? null,
    });
    if (!o.allocationCid) return;
    this.liveAllocations.add(o.allocationCid);
    this.lockedBacking.set(
      o.allocationCid,
      o.side === "Bid"
        ? one(o.quoteInstrumentId, dec.mul(qty, dec.parseDecimal(o.limitPrice)))
        : one(o.baseInstrumentId, qty),
    );
  }

  /** What an allocation locks, per instrument, as decimal strings. */
  backing(allocationCid: string): Record<string, string> {
    const funding = this.lockedBacking.get(allocationCid) ?? new Map<string, bigint>();
    return Object.fromEntries(
      [...funding].map(([iid, amount]) => [iid, dec.formatDecimal(amount)]),
    );
  }

  get commands(): LedgerCommand[] {
    return this.submissions.map((s) => s.command);
  }

  get executes(): CreateAndExerciseCommand[] {
    return this.commands.filter(
      (c): c is CreateAndExerciseCommand => c.kind === "createAndExercise",
    );
  }

  /** Live orders bound to an allocation that is no longer live. */
  get orphanedOrders(): string[] {
    return [...this.liveOrders]
      .filter(
        ([, o]) => o.allocationCid !== null && !this.liveAllocations.has(o.allocationCid),
      )
      .map(([cid]) => cid);
  }

  async submit<R>(req: SubmitRequest): Promise<R> {
    this.submissions.push(req);
    const cmd = req.command;
    if (cmd.kind !== "createAndExercise") {
      throw new Error(`unexpected ${cmd.kind} submission`);
    }
    return this.execute(cmd.argument as ExecuteArgument) as R;
  }

  private execute(arg: ExecuteArgument): ExecuteResult {
    const buy = this.orderOf(arg.buyOrderCid);
    const sell = this.orderOf(arg.sellOrderCid);
    if (buy.allocationCid !== arg.buyerAllocationCid) {
      throw new Error("buyer allocation is not the bid order's allocation");
    }
    if (sell.allocationCid !== arg.sellerAllocationCid) {
      throw new Error("seller allocation is not the ask order's allocation");
    }

    const { baseInstrumentId: base, quoteInstrumentId: quote } = arg.match;
    const qty = dec.parseDecimal(arg.match.fillQty);
    const quoteAmount = dec.mul(qty, dec.parseDecimal(arg.match.fillPrice));

    const buyerNext = this.remainder(
      arg.buyerAllocationCid, quote, quoteAmount, qty >= buy.remainingQty,
    );
    const sellerNext = this.remainder(
      arg.sellerAllocationCid, base, qty, qty >= sell.remainingQty,
    );
    const buyerNextAllocationCid = this.settle(
      arg.buyerAllocationCid, one(quote, quoteAmount), one(base, qty), buyerNext,
    );
    const sellerNextAllocationCid = this.settle(
      arg.sellerAllocationCid, one(base, qty), one(quote, quoteAmount), sellerNext,
    );

    const buyRemainderCid = this.roll(
      arg.buyOrderCid, buy, qty, buyerNextAllocationCid,
    );
    const sellRemainderCid = this.roll(
      arg.sellOrderCid, sell, qty, sellerNextAllocationCid,
    );

    const settledTradeCid = `#settled:${this.settledTrades.length + 1}`;
    this.settledTrades.push({
      contractId: settledTradeCid,
      operator: arg.operator,
      admin: buy.order.admin,
      matchId: arg.matchId,
      settledAt: SETTLED_AT,
      // Mirrors mkMatchTransferLegs: base delivery first, then quote payment.
      transferLegs: [
        {
          transferLegId: "base-delivery",
          sender: { owner: arg.match.sellerAccount.owner },
          receiver: { owner: arg.match.buyerAccount.owner },
          amount: dec.formatDecimal(qty),
          instrumentId: base,
        },
        {
          transferLegId: "quote-payment",
          sender: { owner: arg.match.buyerAccount.owner },
          receiver: { owner: arg.match.sellerAccount.owner },
          amount: dec.formatDecimal(quoteAmount),
          instrumentId: quote,
        },
      ],
    });

    return {
      buyerNextAllocationCid,
      sellerNextAllocationCid,
      buyRemainderCid,
      sellRemainderCid,
      settledTradeCid,
    };
  }

  /**
   * The next-iteration funding one side finalizes: the budget its allocation
   * reserved, less this fill's spend. The committed-funding fields on the
   * command play no part, as on-ledger. A side the fill closes out reserves
   * nothing, so its surplus is released.
   */
  private remainder(
    allocationCid: string,
    instrumentId: string,
    spend: bigint,
    closesOut: boolean,
  ): Funding | null {
    if (closesOut) return null;
    const budget = this.lockedBacking.get(allocationCid)?.get(instrumentId) ?? 0n;
    const left = budget - spend;
    return left > 0n ? one(instrumentId, left) : null;
  }

  /**
   * Allocation_Settle for one side: per instrument the registry requires
   * `sent + next <= locked + received`, then archives the allocation and
   * re-locks exactly the next-iteration funding behind the one it mints.
   */
  private settle(
    allocationCid: string,
    sent: Funding,
    received: Funding,
    next: Funding | null,
  ): string | null {
    const locked = this.lockedBacking.get(allocationCid) ?? new Map<string, bigint>();
    const needed = new Map(sent);
    for (const [iid, amount] of next ?? []) {
      needed.set(iid, (needed.get(iid) ?? 0n) + amount);
    }
    for (const [iid, amount] of needed) {
      const available = (locked.get(iid) ?? 0n) + (received.get(iid) ?? 0n);
      if (amount > available) {
        throw new Error(
          `legs + next-iteration funding exceed locked backing for ${iid}`,
        );
      }
    }
    this.consume(allocationCid);
    return next === null ? null : this.mint(next);
  }

  private roll(
    orderCid: string,
    row: LiveOrderRow,
    filledQty: bigint,
    nextAllocationCid: string | null,
  ): string | null {
    this.liveOrders.delete(orderCid);
    if (nextAllocationCid === null) return null;
    const newRemaining = row.remainingQty - filledQty;
    if (newRemaining <= 0n) {
      throw new Error("fully filled order must not roll funding forward");
    }
    const remainderCid = `#remainder:${this.nextOrder++}`;
    this.liveOrders.set(remainderCid, {
      order: {
        ...row.order,
        contractId: remainderCid as Order["contractId"],
        remainingQty: dec.formatDecimal(newRemaining),
        status: "PartiallyFilled",
        allocationCid: nextAllocationCid as Order["allocationCid"],
        // The remainder is created by the settling transaction, so it rests
        // from now — behind anything that was already on the book.
        ledgerCreatedAt: SETTLED_AT,
      },
      remainingQty: newRemaining,
      allocationCid: nextAllocationCid,
    });
    return remainderCid;
  }

  private orderOf(cid: string): LiveOrderRow {
    const row = this.liveOrders.get(cid);
    if (!row) throw new Error(`order is not active: ${cid}`);
    return row;
  }

  private consume(cid: string): void {
    if (!this.liveAllocations.delete(cid)) {
      throw new Error(`allocation is not live: ${cid}`);
    }
    this.lockedBacking.delete(cid);
  }

  private mint(funding: Funding): string {
    const cid = `#alloc:next:${this.nextAllocation++}`;
    this.liveAllocations.add(cid);
    this.lockedBacking.set(cid, funding);
    return cid;
  }

  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {
    // no streaming in this stub
  }

  async query<T>(f: SubscriptionFilter): Promise<T[]> {
    if (f.templateId === "CantonDex.Dex.MatchedTrade:SettledTrade") {
      return this.settledTrades as unknown as T[];
    }
    if (f.templateId === "CantonDex.Dex.Order:Order") {
      return [...this.liveOrders.values()].map((r) => r.order) as unknown as T[];
    }
    return [];
  }
}
