import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OrderService } from "../src/order/index.js";
import type {
  LedgerCommand,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
  LedgerEvent,
} from "../src/ledger/index.js";
import type { Order } from "../src/types.js";
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

interface ExecuteArgument {
  match: { fillQty: string; fillPrice: string };
  buyerAllocationCid: string;
  sellerAllocationCid: string;
  buyerCommittedFunding: Record<string, string>;
  sellerCommittedFunding: Record<string, string>;
}

type ExerciseCommand = Extract<LedgerCommand, { kind: "exercise" }>;
type CreateAndExerciseCommand = Extract<LedgerCommand, { kind: "createAndExercise" }>;

// Serves an ACS of orders and models the two on-ledger effects the match flow
// depends on: OrderMatchExecution_Execute settles a batch that consumes both
// funding allocations and mints a next-iteration allocation only for a side
// whose committed budget outlives its spend, and Order_RecordPartialFill rolls
// a fresh cid forward on a partial fill or archives on a full one.
class MatchingLedger implements LedgerSubmitter {
  readonly submissions: SubmitRequest[] = [];
  /** Allocation cids that are still active. */
  readonly liveAllocations = new Set<string>();
  private readonly remaining = new Map<string, number>();
  private next = 1;

  constructor(private readonly orders: Order[]) {
    for (const o of orders) {
      this.remaining.set(o.contractId, Number(o.remainingQty));
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

  get fills(): ExerciseCommand[] {
    return this.commands.filter(
      (c): c is ExerciseCommand =>
        c.kind === "exercise" && c.choice === "Order_RecordPartialFill",
    );
  }

  async submit<R>(req: SubmitRequest): Promise<R> {
    this.submissions.push(req);
    const cmd = req.command;
    if (cmd.kind === "createAndExercise") {
      return this.settle(cmd.argument as ExecuteArgument) as R;
    }
    if (cmd.kind === "exercise") return this.recordFill(cmd) as R;
    throw new Error(`unexpected ${cmd.kind}`);
  }

  private settle(arg: ExecuteArgument): {
    buyerNextAllocationCid: string | null;
    sellerNextAllocationCid: string | null;
  } {
    const consume = (cid: string): void => {
      if (!this.liveAllocations.delete(cid)) {
        throw new Error(`allocation is not live: ${cid}`);
      }
    };
    consume(arg.buyerAllocationCid);
    consume(arg.sellerAllocationCid);
    const fillQty = Number(arg.match.fillQty);
    const rollForward = (
      funding: Record<string, string>,
      spend: number,
    ): string | null => {
      const committed = Number(Object.values(funding)[0] ?? 0);
      if (committed - spend <= 0) return null;
      const cid = `#alloc:next:${this.next++}`;
      this.liveAllocations.add(cid);
      return cid;
    };
    return {
      buyerNextAllocationCid: rollForward(
        arg.buyerCommittedFunding,
        Number(arg.match.fillPrice) * fillQty,
      ),
      sellerNextAllocationCid: rollForward(arg.sellerCommittedFunding, fillQty),
    };
  }

  private recordFill(cmd: ExerciseCommand): string | null {
    const rem = this.remaining.get(cmd.contractId);
    if (rem === undefined) throw new Error(`archived: ${cmd.contractId}`);
    const filled = Number((cmd.argument as { filledQty: string }).filledQty);
    this.remaining.delete(cmd.contractId);
    if (rem - filled <= 0) return null;
    const cid = `#remainder:${this.next++}`;
    this.remaining.set(cid, rem - filled);
    return cid;
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
  it("settles the match in one submission of the atomic choice", async () => {
    const ledger = new MatchingLedger([ask({}), bid({})]);

    const results = await service(ledger).runMatching(RUN);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.error, undefined);
    // One settlement, not a create-the-trade / request-allocations /
    // settle-the-batch sequence.
    assert.equal(ledger.executes.length, 1);
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
    // The settle comes first: a fill recorded against a settlement that never
    // committed would shrink the order with nothing behind it.
    assert.equal(ledger.commands[0]!.kind, "createAndExercise");
    assert.deepEqual(
      ledger.fills.map((c) => c.contractId),
      ["#bid:1", "#ask:1"],
    );
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
    for (const fill of ledger.fills) {
      const { newAllocationCid } = fill.argument as {
        newAllocationCid: string | null;
      };
      assert.equal(
        newAllocationCid,
        null,
        "a full fill archives the order; carrying an allocation onto it strands the collateral",
      );
    }
  });

  it("carries the settle's remainder allocation, not the original", async () => {
    const ledger = new MatchingLedger([ask({}), bid({ remainingQty: "3" })]);

    const results = await service(ledger).runMatching(RUN);

    const bidFill = ledger.fills.find((c) => c.contractId === "#bid:1")!;
    const arg = bidFill.argument as {
      filledQty: string;
      newAllocationCid: string | null;
    };
    assert.equal(arg.filledQty, "1.0000000000");
    assert.notEqual(
      arg.newAllocationCid,
      "#alloc:bid",
      "the original allocation is consumed by the settle",
    );
    assert.ok(arg.newAllocationCid);
    assert.ok(ledger.liveAllocations.has(arg.newAllocationCid));
    assert.equal(results[0]!.buyRemainderCid, "#remainder:2");
    assert.equal(results[0]!.sellRemainderCid, null);
  });

  it("hands each side its locked budget as a funding TextMap", async () => {
    const ledger = new MatchingLedger([ask({}), bid({ remainingQty: "3" })]);

    await service(ledger).runMatching(RUN);

    const arg = ledger.executes[0]!.argument as ExecuteArgument;
    // The resting bid keeps the 3 @ 110 of quote placement locked; the ask
    // fills out entirely, so its budget is exactly the base it delivers.
    assert.equal(arg.buyerCommittedFunding.USDC, "330.0000000000");
    assert.equal(arg.sellerCommittedFunding.BTC, "1.0000000000");
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
    assert.equal(
      (ledger.executes[1]!.argument as { buyOrderCid: string }).buyOrderCid,
      "#remainder:2",
    );
    assert.notEqual(second.buyerAllocationCid, "#alloc:bid");
    assert.equal(second.sellerAllocationCid, "#alloc:ask2");
    // The buyer's residual budget carries the exact spend, not
    // remainingQty * limitPrice: the first fill cleared at 100, not 110.
    assert.equal(second.buyerCommittedFunding.USDC, "230.0000000000");
  });

  it("records no fill when the settlement fails", async () => {
    const ledger = new MatchingLedger([ask({}), bid({})]);
    const failing: LedgerSubmitter = {
      submit: async <R>(req: SubmitRequest): Promise<R> => {
        if (req.command.kind === "createAndExercise") {
          throw new Error("settle rejected");
        }
        return ledger.submit<R>(req);
      },
      subscribe: ledger.subscribe.bind(ledger),
      query: ledger.query.bind(ledger),
    };

    const results = await service(failing).runMatching(RUN);

    assert.match(results[0]!.error!, /settle rejected/);
    assert.equal(ledger.fills.length, 0);
    assert.deepEqual([...ledger.liveAllocations], ["#alloc:ask", "#alloc:bid"]);
  });
});
