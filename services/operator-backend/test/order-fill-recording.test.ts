import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OrderService } from "../src/order/index.js";
import type { LedgerSubmitter, SubmitRequest } from "../src/ledger/index.js";
import type { Order } from "../src/types.js";
import { MatchingLedger, type ExecuteArgument } from "./matching-ledger.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef, ContractId } from "@canton-dex/registry-client";

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
  override async getFactories() {
    return {
      allocationFactoryCid: "#alloc-fac:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "#settle-fac:0" as ContractId<"SettlementFactory">,
      disclosure: [] as never[],
    };
  }
  override async getChoiceContext(): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: [] };
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

function service(ledger: LedgerSubmitter): OrderService {
  return new OrderService(ledger, new StubRegistry(), "op" as never);
}

const RUN = {
  baseInstrumentId: "BTC",
  quoteInstrumentId: "USDC",
  admin: "admin" as never,
};

const ask = (o: Record<string, unknown>): Order =>
  mkOrder({
    contractId: "#ask:1",
    trader: "bob",
    side: "Ask",
    limitPrice: "100",
    remainingQty: "1",
    allocationCid: "#alloc:ask",
    ledgerCreatedAt: "2026-01-01T10:00:00Z",
    ...o,
  });

const bid = (o: Record<string, unknown>): Order =>
  mkOrder({
    contractId: "#bid:1",
    trader: "alice",
    side: "Bid",
    limitPrice: "110",
    remainingQty: "1",
    allocationCid: "#alloc:bid",
    ledgerCreatedAt: "2026-01-01T11:00:00Z",
    ...o,
  });

