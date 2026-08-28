// GET /v1/instruments preserves Daml wire types at the HTTP boundary. Daml
// Int64 arrives as a JSON string and is decoded to the endpoint's number field.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { InMemoryLedger } from "../src/ledger/in-memory.js";
import type { SubscriptionFilter } from "../src/ledger/index.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { StubRegistry } from "./stub-registry.js";

// Returns what a participant returns: Int64 as a string, Optional Text as null.
class ConfigLedger extends InMemoryLedger {
  override async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    if (filter.templateId?.endsWith("Registry.V2:InstrumentConfig")) {
      return [
        { instrumentId: "dBTC", decimals: "10", isin: null, cusip: "TEST-1" },
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

  it("serves optional metadata from the V2 registry config", async () => {
    const rows = (await (await fetch(`${baseUrl}/v1/instruments`)).json()) as Array<{
      instrumentId: string;
      description: string | null;
      isin: string | null;
      cusip: string | null;
    }>;
    const dbtc = rows.find((r) => r.instrumentId === "dBTC")!;
    assert.equal(dbtc.description, null, "description is not part of this registry config");
    assert.equal(dbtc.isin, null, "an unset Optional Text stays null");
    assert.equal(dbtc.cusip, "TEST-1");
  });
});
