// Ledger stub modelling what OrderMatchExecution_Execute does on-ledger: the
// settle consumes both funding allocations and mints a next-iteration
// allocation only for a side whose committed budget outlives its spend, both
// orders are archived and rolled onto those allocations in the SAME
// transaction, and a SettledTrade records the fill.
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
  buyerCommittedFunding: Record<string, string>;
  sellerCommittedFunding: Record<string, string>;
}

export type CreateAndExerciseCommand = Extract<
  LedgerCommand,
  { kind: "createAndExercise" }
>;

interface LiveOrderRow {
  admin: Party;
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
  settledTradeCid: string;
}

/** What is left of a committed budget after a spend; null once exhausted. */
function residual(funding: Record<string, string>, spend: bigint): bigint | null {
  const committed = dec.parseDecimal(Object.values(funding)[0] ?? "0");
  const left = committed - spend;
  if (left < 0n) throw new Error("legs exceed locked backing");
  return left > 0n ? left : null;
}

export class MatchingLedger implements LedgerSubmitter {
  readonly submissions: SubmitRequest[] = [];
  readonly liveAllocations = new Set<string>();
  readonly liveOrders = new Map<string, LiveOrderRow>();
  readonly settledTrades: SettledTradeRow[] = [];
  private nextAllocation = 1;
  private nextOrder = 1;

  constructor(private readonly orders: Order[]) {
    for (const o of orders) {
      this.liveOrders.set(o.contractId, {
        admin: o.admin,
        remainingQty: dec.parseDecimal(o.remainingQty),
        allocationCid: o.allocationCid ?? null,
      });
      if (o.allocationCid) this.liveAllocations.add(o.allocationCid);
    }
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
    this.consume(arg.buyerAllocationCid);
    this.consume(arg.sellerAllocationCid);

    const qty = dec.parseDecimal(arg.match.fillQty);
    const quoteAmount = dec.mul(qty, dec.parseDecimal(arg.match.fillPrice));
    const buyerResidual = residual(arg.buyerCommittedFunding, quoteAmount);
    const sellerResidual = residual(arg.sellerCommittedFunding, qty);
    const buyerNextAllocationCid = buyerResidual === null ? null : this.mint();
    const sellerNextAllocationCid = sellerResidual === null ? null : this.mint();

    const buyRemainderCid = this.roll(
      arg.buyOrderCid, buy, qty, buyerResidual, buyerNextAllocationCid,
    );
    const sellRemainderCid = this.roll(
      arg.sellOrderCid, sell, qty, sellerResidual, sellerNextAllocationCid,
    );

    const settledTradeCid = `#settled:${this.settledTrades.length + 1}`;
    this.settledTrades.push({
      contractId: settledTradeCid,
      operator: arg.operator,
      admin: buy.admin,
      matchId: arg.matchId,
      settledAt: "2026-01-01T12:00:00Z",
      // Mirrors mkMatchTransferLegs: base delivery first, then quote payment.
      transferLegs: [
        {
          transferLegId: "base-delivery",
          sender: { owner: arg.match.sellerAccount.owner },
          receiver: { owner: arg.match.buyerAccount.owner },
          amount: dec.formatDecimal(qty),
          instrumentId: arg.match.baseInstrumentId,
        },
        {
          transferLegId: "quote-payment",
          sender: { owner: arg.match.buyerAccount.owner },
          receiver: { owner: arg.match.sellerAccount.owner },
          amount: dec.formatDecimal(quoteAmount),
          instrumentId: arg.match.quoteInstrumentId,
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

  private roll(
    orderCid: string,
    order: LiveOrderRow,
    filledQty: bigint,
    residualFunding: bigint | null,
    nextAllocationCid: string | null,
  ): string | null {
    this.liveOrders.delete(orderCid);
    const newRemaining = order.remainingQty - filledQty;
    if (residualFunding === null && nextAllocationCid === null) return null;
    if (residualFunding === null || nextAllocationCid === null) {
      throw new Error("residual funding and rolled-forward allocation disagree");
    }
    if (newRemaining <= 0n) {
      throw new Error("fully filled order must not roll funding forward");
    }
    const remainderCid = `#remainder:${this.nextOrder++}`;
    this.liveOrders.set(remainderCid, {
      admin: order.admin,
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
  }

  private mint(): string {
    const cid = `#alloc:next:${this.nextAllocation++}`;
    this.liveAllocations.add(cid);
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
      return this.orders as unknown as T[];
    }
    return [];
  }
}
