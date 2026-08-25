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
import type { SettlementBatchV2 } from "../src/matched-trade/index.js";
import { groupLegsByAdmin } from "../src/settlement/index.js";
import type { V2TransferLeg } from "../src/types.js";
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

function leg(id: string, instrumentId: string): V2TransferLeg {
  return {
    transferLegId: id,
    sender: { owner: "alice" as Party, provider: null, id: "" },
    receiver: { owner: "bob" as Party, provider: null, id: "" },
    amount: "1.0",
    instrumentId,
    meta: {},
  };
}

describe("MatchedTradeService", () => {
  it("settle threads per-admin choice context and legs into each SettlementBatchV2", async () => {
    const ledger = new CapturingLedger();
    const svc = new MatchedTradeService(
      ledger,
      new ContextRegistry(),
      "operator" as Party,
    );

    // A trade spanning two registries: one leg per admin.
    const legA = leg("leg-a", "BTC");
    const legB = leg("leg-b", "LP");
    const legsByAdmin = groupLegsByAdmin([legA, legB], (l) =>
      (l.instrumentId === "BTC" ? "adminA" : "adminB") as Party,
    );

    await svc.settle({
      tradeCid: "#trade:0" as ContractId<"MatchedTrade">,
      // Accepted allocation requests have already been consumed. Settlement
      // binds to the resulting allocations, so there are no live request cids.
      allocationRequestCids: [],
      batchesByAdmin: new Map<Party, SettlementBatchV2>([
        [
          "adminA" as Party,
          {
            allocationCids: ["#a:0" as ContractId<"Allocation">],
            transferLegs: legsByAdmin.get("adminA" as Party)!,
          },
        ],
        [
          "adminB" as Party,
          {
            allocationCids: ["#b:0" as ContractId<"Allocation">],
            transferLegs: legsByAdmin.get("adminB" as Party)!,
          },
        ],
      ]),
    });

    assert.ok(ledger.lastSubmit, "settle submitted a command");
    const submit = ledger.lastSubmit!;
    const cmd = submit.command as {
      choice: string;
      argument: {
        // GenMap: an ARRAY of [key, value] pairs, not an object.
        batchesByAdmin: Array<[string, {
          transferLegs: V2TransferLeg[];
          allocations: Array<{
            allocationCid: string;
            extraTransferLegSides: unknown[];
            nextIterationFunding: unknown;
          }>;
          factoryCid: string;
          extraArgs: { context: { values: Record<string, unknown> } };
        }]>;
        allocationRequests: string[];
        dexPairCid: string | null;
      };
    };
    assert.equal(cmd.choice, "MatchedTrade_Settle");

    assert.ok(
      Array.isArray(cmd.argument.batchesByAdmin),
      "batchesByAdmin is a GenMap, encoded as an array of pairs",
    );
    const byAdmin = new Map(cmd.argument.batchesByAdmin);
    const adminABatch = byAdmin.get("adminA");
    const adminBBatch = byAdmin.get("adminB");
    assert.ok(adminABatch, "adminA batch is present");
    assert.ok(adminBBatch, "adminB batch is present");

    // SettlementBatchV2 is a plain record of FinalizedAllocation, not the
    // vendored upstream variant: no `tag`, and `allocations`, not
    // `allocationCids`.
    assert.equal(
      (adminABatch as unknown as { tag?: string }).tag,
      undefined,
      "no variant tag -- SettlementBatchV2 is a record",
    );
    assert.deepEqual(adminABatch!.allocations, [
      {
        allocationCid: "#a:0",
        extraTransferLegSides: [],
        nextIterationFunding: null,
      },
    ]);

    // Each batch carries only its own admin's legs. Handing a batch the whole
    // trade makes its allocations short of the other admin's legs, and the
    // registry rejects the settle on the coverage check.
    assert.deepEqual(adminABatch!.transferLegs, [legA]);
    assert.deepEqual(adminBBatch!.transferLegs, [legB]);

    // Required field on the choice; omitting it is a decode failure.
    assert.equal(cmd.argument.dexPairCid, null);
    assert.deepEqual(cmd.argument.allocationRequests, []);

    assert.deepEqual(adminABatch!.extraArgs.context.values, { "ctx.adminA": true });
    assert.deepEqual(adminBBatch!.extraArgs.context.values, { "ctx.adminB": true });
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
