import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RegistryClient,
  type ChoiceContextRef,
  type ContractId,
} from "@canton-dex/registry-client";

describe("RegistryClient.getChoiceContext", () => {
  it("fetches and caches the registry-supplied context + disclosure", async () => {
    let calls = 0;
    const expected: ChoiceContextRef = {
      context: { values: { "dex.choiceContext": true } },
      disclosure: [
        {
          contractId: "#cfg:0" as ContractId<"InstrumentConfiguration">,
          templateId: "CantonDex.Instrument.InstrumentConfiguration:InstrumentConfiguration",
          payloadBlob: "payload",
        },
      ],
    };
    const client = new RegistryClient({
      baseUrl: "https://registry.example",
      fetchImpl: async (input) => {
        calls += 1;
        assert.equal(
          input.toString(),
          "https://registry.example/registry/choice-context/admin-a",
        );
        return new Response(JSON.stringify(expected), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const first = await client.getChoiceContext("admin-a");
    const second = await client.getChoiceContext("admin-a");

    assert.deepEqual(first, expected);
    assert.deepEqual(second, expected);
    assert.equal(calls, 1);
  });

  it("falls back to empty context when the registry has no endpoint", async () => {
    const client = new RegistryClient({
      baseUrl: "https://registry.example",
      fetchImpl: async () => new Response(null, { status: 404 }),
    });

    const ctx = await client.getChoiceContext("admin-b");

    assert.deepEqual(ctx, { context: { values: {} }, disclosure: [] });
  });
});
