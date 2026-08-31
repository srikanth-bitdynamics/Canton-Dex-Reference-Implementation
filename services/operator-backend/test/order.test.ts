// Order service tests — focused on the bind() funding-request resolution,
// which has two paths: an explicit created cid (full-tree wallet) and
// operator-discovery from an updateId (updateId-only wallet, e.g. the CIP-0103
// SDK / PartyLayer). The choice math itself is re-validated on-ledger; the unit
// concern here is that bind addresses the right OrderFundingRequest contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OrderAuthError, OrderService } from "../src/order/index.js";
import type {
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
  LedgerEvent,
} from "../src/ledger/index.js";
import type { ContractId } from "@canton-dex/registry-client";
import { StubRegistry } from "./stub-registry.js";

const FUNDING_TEMPLATE =
  "abcdef:CantonDex.Dex.OrderFundingRequest:OrderFundingRequest";
const ALLOCATION_TEMPLATE = "abcdef:CantonDex.Registry.V2:Allocation";
const BIND_SETTLEMENT = {
  executors: ["op"],
  id: "DexOrderBook:admin:BTC:USDC",
  cid: null,
  meta: { values: {} },
};
const BIND_SPEC = {
  admin: "admin",
  authorizer: { owner: "trader", provider: null, id: "" },
  transferLegSides: [{
    transferLegId: "order-funding",
    side: "SenderSide",
    otherside: { owner: null, provider: null, id: "" },
    amount: "1.0",
    instrumentId: "USDC",
    meta: { values: {} },
  }],
  settlementDeadline: null,
  nextIterationFunding: null,
  committed: false,
  meta: { values: {} },
};

// Records the last submitted command and serves a fixed transaction tree for
// operator-discovery.
class CapturingLedger implements LedgerSubmitter {
  lastSubmit: SubmitRequest | null = null;
  treeEvents: Array<{ contractId: string; templateId: string }> = [];
  queryRows: unknown[] = [];
  // When set, the AllocationRequest_Withdraw submission throws, standing in for
  // an already-archived request.
  failWithdraw = false;
  async submit<R>(req: SubmitRequest): Promise<R> {
    this.lastSubmit = req;
    if (
      this.failWithdraw &&
      (req.command as { choice?: string }).choice === "AllocationRequest_Withdraw"
    ) {
      throw new Error("CONTRACT_NOT_FOUND: request already archived");
    }
    return {
      orderCid: "#order:0",
      allocationRequestCid: "#areq:0",
      settlement: BIND_SETTLEMENT,
      allocationSpecs: [BIND_SPEC],
    } as R;
  }
  async treeCreatedEvents() {
    return this.treeEvents;
  }
  async *subscribe<T>(
    _f: SubscriptionFilter,
  ): AsyncIterable<LedgerEvent<T>> {
    // no streaming in this stub
  }
  async query<T>(_f: SubscriptionFilter): Promise<T[]> {
    return this.queryRows as T[];
  }
}

function commandOf(ledger: CapturingLedger): Record<string, unknown> {
  return ledger.lastSubmit?.command as unknown as Record<string, unknown>;
}

