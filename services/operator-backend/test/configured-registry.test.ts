import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FactoryRefs } from "@canton-dex/registry-client";
import { ConfiguredRegistry } from "../src/configured-registry.js";
import { JsonApiLedger } from "../src/ledger/json-api.js";

const templateId = "a".repeat(64) + ":CantonDex.Registry.V2:Registry";
const contract = (contractId: string, createdEventBlob = "blob") => ({
  contractEntry: { JsActiveContract: {
    synchronizerId: "sync",
    createdEvent: { contractId, templateId, createdEventBlob, createdAt: "2026-09-20T00:00:00Z", createArgument: { admin: "lp-admin", users: [] } },
  } },
});

function fixture(entries = [contract("asset-registry"), contract("lp-registry"), contract("lp-settlement")], status = 200) {
  const calls: Array<{ url: string; body?: Record<string, any> }> = [];
  const ledger = new JsonApiLedger({
    baseUrl: "http://ledger.example", token: "token", applicationId: "app", templateIdPrefix: "#canton-dex",
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(url.endsWith("/ledger-end") ? { offset: 42 } : entries), {
        status: url.endsWith("/ledger-end") ? 200 : status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const refs = (allocation: string, settlement: string): FactoryRefs => ({
    allocationFactoryCid: allocation as FactoryRefs["allocationFactoryCid"],
    settlementFactoryCid: settlement as FactoryRefs["settlementFactoryCid"],
    disclosure: [],
  });
  const registry = new ConfiguredRegistry(new Map([
    ["asset-admin", refs("asset-registry", "asset-registry")],
    ["lp-admin", refs("lp-registry", "lp-settlement")],
  ]), ledger);
  return { registry, ledger, calls };
}

describe("configured registry disclosures", () => {
  it("discloses the LP factory using its admin and resolved ledger template", async () => {
    const { registry, calls } = fixture();
    const result = await registry.getAllocationFactory("lp-admin", {});
    assert.deepEqual(result, {
      factoryCid: "lp-registry", context: { values: {} },
      disclosure: [{ contractId: "lp-registry", templateId, createdEventBlob: "blob", synchronizerId: "sync" }],
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url, "http://ledger.example/v2/state/active-contracts");
    assert.deepEqual(calls[1]!.body, {
      verbose: false, activeAtOffset: 42,
      filter: { filtersByParty: { "lp-admin": { cumulative: [{
        identifierFilter: { TemplateFilter: { value: {
          templateId: "#canton-dex:CantonDex.Registry.V2:Registry", includeCreatedEventBlob: true,
        } } },
      }] } } },
    });
    assert.equal(calls.some((call) => call.url.includes("/commands/")), false);
  });

  it("discloses the selected settlement factory instead of the allocation factory", async () => {
    const { registry } = fixture();
    const result = await registry.getSettlementFactory("lp-admin", {});
    assert.equal(result.factoryCid, "lp-settlement");
    assert.deepEqual(result.disclosure.map((d) => d.contractId), ["lp-settlement"]);
  });

  it("does not substitute another active factory for a missing configured contract", async () => {
    const { registry } = fixture([contract("asset-registry")]);
    await assert.rejects(registry.getAllocationFactory("lp-admin", {}), /lp-registry is not active or visible/);
  });

  it("fails discovery if the ledger does not supply the creation blob", async () => {
    const { registry } = fixture([contract("lp-registry", "")]);
    await assert.rejects(registry.getAllocationFactory("lp-admin", {}), /has no valid disclosure/);
  });

  it("rejects unresolved package aliases in disclosure metadata", async () => {
    const entry = contract("lp-registry");
    entry.contractEntry.JsActiveContract.createdEvent.templateId = "#canton-dex:CantonDex.Registry.V2:Registry";
    const { registry } = fixture([entry]);
    await assert.rejects(registry.getAllocationFactory("lp-admin", {}), /has no valid disclosure/);
  });

  it("preserves ledger authorization failures", async () => {
    const { registry } = fixture([], 403);
    await assert.rejects(registry.getAllocationFactory("lp-admin", {}), /403/);
  });

  it("rejects unconfigured admins before querying the ledger", async () => {
    const { registry, calls } = fixture();
    await assert.rejects(registry.getAllocationFactory("unknown", {}), /no configured factory mapping/);
    assert.equal(calls.length, 0);
  });

  it("preserves regular query payloads without requesting creation blobs", async () => {
    const { ledger, calls } = fixture([contract("lp-registry")]);
    const result = await ledger.query({ templateId: "CantonDex.Registry.V2:Registry", observingParty: "lp-admin" });
    assert.equal(calls[1]!.body?.filter.filtersByParty["lp-admin"].cumulative[0].identifierFilter.TemplateFilter.value.includeCreatedEventBlob, false);
    assert.deepEqual(result, [{ contractId: "lp-registry", admin: "lp-admin", users: [], ledgerCreatedAt: "2026-09-20T00:00:00Z" }]);
  });
});
