import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { JsonApiLedger } from "../src/ledger/json-api.js";
import { recoverCreatedAllocations } from "../src/ledger/recover.js";

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

describe("JsonApiLedger allocation recovery", () => {
  const party = "trader";
  const created = (nodeId: number, contractId: string) => ({
    CreatedTreeEvent: { value: { nodeId, contractId, templateId: "foreign:Registry:Contract" } },
  });
  const completed = (nodeId: number, allocationCid: string) => ({
    ExercisedTreeEvent: { value: {
      nodeId,
      choice: "AllocationFactory_Allocate",
      exerciseResult: { output: { tag: "AllocationInstructionResult_Completed", value: { allocationCid } } },
    } },
  });
  const active = (contractId: string) => ({
    contractEntry: { JsActiveContract: { createdEvent: { contractId } } },
  });
  function fixture(transaction: unknown, allocations: string[], status = 200) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const ledger = new JsonApiLedger({
      baseUrl: "http://ledger.example", token: "token", applicationId: "app",
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        return url.includes("transaction-tree-by-id")
          ? jsonResponse({ transaction })
          : jsonResponse(allocations.map(active), status);
      }) as typeof fetch,
    });
    return { ledger, calls };
  }

  it("recovers a private allocation from its interface at the signed transaction offset", async () => {
    const { ledger, calls } = fixture({
      offset: "9007199254740993",
      eventsById: {
        "4": created(4, "00locked-holding"),
        "6": created(6, "00usdc-allocation"),
        "7": created(7, "00change"),
      },
    }, ["00older-allocation", "00usdc-allocation"]);

    const result = await recoverCreatedAllocations(ledger, party, "signed-usdc", 1);
    assert.deepEqual(result.allocationCids, ["00usdc-allocation"]);
    const lookup = calls.find((call) => call.url.endsWith("/v2/state/active-contracts"))!;
    const body = JSON.parse(String(lookup.init?.body));
    assert.equal(lookup.init?.method, "POST");
    assert.equal(body.activeAtOffset, "9007199254740993");
    assert.deepEqual(Object.keys(body.filter.filtersByParty), [party]);
    assert.deepEqual(body.filter.filtersByParty[party].cumulative, [{
      identifierFilter: { InterfaceFilter: { value: {
        interfaceId: "#splice-api-token-allocation-v2:Splice.Api.Token.AllocationV2:Allocation",
        includeInterfaceView: false,
        includeCreatedEventBlob: false,
      } } },
    }]);
    assert.equal(calls.some((call) => call.url.includes("ledger-end")), false);
    assert.equal(calls.some((call) => call.url.includes("/commands/")), false);
  });

  it("uses completed factory results without an active-contract lookup", async () => {
    const { ledger, calls } = fixture({ eventsById: {
      "1": completed(1, "00allocation"), "2": created(2, "00allocation"),
    } }, []);
    assert.deepEqual(await ledger.treeAllocationCids("signed-cc", party, 1), ["00allocation"]);
    assert.equal(calls.length, 1);
  });

  it("combines partially visible results with created allocations in command order", async () => {
    const { ledger } = fixture({ offset: 42, eventsById: {
      "9": completed(9, "00lp"),
      "10": created(10, "00lp"),
      "6": created(6, "00usdc"),
      "1": completed(1, "00cc"),
      "2": created(2, "00cc"),
    } }, ["00lp", "00cc", "00usdc", "00unrelated"]);
    assert.deepEqual(await ledger.treeAllocationCids("signed-batch", party, 3), ["00cc", "00usdc", "00lp"]);
  });

  it("does not mistake pending instructions or holdings for completed allocations", async () => {
    const { ledger } = fixture({ offset: 42, eventsById: {
      "0": { ExercisedTreeEvent: { value: {
        nodeId: 0, choice: "AllocationFactory_Allocate",
        exerciseResult: { output: {
          tag: "AllocationInstructionResult_Pending", value: { allocationInstructionCid: "00pending" },
        } },
      } } },
      "1": created(1, "00pending"),
      "2": created(2, "00locked-holding"),
    } }, ["00older-allocation"]);
    await assert.rejects(recoverCreatedAllocations(ledger, party, "pending", 1), /found 0/);
  });

  it("does not accept an allocation absent from the original transaction", async () => {
    const { ledger } = fixture({ offset: 42, eventsById: {
      "1": created(1, "00holding"),
    } }, ["00other-transaction"]);
    assert.deepEqual(await ledger.treeAllocationCids("signed", party, 1), []);
  });

  it("preserves ledger lookup failures", async () => {
    const { ledger } = fixture({ offset: 42, eventsById: { "1": created(1, "00allocation") } }, [], 403);
    await assert.rejects(ledger.treeAllocationCids("signed", party, 1), /403/);
  });

  it("rejects a missing transaction offset instead of using current holdings", async () => {
    const { ledger, calls } = fixture({ eventsById: { "1": created(1, "00allocation") } }, ["00allocation"]);
    await assert.rejects(ledger.treeAllocationCids("signed", party, 1), /no valid offset/);
    assert.equal(calls.length, 1);
  });
});
