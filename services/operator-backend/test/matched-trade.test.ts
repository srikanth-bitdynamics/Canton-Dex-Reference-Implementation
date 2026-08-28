import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RegistryClient } from "@canton-dex/registry-client";
import type {
  ChoiceArguments,
  ContractId,
  DisclosedContract,
  FactoryChoiceContextRef,
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
  readonly submissions: SubmitRequest[] = [];

  async submit<R>(req: SubmitRequest): Promise<R> {
    this.lastSubmit = req;
    this.submissions.push(req);
    const command = req.command as {
      choice?: string;
      argument?: {
        plansByAdmin?: Array<[
          Party,
          {
            transferLegs: V2TransferLeg[];
            allocations: unknown[];
          },
        ]>;
      };
    };
    if (command.choice === "MatchedTrade_PreviewSettlement") {
      return (command.argument?.plansByAdmin ?? []).map(([admin, plan]) => [
        admin,
        {
          settlement: {
            executors: ["operator"],
            id: `matched-trade:${admin}`,
            cid: null,
            meta: { values: {} },
          },
          transferLegs: plan.transferLegs,
          allocations: plan.allocations,
          actors: ["operator"],
          extraArgs: {
            context: { values: {} },
            meta: { values: {} },
          },
        },
      ]) as R;
    }
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
  readonly settlementLookups: Array<{
    admin: Party;
    choiceArguments: ChoiceArguments;
  }> = [];
  readonly cancelLookups: Array<{ admin: Party; allocationId: string }> = [];

  constructor() {
    super({ baseUrl: "http://stub" });
  }

  override async getSettlementFactory(
    admin: Party,
    choiceArguments: ChoiceArguments,
  ): Promise<FactoryChoiceContextRef> {
    this.settlementLookups.push({ admin, choiceArguments });
    return {
      factoryCid: `#settle:${admin}` as ContractId<"TokenStandardFactory">,
      context: { values: { [`ctx.${admin}`]: true } },
      disclosure: [
        disclosed(`factory-${admin}`),
        disclosed(`context-${admin}`),
      ],
    };
  }

  override async getAllocationCancelContext(
    admin: Party,
    allocationId: string,
  ) {
    this.cancelLookups.push({ admin, allocationId });
    return {
      context: { values: { [`ctx.${admin}.${allocationId}`]: true } },
      disclosure: [disclosed(`cancel-${admin}-${allocationId}`)],
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
    const registry = new ContextRegistry();
    const svc = new MatchedTradeService(
      ledger,
      registry,
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

    const preview = ledger.submissions.find(
      (s) => (s.command as { choice?: string }).choice === "MatchedTrade_PreviewSettlement",
    );
    assert.ok(preview, "settlement runs the on-ledger preview first");
    assert.deepEqual(
      registry.settlementLookups.map(({ admin }) => admin),
      ["adminA", "adminB"],
    );
    for (const { admin, choiceArguments } of registry.settlementLookups) {
      assert.equal(
        (choiceArguments.settlement as { id: string }).id,
        `matched-trade:${admin}`,
        "the exact preview result is sent to that admin's settlement endpoint",
      );
    }
    const disclosureBlobs = submit.disclosure!.map((d) => d.createdEventBlob);
    assert.deepEqual(new Set(disclosureBlobs), new Set([
      "factory-adminA",
      "context-adminA",
      "factory-adminB",
      "context-adminB",
    ]));
    assert.equal(disclosureBlobs.length, new Set(disclosureBlobs).size);
  });

  it("cancel threads the matching admin context for each allocation group", async () => {
    const ledger = new CapturingLedger();
    const registry = new ContextRegistry();
    const svc = new MatchedTradeService(
      ledger,
      registry,
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
      ["#a:0", { context: { values: { "ctx.adminA.#a:0": true } }, meta: { values: {} } }],
      ["#a:1", { context: { values: { "ctx.adminA.#a:1": true } }, meta: { values: {} } }],
      ["#b:0", { context: { values: { "ctx.adminB.#b:0": true } }, meta: { values: {} } }],
    ]);
    assert.deepEqual(registry.cancelLookups, [
      { admin: "adminA", allocationId: "#a:0" },
      { admin: "adminA", allocationId: "#a:1" },
      { admin: "adminB", allocationId: "#b:0" },
    ]);
    assert.deepEqual(
      new Set(submit.disclosure?.map((d) => d.createdEventBlob)),
      new Set([
        "cancel-adminA-#a:0",
        "cancel-adminA-#a:1",
        "cancel-adminB-#b:0",
      ]),
    );
  });
});
