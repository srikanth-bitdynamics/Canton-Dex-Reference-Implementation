import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RegistryClient } from "@canton-dex/registry-client";
import type {
  ChoiceContextRef,
  ContractId,
  DisclosedContract,
  FactoryRefs,
  Party,
} from "@canton-dex/registry-client";

import { MatchedTradeService } from "../src/matched-trade/index.js";
import type {
  LedgerEvent,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
} from "../src/ledger/index.js";

class CapturingLedger implements LedgerSubmitter {
  lastSubmit: SubmitRequest | null = null;

  async submit<R>(req: SubmitRequest): Promise<R> {
    this.lastSubmit = req;
    return "#result:0" as R;
  }

  async *subscribe<T>(_filter: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {
    // no streaming in this stub
  }

  async query<T>(_filter: SubscriptionFilter): Promise<T[]> {
    return [];
  }
}

function disclosed(tag: string): DisclosedContract {
  return {
    contractId: `#${tag}`,
    templateId: `Template:${tag}`,
    createdEventBlob: tag,
  };
}

class ContextRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }

  override async getFactories(admin: Party): Promise<FactoryRefs> {
    return {
      allocationFactoryCid: `#alloc:${admin}` as ContractId<"AllocationFactory">,
      settlementFactoryCid: `#settle:${admin}` as ContractId<"SettlementFactory">,
      disclosure: [disclosed(`factory-${admin}`)],
    };
  }

  override async getChoiceContext(admin: Party): Promise<ChoiceContextRef> {
    return {
      context: { values: { [`ctx.${admin}`]: true } },
      disclosure: [disclosed(`context-${admin}`)],
    };
  }
}

describe("MatchedTradeService", () => {
  it("settle threads per-admin choice context into each SettlementBatchV2", async () => {
    const ledger = new CapturingLedger();
    const svc = new MatchedTradeService(
      ledger,
      new ContextRegistry(),
      "operator" as Party,
    );

    await svc.settle({
      tradeCid: "#trade:0" as ContractId<"MatchedTrade">,
      allocationRequestCids: ["#req:0" as ContractId<"TradeAllocationRequest">],
      batchesByAdmin: new Map<Party, { allocationCids: ContractId<"Allocation">[] }>([
        ["adminA" as Party, { allocationCids: ["#a:0" as ContractId<"Allocation">] }],
        ["adminB" as Party, { allocationCids: ["#b:0" as ContractId<"Allocation">] }],
      ]),
    });

    assert.ok(ledger.lastSubmit, "settle submitted a command");
    const submit = ledger.lastSubmit!;
    const cmd = submit.command as {
      choice: string;
      argument: {
        batchesByAdmin: Record<string, { factoryCid: string; extraArgs: { context: { values: Record<string, unknown> } } }>;
      };
    };
    assert.equal(cmd.choice, "MatchedTrade_Settle");
    const adminABatch = cmd.argument.batchesByAdmin.adminA;
    const adminBBatch = cmd.argument.batchesByAdmin.adminB;
    assert.ok(adminABatch, "adminA batch is present");
    assert.ok(adminBBatch, "adminB batch is present");
    assert.deepEqual(adminABatch.extraArgs.context.values, { "ctx.adminA": true });
    assert.deepEqual(adminBBatch.extraArgs.context.values, { "ctx.adminB": true });
    assert.deepEqual(
      submit.disclosure?.map((d) => d.createdEventBlob),
      ["factory-adminA", "context-adminA", "factory-adminB", "context-adminB"],
    );
  });

  it("cancel threads the matching admin context for each allocation group", async () => {
    const ledger = new CapturingLedger();
    const svc = new MatchedTradeService(
      ledger,
      new ContextRegistry(),
      "operator" as Party,
    );

    await svc.cancel({
      tradeCid: "#trade:0" as ContractId<"MatchedTrade">,
      allocationRequestCids: ["#req:0" as ContractId<"TradeAllocationRequest">],
      allocationsByAdmin: new Map<Party, ContractId<"Allocation">[]>([
        ["adminA" as Party, ["#a:0" as ContractId<"Allocation">, "#a:1" as ContractId<"Allocation">]],
        ["adminB" as Party, ["#b:0" as ContractId<"Allocation">]],
      ]),
    });

    assert.ok(ledger.lastSubmit, "cancel submitted a command");
    const submit = ledger.lastSubmit!;
    const cmd = submit.command as {
      choice: string;
      argument: {
        allocationsToCancel: Array<
          [string, { context: { values: Record<string, unknown> } }]
        >;
      };
    };
    assert.equal(cmd.choice, "MatchedTrade_Cancel");
    assert.deepEqual(cmd.argument.allocationsToCancel, [
      ["#a:0", { context: { values: { "ctx.adminA": true } }, meta: { values: {} } }],
      ["#a:1", { context: { values: { "ctx.adminA": true } }, meta: { values: {} } }],
      ["#b:0", { context: { values: { "ctx.adminB": true } }, meta: { values: {} } }],
    ]);
    assert.deepEqual(
      submit.disclosure?.map((d) => d.createdEventBlob),
      ["context-adminA", "context-adminB"],
    );
  });
});
