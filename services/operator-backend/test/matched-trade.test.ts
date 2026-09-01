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
import type {
  V2AllocationSpecification,
  V2SettlementInfo,
} from "../src/types.js";
import type {
  CreatedEventRef,
  LedgerEvent,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
} from "../src/ledger/index.js";

const ALLOCATION_TEMPLATE = "pkg:CantonDex.Registry.V2:Allocation";

class CapturingLedger implements LedgerSubmitter {
  lastSubmit: SubmitRequest | null = null;
  readonly submissions: SubmitRequest[] = [];
  // Configurable query results keyed by templateId, and tree recovery keyed by
  // updateId, so a test can supply the trade and its created allocations.
  queryResults: Record<string, unknown[]> = {};
  treeEvents: Record<string, CreatedEventRef[]> = {};
  requestAllocationsResult: string[] = [];

  async submit<R>(req: SubmitRequest): Promise<R> {
    this.lastSubmit = req;
    this.submissions.push(req);
    const command = req.command as {
      choice?: string;
      argument?: {
        allocationsByAdmin?: Array<[Party, unknown[]]>;
      };
    };
    if (command.choice === "MatchedTrade_RequestAllocations") {
      return this.requestAllocationsResult as R;
    }
    if (command.choice === "MatchedTrade_PreviewSettlement") {
      // The trade derives its own legs on-ledger; the preview echoes each
      // admin's finalized allocations back as that admin's settlement args.
      return (command.argument?.allocationsByAdmin ?? []).map(([admin, allocations]) => [
        admin,
        {
          settlement: {
            executors: ["operator"],
            id: `matched-trade:${admin}`,
            cid: null,
            meta: { values: {} },
          },
          transferLegs: [],
          allocations,
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

  async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    return (this.queryResults[filter.templateId ?? ""] ?? []) as T[];
  }

  async treeCreatedEvents(updateId: string, _party: Party): Promise<CreatedEventRef[]> {
    return this.treeEvents[updateId] ?? [];
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

const meta = { values: {} } as unknown as Record<string, string>;

function spec(admin: Party, instrumentId: string, side: "SenderSide" | "ReceiverSide"): V2AllocationSpecification {
  return {
    admin,
    authorizer: { owner: "alice" as Party, provider: null, id: "" },
    transferLegSides: [
      {
        transferLegId: `leg-${admin}`,
        side,
        otherside: { owner: "dealer" as Party, provider: null, id: "" },
        amount: "1.0",
        instrumentId,
        meta: {},
      },
    ],
    settlementDeadline: null,
    nextIterationFunding: null,
    committed: false,
    meta: {},
  };
}

function settlementInfo(): V2SettlementInfo {
  return { executors: ["operator" as Party], id: "MatchedTrade", cid: "#trade:0", meta };
}

// A trade contract spanning two registries: one leg per admin.
function crossAdminTrade(): unknown {
  const leg = (id: string, instrumentId: string) => ({
    transferLegId: id,
    sender: { owner: "alice" as Party, provider: null, id: "" },
    receiver: { owner: "dealer" as Party, provider: null, id: "" },
    amount: "1.0",
    instrumentId,
    meta: {},
  });
  return {
    contractId: "#trade:0",
    venue: "operator" as Party,
    tradeLegs: [
      { admin: "adminA" as Party, leg: leg("leg-a", "BTC") },
      { admin: "adminB" as Party, leg: leg("leg-b", "LP") },
    ],
  };
}

describe("MatchedTradeService", () => {
  it("requestAllocations returns each request's on-ledger view", async () => {
    const ledger = new CapturingLedger();
    const registry = new ContextRegistry();
    const svc = new MatchedTradeService(ledger, registry, "operator" as Party);

    ledger.requestAllocationsResult = ["#req:0", "#req:1"];
    ledger.queryResults["CantonDex.Dex.MatchedTrade:TradeAllocationRequest"] = [
      {
        contractId: "#req:1",
        settlement: settlementInfo(),
        settleAt: null,
        requestedAt: "2026-05-19T12:00:00.000Z",
        allocations: [spec("adminB" as Party, "LP", "ReceiverSide")],
      },
      {
        contractId: "#req:0",
        settlement: settlementInfo(),
        settleAt: null,
        requestedAt: "2026-05-19T12:00:00.000Z",
        allocations: [spec("adminA" as Party, "BTC", "SenderSide")],
      },
    ];

    const result = await svc.requestAllocations({
      tradeCid: "#trade:0" as ContractId<"MatchedTrade">,
    });

    // One enriched entry per created request, in the order the choice returned
    // the cids (not the ACS query order).
    assert.deepEqual(result.map((r) => r.requestCid), ["#req:0", "#req:1"]);
    assert.equal(result[0]!.allocations[0]!.admin, "adminA");
    assert.equal(result[1]!.allocations[0]!.admin, "adminB");
    assert.deepEqual(result[0]!.settlement, settlementInfo());
    assert.equal(result[0]!.requestedAt, "2026-05-19T12:00:00.000Z");
  });

  it("settle derives legs on-ledger and threads per-admin allocation cids + context", async () => {
    const ledger = new CapturingLedger();
    const registry = new ContextRegistry();
    const svc = new MatchedTradeService(ledger, registry, "operator" as Party);

    await svc.settle({
      tradeCid: "#trade:0" as ContractId<"MatchedTrade">,
      // Accepted allocation requests have already been consumed. Settlement
      // binds to the resulting allocations, so there are no live request cids.
      allocationRequestCids: [],
      batchesByAdmin: new Map<Party, SettlementBatchV2>([
        ["adminA" as Party, { allocationCids: ["#a:0" as ContractId<"Allocation">] }],
        ["adminB" as Party, { allocationCids: ["#b:0" as ContractId<"Allocation">] }],
      ]),
    });

    // The preview carries only the finalized allocations per admin; transfer
    // legs are NOT sent -- the trade derives them on-ledger.
    const preview = ledger.submissions.find(
      (s) => (s.command as { choice?: string }).choice === "MatchedTrade_PreviewSettlement",
    );
    assert.ok(preview, "settlement runs the on-ledger preview first");
    const previewArg = (
      preview!.command as {
        argument: { allocationsByAdmin: Array<[string, unknown[]]> };
      }
    ).argument;
    assert.ok(
      Array.isArray(previewArg.allocationsByAdmin),
      "allocationsByAdmin is a GenMap, encoded as an array of pairs",
    );
    const previewByAdmin = new Map(previewArg.allocationsByAdmin);
    assert.deepEqual(previewByAdmin.get("adminA"), [
      { allocationCid: "#a:0", extraTransferLegSides: [], nextIterationFunding: null },
    ]);
    assert.deepEqual(previewByAdmin.get("adminB"), [
      { allocationCid: "#b:0", extraTransferLegSides: [], nextIterationFunding: null },
    ]);
    for (const [, value] of previewArg.allocationsByAdmin) {
      assert.ok(
        !(value as unknown as { transferLegs?: unknown }).transferLegs,
        "the preview does not send caller transfer legs",
      );
    }

    // The final settle binds those cids into each admin's SettlementBatchV2.
    const submit = ledger.lastSubmit!;
    const cmd = submit.command as {
      choice: string;
      argument: {
        batchesByAdmin: Array<[string, {
          allocations: Array<{
            allocationCid: string;
            extraTransferLegSides: unknown[];
            nextIterationFunding: unknown;
          }>;
          factoryCid: string;
          extraArgs: { context: { values: Record<string, unknown> } };
          transferLegs?: unknown;
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
    // SettlementBatchV2 is a plain record of FinalizedAllocation: no variant
    // tag, no legs (the trade owns them), and `allocations`, not `allocationCids`.
    assert.equal((adminABatch as unknown as { tag?: string }).tag, undefined);
    assert.equal(adminABatch!.transferLegs, undefined, "the batch carries no legs");
    assert.deepEqual(adminABatch!.allocations, [
      { allocationCid: "#a:0", extraTransferLegSides: [], nextIterationFunding: null },
    ]);
    assert.deepEqual(adminBBatch!.allocations, [
      { allocationCid: "#b:0", extraTransferLegSides: [], nextIterationFunding: null },
    ]);
    // Required field on the choice; omitting it is a decode failure.
    assert.equal(cmd.argument.dexPairCid, null);
    assert.deepEqual(cmd.argument.allocationRequests, []);
    assert.deepEqual(adminABatch!.extraArgs.context.values, { "ctx.adminA": true });
    assert.deepEqual(adminBBatch!.extraArgs.context.values, { "ctx.adminB": true });

    // One settlement factory per admin, from the exact preview result, and no
    // readAs on any external instrument admin.
    assert.deepEqual(
      registry.settlementLookups.map(({ admin }) => admin),
      ["adminA", "adminB"],
    );
    for (const { admin, choiceArguments } of registry.settlementLookups) {
      assert.equal(
        (choiceArguments.settlement as { id: string }).id,
        `matched-trade:${admin}`,
      );
    }
    assert.equal(submit.readAs, undefined, "settle grants no readAs");
    assert.equal(preview!.readAs, undefined, "preview grants no readAs");
    const disclosureBlobs = submit.disclosure!.map((d) => d.createdEventBlob);
    assert.deepEqual(new Set(disclosureBlobs), new Set([
      "factory-adminA",
      "context-adminA",
      "factory-adminB",
      "context-adminB",
    ]));
    assert.equal(disclosureBlobs.length, new Set(disclosureBlobs).size);
  });

  it("settle recovers the connected party's allocations from the tree and groups them by the trade's admins", async () => {
    const ledger = new CapturingLedger();
    const registry = new ContextRegistry();
    const svc = new MatchedTradeService(ledger, registry, "operator" as Party);

    ledger.queryResults["CantonDex.Dex.MatchedTrade:MatchedTrade"] = [crossAdminTrade()];
    // Created in the trade's admin order (adminA then adminB), matching the
    // order the wallet authored the connected party's per-admin allocations.
    ledger.treeEvents["update-x"] = [
      { contractId: "#a:0", templateId: ALLOCATION_TEMPLATE },
      { contractId: "#b:0", templateId: ALLOCATION_TEMPLATE },
    ];

    await svc.settle({
      tradeCid: "#trade:0" as ContractId<"MatchedTrade">,
      updateId: "update-x",
      allocationRequestCids: [],
    });

    const submit = ledger.lastSubmit!;
    const cmd = submit.command as {
      choice: string;
      argument: {
        batchesByAdmin: Array<[string, {
          allocations: Array<{ allocationCid: string }>;
        }]>;
      };
    };
    assert.equal(cmd.choice, "MatchedTrade_Settle");
    const byAdmin = new Map(cmd.argument.batchesByAdmin);
    // Recovered cids are grouped one-per-admin, in the trade's admin order.
    assert.deepEqual(byAdmin.get("adminA")!.allocations.map((a) => a.allocationCid), ["#a:0"]);
    assert.deepEqual(byAdmin.get("adminB")!.allocations.map((a) => a.allocationCid), ["#b:0"]);

    // Same derive-and-verify preview, merged disclosures, and no external readAs.
    const preview = ledger.submissions.find(
      (s) => (s.command as { choice?: string }).choice === "MatchedTrade_PreviewSettlement",
    );
    assert.ok(preview, "the updateId path still previews on-ledger");
    assert.equal(preview!.readAs, undefined);
    assert.equal(submit.readAs, undefined);
    assert.deepEqual(
      new Set(submit.disclosure!.map((d) => d.createdEventBlob)),
      new Set(["factory-adminA", "context-adminA", "factory-adminB", "context-adminB"]),
    );
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
