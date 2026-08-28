import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RegistryClient,
  RegistryError,
  type ChoiceArguments,
} from "@canton-dex/registry-client";

const disclosed = {
  contractId: "#registry-rules:0",
  templateId: "Registry:Rules",
  contractKeyHash: "key-hash",
  createdEventBlob: "created-event-base64",
  synchronizerId: "domain::id",
};

function factoryWire(factoryId: string, marker: string) {
  return {
    factoryId,
    choiceContext: {
      choiceContextData: { values: { marker } },
      disclosedContracts: [disclosed],
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RegistryClient operation-specific Token Standard V2 discovery", () => {
  it("POSTs the exact allocation choice argument and never reuses its response", async () => {
    const choiceArguments: ChoiceArguments = {
      expectedAdmin: "admin-a",
      allocation: { settlement: { id: "swap-42" } },
    };
    let calls = 0;
    const client = new RegistryClient({
      baseUrl: "https://registry.example/base/",
      authToken: "registry-token",
      fetchImpl: async (input, init) => {
        calls += 1;
        assert.equal(
          input.toString(),
          "https://registry.example/registry/allocation-instruction/v2/allocation-factory",
        );
        assert.equal(init?.method, "POST");
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          "Bearer registry-token",
        );
        assert.deepEqual(JSON.parse(String(init?.body)), { choiceArguments });
        return json(factoryWire("#allocation-factory:0", `call-${calls}`));
      },
    });

    const first = await client.getAllocationFactory("admin-a", choiceArguments);
    const second = await client.getAllocationFactory("admin-a", choiceArguments);

    assert.equal(first.factoryCid, "#allocation-factory:0");
    assert.deepEqual(first.context.values, { marker: "call-1" });
    assert.deepEqual(first.disclosure, [disclosed]);
    assert.deepEqual(second.context.values, { marker: "call-2" });
    assert.equal(calls, 2, "choice context may be specific to one exercise");
  });

  it("resolves each admin's settlement endpoint and sends the exact preview", async () => {
    const preview = {
      settlement: { executors: ["operator"], id: "match-7", cid: null },
      allocations: [{ allocationCid: "#allocation:7" }],
    };
    const client = new RegistryClient({
      baseUrl: (admin) => `https://${admin}.registry.example/`,
      fetchImpl: async (input, init) => {
        assert.equal(
          input.toString(),
          "https://admin-b.registry.example/registry/allocation/v2/settlement-factory",
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          choiceArguments: preview,
        });
        return json(factoryWire("#settlement-factory:b", "settle-b"));
      },
    });

    const got = await client.getSettlementFactory("admin-b", preview);

    assert.equal(got.factoryCid, "#settlement-factory:b");
    assert.deepEqual(got.context.values, { marker: "settle-b" });
  });

  it("uses allocation-specific cancel and withdraw context endpoints", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const client = new RegistryClient({
      baseUrl: "https://registry.example",
      fetchImpl: async (input, init) => {
        seen.push({
          url: input.toString(),
          body: JSON.parse(String(init?.body)),
        });
        return json({
          choiceContextData: { values: { operation: seen.length } },
          disclosedContracts: [],
        });
      },
    });

    const cancel = await client.getAllocationCancelContext(
      "admin-a",
      "#allocation/with spaces",
      { reason: "user-request" },
    );
    const withdraw = await client.getAllocationWithdrawContext(
      "admin-a",
      "#allocation/with spaces",
    );

    assert.deepEqual(seen, [
      {
        url:
          "https://registry.example/registry/allocations/v2/%23allocation%2Fwith%20spaces/choice-contexts/cancel",
        body: { meta: { reason: "user-request" } },
      },
      {
        url:
          "https://registry.example/registry/allocations/v2/%23allocation%2Fwith%20spaces/choice-contexts/withdraw",
        body: { meta: {} },
      },
    ]);
    assert.deepEqual(cancel.context.values, { operation: 1 });
    assert.deepEqual(withdraw.context.values, { operation: 2 });
  });

  it("fails closed for missing or malformed canonical responses", async () => {
    const missing = new RegistryClient({
      baseUrl: "https://registry.example",
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    await assert.rejects(
      missing.getAllocationFactory("admin-a", { allocation: "exact" }),
      (error) => error instanceof RegistryError && error.kind === "not-found",
    );

    const malformed = new RegistryClient({
      baseUrl: "https://registry.example",
      fetchImpl: async () => json({ factoryId: "#factory:0" }),
    });
    await assert.rejects(
      malformed.getSettlementFactory("admin-a", { settlement: "exact" }),
      (error) => error instanceof RegistryError && error.kind === "malformed",
    );
  });

});