describe("OrderService.bind", () => {
  it("binds the explicit fundingRequestCid when provided", async () => {
    const ledger = new CapturingLedger();
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);

    const result = await svc.bind({
      fundingRequestCid: "00abc" as ContractId<"OrderFundingRequest">,
      settlementRef: "ref-1",
    });

    const cmd = commandOf(ledger);
    assert.equal(cmd.kind, "exercise");
    assert.equal(cmd.choice, "OrderFundingRequest_Bind");
    assert.equal(cmd.contractId, "00abc");
    assert.deepEqual(result.settlement, BIND_SETTLEMENT);
    assert.deepEqual(result.allocationSpecs, [BIND_SPEC]);
  });

  it("recovers the OrderFundingRequest cid from an updateId (operator-discovery)", async () => {
    const ledger = new CapturingLedger();
    // The tree carries the created OrderFundingRequest plus unrelated creates
    // (e.g. an Allocation) that must be ignored.
    ledger.treeEvents = [
      { contractId: "00other", templateId: ALLOCATION_TEMPLATE },
      { contractId: "00deadbeef", templateId: FUNDING_TEMPLATE },
    ];
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);

    await svc.bind({ updateId: "1220cafe", settlementRef: "ref-2" });

    assert.equal(commandOf(ledger).contractId, "00deadbeef");
  });

  it("throws when neither a fundingRequestCid nor an updateId is supplied", async () => {
    const ledger = new CapturingLedger();
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);

    await assert.rejects(
      () => svc.bind({ settlementRef: "ref-3" }),
      /supply fundingRequestCid or an updateId/,
    );
  });

  it("throws when the updateId tree has no OrderFundingRequest create", async () => {
    const ledger = new CapturingLedger();
    ledger.treeEvents = [
      { contractId: "00other", templateId: ALLOCATION_TEMPLATE },
    ];
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);

    await assert.rejects(
      () => svc.bind({ updateId: "1220cafe", settlementRef: "ref-4" }),
      /expected 1 OrderFundingRequest create/,
    );
  });
});

describe("OrderService caller binding", () => {
  it("binds only the funding request owned by the verified caller", async () => {
    const ledger = new CapturingLedger();
    ledger.queryRows = [{ contractId: "00abc", trader: "alice" }];
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);

    await assert.rejects(
      () => svc.bind({
        fundingRequestCid: "00abc" as ContractId<"OrderFundingRequest">,
        settlementRef: "ref-auth",
        requireTrader: "mallory" as never,
      }),
      OrderAuthError,
    );
    assert.equal(ledger.lastSubmit, null);

    await svc.bind({
      fundingRequestCid: "00abc" as ContractId<"OrderFundingRequest">,
      settlementRef: "ref-auth",
      requireTrader: "alice" as never,
    });
    assert.equal(commandOf(ledger).contractId, "00abc");
  });

  it("fund and cancel reject another trader's order", async () => {
    const ledger = new CapturingLedger();
    ledger.queryRows = [{
      contractId: "00order",
      trader: "alice",
      status: "Pending",
      allocationCid: null,
    }];
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);

    await assert.rejects(
      () => svc.fund({
        orderCid: "00order" as ContractId<"Order">,
        allocationCid: "00alloc" as ContractId<"Allocation">,
        requireTrader: "mallory" as never,
      }),
      OrderAuthError,
    );
    await assert.rejects(
      () => svc.cancel("00order" as ContractId<"Order">, "mallory" as never),
      OrderAuthError,
    );
    assert.equal(ledger.lastSubmit, null);
  });
});

describe("OrderService.cancel", () => {
  it("withdraws the OrderAllocationRequest during funding recovery", async () => {
    const ledger = new CapturingLedger();
    ledger.queryRows = [{
      contractId: "00order",
      trader: "alice",
      status: "Pending",
      allocationCidsByAdmin: [],
    }];
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);

    await svc.cancel(
      "00order" as ContractId<"Order">,
      undefined,
      "00areq" as ContractId<"OrderAllocationRequest">,
    );

    const cmd = commandOf(ledger);
    assert.equal(cmd.kind, "exerciseInterface");
    assert.equal(cmd.choice, "AllocationRequest_Withdraw");
    assert.equal(cmd.contractId, "00areq");
  });

  it("tolerates an already-archived request during funding recovery", async () => {
    // A wallet that accepted the request via standard acceptance already
    // archived it, so the withdraw fails; the cancel must still resolve.
    const ledger = new CapturingLedger();
    ledger.failWithdraw = true;
    ledger.queryRows = [{
      contractId: "00order",
      trader: "alice",
      status: "Pending",
      allocationCidsByAdmin: [],
    }];
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);

    await assert.doesNotReject(
      svc.cancel(
        "00order" as ContractId<"Order">,
        undefined,
        "00areq" as ContractId<"OrderAllocationRequest">,
      ),
    );
    // The withdraw was attempted (its failure is swallowed).
    assert.equal(commandOf(ledger).choice, "AllocationRequest_Withdraw");
  });
});
