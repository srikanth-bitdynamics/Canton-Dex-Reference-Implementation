// Order service tests — focused on the bind() funding-request resolution,
// which has two paths: an explicit created cid (full-tree wallet) and
// operator-discovery from an updateId (updateId-only wallet, e.g. the CIP-0103
// SDK / PartyLayer). The choice math itself is re-validated on-ledger; the unit
// concern here is that bind addresses the right OrderFundingRequest contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OrderService } from "../src/order/index.js";
import type {
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
  LedgerEvent,
} from "../src/ledger/index.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ContractId } from "@canton-dex/registry-client";

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
}

const FUNDING_TEMPLATE =
  "abcdef:CantonDex.Dex.OrderFundingRequest:OrderFundingRequest";
const ALLOCATION_TEMPLATE = "abcdef:CantonDex.Registry.V2:Allocation";

// Records the last submitted command and serves a fixed transaction tree for
// operator-discovery.
class CapturingLedger implements LedgerSubmitter {
  lastSubmit: SubmitRequest | null = null;
  treeEvents: Array<{ contractId: string; templateId: string }> = [];
  async submit<R>(req: SubmitRequest): Promise<R> {
    this.lastSubmit = req;
    return { orderCid: "#order:0", allocationRequestCid: "#areq:0" } as R;
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
    return [];
  }
}

function commandOf(ledger: CapturingLedger): Record<string, unknown> {
  return ledger.lastSubmit?.command as unknown as Record<string, unknown>;
}

describe("OrderService.bind", () => {
  it("binds the explicit fundingRequestCid when provided", async () => {
    const ledger = new CapturingLedger();
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);

    await svc.bind({
      fundingRequestCid: "00abc" as ContractId<"OrderFundingRequest">,
      settlementRef: "ref-1",
    });

    const cmd = commandOf(ledger);
    assert.equal(cmd.kind, "exercise");
    assert.equal(cmd.choice, "OrderFundingRequest_Bind");
    assert.equal(cmd.contractId, "00abc");
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
