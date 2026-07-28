import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { JsonApiLedger } from "../src/ledger/json-api.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("JsonApiLedger.submit", () => {
  it("follows updateId to a transaction tree for create commands", async () => {
    const urls: string[] = [];
    const ledger = new JsonApiLedger({
      baseUrl: "http://ledger.example",
      token: "token",
      applicationId: "app",
      templateIdPrefix: "#pkg",
      fetchImpl: (async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (urls.length === 1) {
          assert.equal(url, "http://ledger.example/v2/commands/submit-and-wait");
          return jsonResponse({ updateId: "u1", completionOffset: 42 });
        }
        assert.match(url, /\/v2\/updates\/transaction-tree-by-id\/u1\?/);
        assert.match(url, /parties=Alice/);
        assert.match(url, /parties=Bob/);
        return jsonResponse({
          transaction: {
            eventsById: {
              "0": {
                CreatedTreeEvent: {
                  value: { nodeId: 0, contractId: "#created:1" },
                },
              },
            },
          },
        });
      }) as typeof fetch,
    });

    const cid = await ledger.submit<string>({
      actAs: ["Alice" as never],
      readAs: ["Bob" as never],
      commandId: "create-1",
      command: {
        kind: "create",
        templateId: "CantonDex.Dex.Pool:Pool",
        argument: {},
      },
    });

    assert.equal(cid, "#created:1");
  });

  it("follows updateId to a transaction tree for exercise results", async () => {
    const ledger = new JsonApiLedger({
      baseUrl: "http://ledger.example",
      token: "token",
      applicationId: "app",
      fetchImpl: (async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/v2/commands/submit-and-wait")) {
          return jsonResponse({ updateId: "u2", completionOffset: 43 });
        }
        return jsonResponse({
          transaction: {
            eventsById: {
              "1": {
                ExercisedTreeEvent: {
                  value: { nodeId: 1, exerciseResult: { ok: true, cid: "#x:1" } },
                },
              },
            },
          },
        });
      }) as typeof fetch,
    });

    const out = await ledger.submit<{ ok: boolean; cid: string }>({
      actAs: ["Alice" as never],
      commandId: "exercise-1",
      command: {
        kind: "exercise",
        templateId: "CantonDex.Dex.PoolRules:PoolRules",
        contractId: "#rules:1",
        choice: "PoolRules_Swap",
        argument: {},
      },
    });

    assert.deepEqual(out, { ok: true, cid: "#x:1" });
  });

  // A createAndExercise emits both a created and an exercised event. The
  // caller wants the choice result; the created contract is normally already
  // archived by the choice that consumed it.
  it("returns the choice result, not the created cid, for createAndExercise", async () => {
    const ledger = new JsonApiLedger({
      baseUrl: "http://ledger.example",
      token: "token",
      applicationId: "app",
      fetchImpl: (async () =>
        jsonResponse({
          updateId: "u3",
          events: [
            { created: { contractId: "#exec:1" } },
            {
              exercised: {
                exerciseResult: {
                  buyerNextAllocationCid: "#alloc:next",
                  sellerNextAllocationCid: null,
                },
              },
            },
          ],
        })) as typeof fetch,
    });

    const out = await ledger.submit<{
      buyerNextAllocationCid: string | null;
      sellerNextAllocationCid: string | null;
    }>({
      actAs: ["Alice" as never],
      commandId: "match-1",
      command: {
        kind: "createAndExercise",
        templateId: "CantonDex.Dex.OrderMatchExecution:OrderMatchExecution",
        argument: {},
        choice: "OrderMatchExecution_Execute",
        choiceArgument: {},
      },
    });

    assert.deepEqual(out, {
      buyerNextAllocationCid: "#alloc:next",
      sellerNextAllocationCid: null,
    });
  });
});
