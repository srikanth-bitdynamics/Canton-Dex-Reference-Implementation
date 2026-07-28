// The legs a match submits must match the Daml TransferLeg record.
//
// The ledger types `argument` as unknown, so a wrong shape is not a compile
// error at the submission site — it is a rejected command that the route
// previously reported as 200.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { OrderService } from "../src/order/index.js";
import { InMemoryLedger } from "../src/ledger/in-memory.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef, ContractId } from "@canton-dex/registry-client";
import type { Order } from "../src/types.js";

class StubRegistry extends RegistryClient {
  constructor() { super({ baseUrl: "http://stub" }); }
  override async getFactories() {
    return {
      allocationFactoryCid: "#alloc:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "#settle:0" as ContractId<"SettlementFactory">,
      disclosure: [] as never[],
    };
  }
  override async getChoiceContext(): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: [] };
  }
}

// Captures the create argument instead of submitting it.
class CapturingLedger extends InMemoryLedger {
  captured: any[] = [];
  override async submit<R>(req: any): Promise<R> {
    this.captured.push(req.command);
    return "#trade:1" as R;
  }
  override async query<T>(f: any): Promise<T[]> {
    if (String(f.templateId).endsWith("Order:Order")) {
      const mk = (id: string, side: string, price: string): Order =>
        ({
          contractId: id, operator: "op", trader: side === "Bid" ? "alice" : "bob",
          admin: "ad", baseInstrumentId: "dBTC", quoteInstrumentId: "dUSD",
          side, limitPrice: price, quantity: "1.0000000000",
          remainingQty: "1.0000000000", status: "Funded",
        }) as unknown as Order;
      return [mk("#o:b", "Bid", "100.0000000000"), mk("#o:a", "Ask", "100.0000000000")] as T[];
    }
    return [];
  }
}

describe("match transfer legs", () => {
  it("are Account-shaped, carry a transferLegId, and put base first", async () => {
    const ledger = new CapturingLedger();
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);
    await svc.runMatching({
      baseInstrumentId: "dBTC", quoteInstrumentId: "dUSD",
      venue: "op" as never, admin: "ad" as never,
    });
    const create = ledger.captured.find((c) => c?.kind === "create");
    assert.ok(create, "no MatchedTrade create was submitted");
    const legs = create.argument.transferLegs;
    assert.equal(legs.length, 2);

    assert.equal(legs[0].transferLegId, "base-delivery", "base leg must come first");
    assert.equal(legs[1].transferLegId, "quote-payment");

    for (const leg of legs) {
      for (const side of ["sender", "receiver"] as const) {
        assert.equal(
          typeof leg[side], "object",
          `${side} must be an Account record, not a bare Party string`,
        );
        assert.ok("owner" in leg[side], `${side} is missing owner`);
        assert.ok("provider" in leg[side], `${side} is missing provider`);
        assert.ok("id" in leg[side], `${side} is missing id`);
      }
    }
    // base leg: seller delivers to buyer
    assert.equal(legs[0].sender.owner, "bob");
    assert.equal(legs[0].receiver.owner, "alice");
    assert.equal(legs[0].instrumentId, "dBTC");
    // quote leg: buyer pays the seller, price * qty at ledger scale
    assert.equal(legs[1].sender.owner, "alice");
    assert.equal(legs[1].amount, "100.0000000000");
  });

  it("agree with the field list the Daml declares", () => {
    const daml = readFileSync(
      join(import.meta.dirname, "..", "..", "..",
        "vendor/splice/token-standard/splice-api-token-allocation-v2/daml/Splice/Api/Token/AllocationV2.daml"),
      "utf8",
    );
    const body = daml.slice(daml.indexOf("data TransferLeg = TransferLeg with"));
    const required = [...body.slice(0, 600).matchAll(/^\s{4}(\w+)\s*:/gm)].map((m) => m[1]!);
    for (const f of ["transferLegId", "sender", "receiver", "amount", "instrumentId"]) {
      assert.ok(required.includes(f), `TransferLeg no longer declares ${f}`);
    }
  });
});
