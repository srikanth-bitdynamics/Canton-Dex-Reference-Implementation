// The match a settlement submits must match the Daml MatchedOrderPair record,
// from which OrderMatchExecution builds the two transfer legs.
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

// Captures the submitted command instead of submitting it.
class CapturingLedger extends InMemoryLedger {
  captured: any[] = [];
  override async submit<R>(req: any): Promise<R> {
    this.captured.push(req.command);
    if (req.command.kind === "createAndExercise") {
      return {
        buyerNextAllocationCid: null,
        sellerNextAllocationCid: null,
      } as R;
    }
    return null as R;
  }
  override async query<T>(f: any): Promise<T[]> {
    if (String(f.templateId).endsWith("Order:Order")) {
      const mk = (id: string, side: string, price: string): Order =>
        ({
          contractId: id, operator: "op", trader: side === "Bid" ? "alice" : "bob",
          admin: "ad", baseInstrumentId: "dBTC", quoteInstrumentId: "dUSD",
          side, limitPrice: price, quantity: "1.0000000000",
          remainingQty: "1.0000000000", status: "Funded",
          allocationCid: side === "Bid" ? "#alloc:bid" : "#alloc:ask",
        }) as unknown as Order;
      return [mk("#o:b", "Bid", "100.0000000000"), mk("#o:a", "Ask", "100.0000000000")] as T[];
    }
    return [];
  }
}

describe("match execution argument", () => {
  it("carries an Account-shaped pair the settle factory can settle", async () => {
    const ledger = new CapturingLedger();
    const svc = new OrderService(ledger, new StubRegistry(), "op" as never);
    await svc.runMatching({
      baseInstrumentId: "dBTC", quoteInstrumentId: "dUSD", admin: "ad" as never,
    });
    const exec = ledger.captured.find((c) => c?.kind === "createAndExercise");
    assert.ok(exec, "no OrderMatchExecution was submitted");
    assert.equal(exec.choice, "OrderMatchExecution_Execute");
    assert.equal(exec.choiceArgument.factoryCid, "#settle:0");

    const match = exec.argument.match;
    for (const side of ["buyerAccount", "sellerAccount"] as const) {
      assert.equal(
        typeof match[side], "object",
        `${side} must be an Account record, not a bare Party string`,
      );
      assert.ok("owner" in match[side], `${side} is missing owner`);
      assert.ok("provider" in match[side], `${side} is missing provider`);
      assert.ok("id" in match[side], `${side} is missing id`);
    }
    // The buyer receives base and pays quote; the Daml derives both legs and
    // the quote amount from these, so the accounts must be the right way round.
    assert.equal(match.buyerAccount.owner, "alice");
    assert.equal(match.sellerAccount.owner, "bob");
    assert.equal(match.baseInstrumentId, "dBTC");
    assert.equal(match.quoteInstrumentId, "dUSD");
    assert.equal(match.fillQty, "1.0000000000");
    assert.equal(match.fillPrice, "100.0000000000");

    // The orders' own allocations, so the choice's binding check passes.
    assert.equal(exec.argument.buyerAllocationCid, "#alloc:bid");
    assert.equal(exec.argument.sellerAllocationCid, "#alloc:ask");
  });

  it("agrees with the field list the Daml declares", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const exec = readFileSync(
      join(root, "trading/CantonDex/Dex/OrderMatchExecution.daml"), "utf8",
    );
    const pair = exec.slice(exec.indexOf("data MatchedOrderPair = MatchedOrderPair with"));
    const declared = [...pair.slice(0, 400).matchAll(/^\s{4}(\w+)\s*:/gm)].map((m) => m[1]!);
    for (const f of [
      "buyerAccount", "sellerAccount", "baseInstrumentId",
      "quoteInstrumentId", "fillQty", "fillPrice",
    ]) {
      assert.ok(declared.includes(f), `MatchedOrderPair no longer declares ${f}`);
    }

    // The legs the choice builds from that pair.
    const daml = readFileSync(
      join(root,
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
