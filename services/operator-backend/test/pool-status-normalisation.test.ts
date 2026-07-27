// Pool status on the wire.
//
// A real participant returns the raw Daml constructor, "PS_Active". types.ts
// declares `"Unfunded" | "Active" | "Paused"`, and the in-memory dev server
// already emits the short form — so the two disagreed, and only the dApp
// survived, by stripping the prefix in the frontend. Any other client written
// against the published type saw zero tradable pools. An external integrator's
// adapter filtered out the deployment's only pool on its first run.
//
// The normalisation belongs on the ledger read path (mirroring the OS_ strip
// in OrderService.listOpen), NOT in the HTTP layer and NOT on the write path:
// AdminService submits `status: "PS_Unfunded"` as a PoolState create argument,
// and those are ledger-bound.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PoolService } from "../src/pool/index.ts";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef } from "@canton-dex/registry-client";
import type {
  LedgerEvent,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
} from "../src/ledger/index.ts";
import type { Party } from "../src/types.ts";

const OPERATOR = "operator::test" as Party;

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
  override async getFactories() {
    return {
      allocationFactoryCid: "#f:0" as never,
      settlementFactoryCid: "#f:0" as never,
      disclosure: [],
    };
  }
  override async getChoiceContext(): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: [] };
  }
}

/** Serves one pool whose PoolState carries whatever status the test sets. */
function ledgerServing(status: string): LedgerSubmitter {
  return {
    async query<T>(filter: SubscriptionFilter): Promise<T[]> {
      if (filter.templateId === "CantonDex.Dex.Pool:Pool") {
        return [
          {
            contractId: "#pool:0",
            poolId: "BTC-USDC",
            operator: OPERATOR,
            lpRegistrar: "lp::test",
            admin: "admin::test",
            baseInstrumentId: "BTC",
            quoteInstrumentId: "USDC",
            lpInstrumentId: "BTC-USDC-LP",
            feeBps: 30,
          },
        ] as unknown as T[];
      }
      if (filter.templateId === "CantonDex.Dex.PoolState:PoolState") {
        return [
          {
            contractId: "#state:0",
            poolId: "BTC-USDC",
            status,
            reserves: { baseAmount: "10.0", quoteAmount: "200000.0" },
            totalLpSupply: "1000.0",
          },
        ] as unknown as T[];
      }
      return [] as T[];
    },
    async submit<R>(_req: SubmitRequest): Promise<R> {
      throw new Error("listActive must not submit");
    },
    async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {},
  } as unknown as LedgerSubmitter;
}

describe("PoolService.listActive: pool status", () => {
  const svc = (status: string) =>
    new PoolService(ledgerServing(status), new StubRegistry(), OPERATOR);

  it("strips the raw Daml PS_ prefix a real participant returns", async () => {
    const pools = await svc("PS_Active").listActive();
    assert.equal(pools.length, 1);
    assert.equal(
      pools[0]!.status,
      "Active",
      "the wire value must match the type types.ts declares",
    );
  });

  it("is idempotent — the dev server already emits the short form", async () => {
    const pools = await svc("Active").listActive();
    assert.equal(pools.length, 1);
    assert.equal(pools[0]!.status, "Active");
  });

  it("still filters a paused pool, under either spelling", async () => {
    assert.equal((await svc("PS_Paused").listActive()).length, 0);
    assert.equal((await svc("Paused").listActive()).length, 0);
  });

  it("normalises Unfunded too, not just the status it filters on", async () => {
    // The Paused guard would pass either way; this pins that the value
    // actually SERVED is normalised, which is the integrator-visible part.
    const pools = await svc("PS_Unfunded").listActive();
    assert.equal(pools.length, 1);
    assert.equal(pools[0]!.status, "Unfunded");
  });
});
