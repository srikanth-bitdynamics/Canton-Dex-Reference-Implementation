// /v1/status must distinguish a healthy in-memory demo from a configured
// participant that cannot be reached. A fake moving slot would let deployment
// smoke checks pass while Canton is offline.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { StubRegistry } from "./stub-registry.js";
import { startHttpServer } from "../src/http/index.js";
import { OperatorBackend } from "../src/index.js";
import { InMemoryLedger } from "../src/ledger/in-memory.js";

let baseUrl = "";
let close: () => Promise<void>;

before(async () => {
  const backend = new OperatorBackend({
    ledger: new InMemoryLedger(),
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
    // Deliberately unreachable. Merely configuring a participant must switch
    // status out of the in-memory dev-counter behavior.
    ledgerUrl: "http://127.0.0.1:1",
    ledgerToken: "test-token",
  });
  baseUrl = handle.url;
  close = handle.close;
});

after(async () => close());

describe("participant sync status", () => {
  it("reports unsynced instead of inventing a live slot", async () => {
    const res = await fetch(`${baseUrl}/v1/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { slot: number; synced: boolean };
    assert.equal(body.synced, false);
    assert.equal(body.slot, 0);
  });
});
