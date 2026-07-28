// GET /v1/instruments decodes what the ledger actually returns.
//
// Daml Int64 arrives as a JSON string, so `decimals` came back "10" and a
// typeof === "number" guard dropped it, leaving the field null.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { InMemoryLedger } from "../src/ledger/in-memory.js";
import type { SubscriptionFilter } from "../src/ledger/index.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef, ContractId } from "@canton-dex/registry-client";

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
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

// Returns what a participant returns: Int64 as a string, Optional Text as null.
class ConfigLedger extends InMemoryLedger {
  override async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    if (filter.templateId?.endsWith("Registry.V2:InstrumentConfig")) {
      return [{ instrumentId: "dBTC", decimals: "10" }] as T[];
    }
    if (filter.templateId?.endsWith("InstrumentConfiguration")) {
      return [
        { instrumentId: "dBTC", isin: null, cusip: null, description: "Test asset" },
      ] as T[];
    }
    return [];
  }
}

let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  const backend = new OperatorBackend({
    ledger: new ConfigLedger(),
    registry: new StubRegistry(),
    operatorParty: "op" as never,
  });
  const handle = await startHttpServer({
    backend,
    port: 0,
    host: "127.0.0.1",
    context: {
      operator: "op" as never,
      lpRegistrar: "lp" as never,
      admin: "ad" as never,
      allocationFactoryCid: "#alloc:0",
      settlementFactoryCid: "#settle:0",
      allocationFactoryExtraArgs: { context: { values: {} }, meta: { values: {} } },
      allocationFactoryDisclosure: [],
      network: "canton:test",
    },
    devOpen: true,
  });
  baseUrl = handle.url;
  close = handle.close;
});

after(async () => {
  await close();
});

describe("GET /v1/instruments", () => {
  it("decodes decimals from the string the ledger sends", async () => {
    const rows = (await (await fetch(`${baseUrl}/v1/instruments`)).json()) as Array<{
      instrumentId: string;
      decimals: number | null;
      description: string | null;
    }>;
    const dbtc = rows.find((r) => r.instrumentId === "dBTC");
    assert.ok(dbtc, "dBTC missing");
    assert.equal(
      dbtc.decimals,
      10,
      "decimals should be the number 10; a Daml Int64 arrives as the string \"10\"",
    );
    assert.equal(typeof dbtc.decimals, "number", "served as a number, not a string");
  });

  it("still merges the configuration fields", async () => {
    const rows = (await (await fetch(`${baseUrl}/v1/instruments`)).json()) as Array<{
      instrumentId: string;
      description: string | null;
      isin: string | null;
    }>;
    const dbtc = rows.find((r) => r.instrumentId === "dBTC")!;
    assert.equal(dbtc.description, "Test asset");
    assert.equal(dbtc.isin, null, "an unset Optional Text stays null");
  });
});