describe("OrderService.runMatching settlement", () => {
  it("settles a match in exactly one submission", async () => {
    const ledger = new MatchingLedger([ask({}), bid({})]);

    const results = await service(ledger).runMatching(RUN);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.error, undefined);
    // The settle, both order roll-forwards and the trade record are one
    // transaction. A follow-up submission could fail on its own, and by then
    // the funds have moved and the allocations it named are archived.
    assert.equal(ledger.submissions.length, 1);
    assert.equal(
      ledger.executes[0]!.templateId,
      "CantonDex.Dex.OrderMatchExecution:OrderMatchExecution",
    );
    assert.equal(ledger.executes[0]!.choice, "OrderMatchExecution_Execute");
    assert.equal(
      ledger.commands.filter((c) => c.kind === "create").length,
      0,
      "the match must not create a MatchedTrade to be settled separately",
    );
  });

  it("cannot leave an order bound to an allocation the settle archived", async () => {
    const ledger = new MatchingLedger([ask({}), bid({ remainingQty: "3" })]);
    // Everything after the first submission fails. retryOnContention rethrows
    // every non-contention error, so a 503, a timeout or an expired token gets
    // here. If the match needs a second submission, the settle has already
    // moved the funds and the order is left pointing at an archived
    // allocation: Order_Cancel exercises that cid, so the trader can never
    // cancel, and every later match aborts inside the settle batch.
    const flaky: LedgerSubmitter = {
      submit: async <R>(req: SubmitRequest): Promise<R> => {
        if (ledger.submissions.length > 0) throw new Error("ledger unavailable");
        return ledger.submit<R>(req);
      },
      subscribe: ledger.subscribe.bind(ledger),
      query: ledger.query.bind(ledger),
    };

    const results = await service(flaky).runMatching(RUN);

    assert.deepEqual(ledger.orphanedOrders, []);
    assert.equal(results[0]!.error, undefined);
    assert.ok(ledger.liveOrders.has(results[0]!.buyRemainderCid!));
  });

  it("binds both orders' own allocations into the settle", async () => {
    const ledger = new MatchingLedger([ask({}), bid({})]);

    await service(ledger).runMatching(RUN);

    const arg = ledger.executes[0]!.argument as ExecuteArgument;
    assert.equal(arg.buyerAllocationCid, "#alloc:bid");
    assert.equal(arg.sellerAllocationCid, "#alloc:ask");
  });

  it("leaves no funding allocation behind on a full fill", async () => {
    // The bid crosses above the ask and the ask rests first, so the fill
    // clears at 100 while the buyer locked 110 — the price-improvement
    // surplus must be released by the settle, not left in an allocation
    // behind an order that this same fill archives.
    const ledger = new MatchingLedger([ask({}), bid({})]);

    const results = await service(ledger).runMatching(RUN);

    assert.equal(results[0]!.buyRemainderCid, null);
    assert.equal(results[0]!.sellRemainderCid, null);
    assert.deepEqual(
      [...ledger.liveAllocations],
      [],
      "a fully filled order leaves an allocation with no release path",
    );
    assert.deepEqual([...ledger.liveOrders.keys()], []);
  });

  it("carries the settle's remainder allocation, not the original", async () => {
    const ledger = new MatchingLedger([ask({}), bid({ remainingQty: "3" })]);

    const results = await service(ledger).runMatching(RUN);

    const remainderCid = results[0]!.buyRemainderCid!;
    const remainder = ledger.liveOrders.get(remainderCid)!;
    assert.notEqual(
      remainder.allocationCid,
      "#alloc:bid",
      "the original allocation is consumed by the settle",
    );
    assert.ok(ledger.liveAllocations.has(remainder.allocationCid!));
    assert.equal(remainder.remainingQty, 2n * 10n ** 10n);
    assert.equal(results[0]!.sellRemainderCid, null);
  });

  it("rolls forward the residual of the allocation's own budget", async () => {
    const ledger = new MatchingLedger([ask({}), bid({ remainingQty: "3" })]);

    const results = await service(ledger).runMatching(RUN);

    const arg = ledger.executes[0]!.argument as ExecuteArgument;
    // Nothing in the command declares a budget. The choice reads it off the
    // allocation, so no operator-side arithmetic can declare more than the
    // settle actually holds.
    assert.deepEqual(arg.buyerCommittedFunding, {});
    assert.deepEqual(arg.sellerCommittedFunding, {});
    // The bid's placement locked 3 @ 110; this fill cleared at 100, so 230 of
    // quote rolls on behind the remainder.
    const remainder = ledger.liveOrders.get(results[0]!.buyRemainderCid!)!;
    assert.deepEqual(ledger.backing(remainder.allocationCid!), {
      USDC: "230.0000000000",
    });
    // The ask filled out entirely: its whole base budget went into the leg.
    assert.equal(results[0]!.sellRemainderCid, null);
  });

  it("settles the rolled-forward order and allocation, not the archived ones", async () => {
    const ledger = new MatchingLedger([
      ask({}),
      ask({
        contractId: "#ask:2",
        trader: "carol",
        limitPrice: "101",
        allocationCid: "#alloc:ask2",
        ledgerCreatedAt: "2026-01-01T10:30:00Z",
      }),
      bid({ remainingQty: "3" }),
    ]);

    const results = await service(ledger).runMatching(RUN);

    assert.equal(results.length, 2);
    assert.equal(results[1]!.error, undefined);
    const second = ledger.executes[1]!.argument as ExecuteArgument;
    assert.equal(second.buyOrderCid, results[0]!.buyRemainderCid);
    assert.notEqual(second.buyerAllocationCid, "#alloc:bid");
    assert.equal(second.sellerAllocationCid, "#alloc:ask2");
    // Budgets follow the fills, not the face terms: 330 locked, less 100 at
    // the first fill's price and 101 at the second's, leaves 129 — where
    // remainingQty * limitPrice would claim 110.
    const remainder = ledger.liveOrders.get(results[1]!.buyRemainderCid!)!;
    assert.deepEqual(ledger.backing(remainder.allocationCid!), {
      USDC: "129.0000000000",
    });
  });

  it("closes out a remainder whose budget the fill exhausted", async () => {
    // Both the committed budget and the spend are 10dp round-half-even
    // products and collide here on a PARTIAL fill: 1000 @ 0.000001 commits
    // 0.0010000000, and filling 999.99996 of it spends 0.00099999996, which
    // rounds back up to the same 0.0010000000. 0.00004 base is unfilled with
    // no quote behind it, so nothing may roll forward — a remainder order
    // carrying a null allocation is matchable and aborts every later run.
    const ledger = new MatchingLedger([
      ask({ limitPrice: "0.000001", remainingQty: "999.99996" }),
      bid({ limitPrice: "0.000001", remainingQty: "1000" }),
    ]);

    assert.deepEqual(ledger.backing("#alloc:bid"), { USDC: "0.0010000000" });

    const results = await service(ledger).runMatching(RUN);

    assert.equal(results[0]!.error, undefined);
    assert.equal(results[0]!.quantity, "999.9999600000");
    assert.equal(results[0]!.buyRemainderCid, null);
    assert.deepEqual([...ledger.liveOrders.keys()], []);
    assert.deepEqual([...ledger.liveAllocations], []);
  });

  it("keeps filling a bid a previous run partially filled", async () => {
    // Placement locks round(10.5993913768 * 8.4875456707) = 89.9628183922 of
    // quote. A first fill of 4.2004910968 at the bid's own limit spends
    // 35.6518600235, so 54.3109583687 rolls forward — while
    // round(6.3989002800 * 8.4875456707) is 54.3109583688, one ulp MORE than
    // the settle holds. Both are 10dp round-half-even products of the same
    // terms, and they do not have to agree. A budget recomputed from the
    // order's face terms therefore claims more than the allocation locks, the
    // registry's coverage check rejects it, and the bid stops trading for
    // good: every later run pairs it and every one of those settles aborts.
    const limitPrice = "8.4875456707";
    const ledger = new MatchingLedger([
      bid({
        limitPrice,
        remainingQty: "10.5993913768",
        ledgerCreatedAt: "2026-01-01T09:00:00Z",
      }),
      ask({
        limitPrice,
        remainingQty: "4.2004910968",
        ledgerCreatedAt: "2026-01-01T10:00:00Z",
      }),
    ]);
    const svc = service(ledger);

    const first = await svc.runMatching(RUN);

    // The bid rests first, so the fill clears at the bid's own limit — where
    // the two roundings can part company.
    assert.equal(first[0]!.error, undefined);
    assert.equal(first[0]!.price, limitPrice);
    const remainderCid = first[0]!.buyRemainderCid!;
    const remainder = ledger.liveOrders.get(remainderCid)!;
    assert.equal(remainder.order.remainingQty, "6.3989002800");
    assert.deepEqual(ledger.backing(remainder.allocationCid!), {
      USDC: "54.3109583687",
    });

    // Next poll: a fresh ask crosses the remainder.
    ledger.rest(
      ask({
        contractId: "#ask:2",
        limitPrice,
        remainingQty: "1",
        allocationCid: "#alloc:ask2",
        ledgerCreatedAt: "2026-01-01T13:00:00Z",
      }),
    );

    const second = await svc.runMatching(RUN);

    assert.equal(second.length, 1);
    assert.equal(second[0]!.error, undefined);
    assert.equal(second[0]!.buyCid, remainderCid);
    assert.equal(second[0]!.price, limitPrice);
    // 54.3109583687 locked, less the 8.4875456707 this fill spends.
    const next = ledger.liveOrders.get(second[0]!.buyRemainderCid!)!;
    assert.deepEqual(ledger.backing(next.allocationCid!), {
      USDC: "45.8234126980",
    });
    assert.deepEqual(ledger.orphanedOrders, []);
  });

  it("skips a match against an order an earlier fill closed out", async () => {
    // The first fill spends the bid's whole budget with 0.00004 base still
    // unfilled, so the bid closes out. The match list was built from the book
    // as it stood at the start of the run and still pairs that bid with the
    // next ask; submitting it would name the contract id the fill archived.
    const ledger = new MatchingLedger([
      ask({
        limitPrice: "0.000001",
        remainingQty: "999.99996",
        allocationCid: "#alloc:ask1",
      }),
      ask({
        contractId: "#ask:2",
        limitPrice: "0.000001",
        remainingQty: "0.00004",
        allocationCid: "#alloc:ask2",
        ledgerCreatedAt: "2026-01-01T10:30:00Z",
      }),
      bid({ limitPrice: "0.000001", remainingQty: "1000" }),
    ]);

    const results = await service(ledger).runMatching(RUN);

    assert.equal(results[0]!.buyRemainderCid, null, "the bid did not close out");
    assert.equal(results.length, 1);
    assert.equal(ledger.submissions.length, 1);
    assert.deepEqual(
      ledger.executes.map((e) => (e.argument as ExecuteArgument).buyOrderCid),
      ["#bid:1"],
    );
    // The unmatched ask is untouched and still on the book for the next poll.
    assert.deepEqual([...ledger.liveOrders.keys()], ["#ask:2"]);
  });

  it("moves nothing when the settlement fails", async () => {
    const ledger = new MatchingLedger([ask({}), bid({})]);
    const failing: LedgerSubmitter = {
      submit: async <R>(_req: SubmitRequest): Promise<R> => {
        throw new Error("settle rejected");
      },
      subscribe: ledger.subscribe.bind(ledger),
      query: ledger.query.bind(ledger),
    };

    const results = await service(failing).runMatching(RUN);

    assert.match(results[0]!.error!, /settle rejected/);
    assert.deepEqual([...ledger.liveAllocations], ["#alloc:ask", "#alloc:bid"]);
    assert.deepEqual([...ledger.liveOrders.keys()], ["#ask:1", "#bid:1"]);
  });
});
