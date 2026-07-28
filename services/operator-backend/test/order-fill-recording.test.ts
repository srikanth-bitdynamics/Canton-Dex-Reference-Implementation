import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OrderService } from "../src/order/index.js";
import type {
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
  LedgerEvent,
} from "../src/ledger/index.js";
import type { Order } from "../src/types.js";
import { RegistryClient } from "@canton-dex/registry-client";

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkOrder(o: Record<string, any>): Order {
  return {
    contractId: o.contractId,
    operator: "op",
    trader: o.trader,
    admin: "admin",
    baseInstrumentId: "BTC",
    quoteInstrumentId: "USDC",
    side: o.side,
    limitPrice: o.limitPrice,
    remainingQty: o.remainingQty,
    expiry: null,
    status: "Funded",
    allocationCid: o.allocationCid ?? null,
    settlementRef: { id: "DexOrder", cid: null },
    ledgerCreatedAt: o.ledgerCreatedAt ?? null,
  } as unknown as Order;
}

interface Exercised {
  contractId: string;
  choice: string;
  argument: Record<string, unknown>;
}

// Serves an ACS of orders and models Order_RecordPartialFill: a partial fill
// rolls a fresh cid forward, a full fill archives and returns None.
class MatchingLedger implements LedgerSubmitter {
  readonly exercised: Exercised[] = [];
  readonly created: string[] = [];
  private readonly remaining = new Map<string, number>();
  private next = 1;

  constructor(private readonly orders: Order[]) {
    for (const o of orders) {
      this.remaining.set(o.contractId, Number(o.remainingQty));
    }
  }

  async submit<R>(req: SubmitRequest): Promise<R> {
    const cmd = req.command;
    if (cmd.kind === "create") {
      const cid = `#trade:${this.next++}`;
      this.created.push(cid);
      return cid as R;
    }
    if (cmd.kind !== "exercise") throw new Error(`unexpected ${cmd.kind}`);
    this.exercised.push({
      contractId: cmd.contractId,
      choice: cmd.choice,
      argument: cmd.argument as Record<string, unknown>,
    });
    const rem = this.remaining.get(cmd.contractId);
    if (rem === undefined) throw new Error(`archived: ${cmd.contractId}`);
    const filled = Number((cmd.argument as { filledQty: string }).filledQty);
    this.remaining.delete(cmd.contractId);
    if (rem - filled <= 0) return null as R;
    const cid = `#remainder:${this.next++}`;
    this.remaining.set(cid, rem - filled);
    return cid as R;
  }

  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {
    // no streaming in this stub
  }

  async query<T>(_f: SubscriptionFilter): Promise<T[]> {
    return this.orders as unknown as T[];
  }
}

function service(ledger: LedgerSubmitter): OrderService {
  return new OrderService(ledger, new StubRegistry(), "op" as never);
}

const RUN = {
  baseInstrumentId: "BTC",
  quoteInstrumentId: "USDC",
  venue: "op" as never,
  admin: "admin" as never,
};

describe("OrderService.runMatching fill recording", () => {
  it("records the fill on both sides of a match", async () => {
    const ledger = new MatchingLedger([
      mkOrder({
        contractId: "#ask:1",
        trader: "bob",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        allocationCid: "#alloc:ask",
        ledgerCreatedAt: "2026-01-01T10:00:00Z",
      }),
      mkOrder({
        contractId: "#bid:1",
        trader: "alice",
        side: "Bid",
        limitPrice: "110",
        remainingQty: "1",
        allocationCid: "#alloc:bid",
        ledgerCreatedAt: "2026-01-01T11:00:00Z",
      }),
    ]);

    const results = await service(ledger).runMatching(RUN);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.error, undefined);
    assert.deepEqual(
      ledger.exercised.map((e) => [e.contractId, e.choice]),
      [
        ["#bid:1", "Order_RecordPartialFill"],
        ["#ask:1", "Order_RecordPartialFill"],
      ],
    );
    assert.equal(results[0]!.buyRemainderCid, null);
    assert.equal(results[0]!.sellRemainderCid, null);
  });

  it("carries the funding allocation onto the remainder order", async () => {
    const ledger = new MatchingLedger([
      mkOrder({
        contractId: "#ask:1",
        trader: "bob",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        allocationCid: "#alloc:ask",
        ledgerCreatedAt: "2026-01-01T10:00:00Z",
      }),
      mkOrder({
        contractId: "#bid:1",
        trader: "alice",
        side: "Bid",
        limitPrice: "110",
        remainingQty: "3",
        allocationCid: "#alloc:bid",
        ledgerCreatedAt: "2026-01-01T11:00:00Z",
      }),
    ]);

    const results = await service(ledger).runMatching(RUN);

    const bidFill = ledger.exercised.find((e) => e.contractId === "#bid:1")!;
    assert.equal(bidFill.argument.filledQty, "1.0000000000");
    assert.equal(bidFill.argument.newAllocationCid, "#alloc:bid");
    assert.equal(results[0]!.buyRemainderCid, "#remainder:2");
    assert.equal(results[0]!.sellRemainderCid, null);
  });

  it("fills the rolled-forward remainder, not the archived original", async () => {
    const ledger = new MatchingLedger([
      mkOrder({
        contractId: "#ask:1",
        trader: "bob",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        ledgerCreatedAt: "2026-01-01T10:00:00Z",
      }),
      mkOrder({
        contractId: "#ask:2",
        trader: "carol",
        side: "Ask",
        limitPrice: "101",
        remainingQty: "1",
        ledgerCreatedAt: "2026-01-01T10:30:00Z",
      }),
      mkOrder({
        contractId: "#bid:1",
        trader: "alice",
        side: "Bid",
        limitPrice: "110",
        remainingQty: "3",
        ledgerCreatedAt: "2026-01-01T11:00:00Z",
      }),
    ]);

    const results = await service(ledger).runMatching(RUN);

    assert.equal(results.length, 2);
    assert.equal(results[1]!.error, undefined);
    const bidFills = ledger.exercised
      .filter((e, i) => i % 2 === 0)
      .map((e) => e.contractId);
    assert.deepEqual(bidFills, ["#bid:1", "#remainder:2"]);
  });

  it("reports the fill failure while keeping the created trade", async () => {
    const ledger = new MatchingLedger([
      mkOrder({
        contractId: "#ask:1",
        trader: "bob",
        side: "Ask",
        limitPrice: "100",
        remainingQty: "1",
        ledgerCreatedAt: "2026-01-01T10:00:00Z",
      }),
      mkOrder({
        contractId: "#bid:1",
        trader: "alice",
        side: "Bid",
        limitPrice: "110",
        remainingQty: "1",
        ledgerCreatedAt: "2026-01-01T11:00:00Z",
      }),
    ]);
    const failing: LedgerSubmitter = {
      submit: async <R>(req: SubmitRequest): Promise<R> => {
        if (req.command.kind === "exercise") throw new Error("fill rejected");
        return ledger.submit<R>(req);
      },
      subscribe: ledger.subscribe.bind(ledger),
      query: ledger.query.bind(ledger),
    };

    const results = await service(failing).runMatching(RUN);

    assert.equal(results[0]!.matchedTradeCid, "#trade:1");
    assert.match(results[0]!.error!, /fill rejected/);
  });
});
