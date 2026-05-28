// Pool service tests — focused on the off-chain quote math because
// that's the only logic the operator backend owns. On-chain Pool_Swap
// re-validates against the same constant-product formula, so a unit
// test that the off-chain quote matches expectation is the right
// granularity here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PoolService } from "../src/pool/index.js";
import { InMemoryLedger } from "../src/ledger/in-memory.js";
import type {
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
  LedgerEvent,
} from "../src/ledger/index.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ContractId } from "@canton-dex/registry-client";
import type { LPTokenPolicy, Pool } from "../src/types.js";

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
}

const LP_ID = { admin: "lp", id: "BTC-USDC-LP" };

// Capturing ledger: answers the split-pool queries listActive() makes
// (config + state + slices + rules) + fetchLpPolicy, and records the
// last submitted command so a test can inspect the choice argument.
class CapturingLedger implements LedgerSubmitter {
  lastSubmit: SubmitRequest | null = null;
  servePolicy = true;
  constructor(private readonly pool: Pool, private readonly policy: LPTokenPolicy) {}
  async submit<R>(req: SubmitRequest): Promise<R> {
    this.lastSubmit = req;
    return "#result:0" as R;
  }
  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {
    // no streaming in this stub
  }
  async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    const p = this.pool;
    switch (filter.templateId) {
      case "CantonDex.Dex.Pool:Pool":
        return [{
          contractId: p.contractId, poolId: p.poolId, operator: p.operator,
          lpRegistrar: p.lpRegistrar, admin: p.admin,
          baseInstrumentId: p.baseInstrumentId, quoteInstrumentId: p.quoteInstrumentId,
          lpInstrumentId: p.lpInstrumentId, feeBps: p.feeBps, operatorFeeBps: 0,
        } as unknown as T];
      case "CantonDex.Dex.PoolState:PoolState":
        return [{
          contractId: p.poolStateCid, poolId: p.poolId, operator: p.operator,
          lpRegistrar: p.lpRegistrar, status: p.status, reserves: p.reserves,
          totalLpSupply: p.totalLpSupply, publicReaders: [],
        } as unknown as T];
      case "CantonDex.Dex.PoolSlice:PoolSlice":
        return [];
      case "CantonDex.Dex.PoolRules:PoolRules":
        return [{ contractId: p.rulesCid, operator: p.operator } as unknown as T];
      case "CantonDex.Dex.LPToken:LPTokenPolicy":
        return this.servePolicy ? [this.policy as unknown as T] : [];
      default:
        return [];
    }
  }
}

function mkLpPolicy(): LPTokenPolicy {
  return {
    contractId: "#lp:0" as ContractId<"LPTokenPolicy">,
    lpRegistrar: "lp" as never,
    operator: "op" as never,
    lpInstrumentId: LP_ID,
    baseInstrumentId: "BTC",
    quoteInstrumentId: "USDC",
    totalSupply: "0.0",
    active: true,
  };
}

function mkPool(
  baseReserve: number,
  quoteReserve: number,
  feeBps = 30,
): Pool {
  return {
    contractId: "#p:0" as never,
    poolId: "BTC-USDC",
    poolStateCid: "#ps:0" as never,
    rulesCid: "#rules:0" as never,
    operator: "op" as never,
    lpRegistrar: "lp" as never,
    admin: "ad" as never,
    baseInstrumentId: "BTC",
    quoteInstrumentId: "USDC",
    lpInstrumentId: LP_ID,
    feeBps,
    status: "Active",
    reserves: {
      baseAmount: baseReserve.toFixed(10) as never,
      quoteAmount: quoteReserve.toFixed(10) as never,
    },
    totalLpSupply: Math.sqrt(baseReserve * quoteReserve).toFixed(10) as never,
    baseSlices: [],
    quoteSlices: [],
    operatorFeeBps: null,
    accumulatedOperatorFees: null,
    publicReaders: null,
  } as unknown as Pool;
}

describe("PoolService.computeQuote", () => {
  const svc = new PoolService(
    new InMemoryLedger(),
    new StubRegistry(),
    "op" as never,
  );

  it("matches x*y=k for a tiny swap (negligible fee effect)", () => {
    // 10 BTC / 200_000 USDC pool, 0 fee, 0.01 BTC in.
    // out = 200_000 * 0.01 / (10 + 0.01) = 199.80...
    const pool = mkPool(10, 200_000, 0);
    const out = svc.computeQuote(pool, "BTC", "0.01");
    const n = parseFloat(out);
    assert.ok(n > 199.7 && n < 199.85, `expected ~199.8, got ${n}`);
  });

  it("applies the fee (30 bps) — 0.3% less than no-fee quote", () => {
    const noFee = parseFloat(
      new PoolService(
        new InMemoryLedger(),
        new StubRegistry(),
        "op" as never,
      ).computeQuote(mkPool(10, 200_000, 0), "BTC", "1"),
    );
    const withFee = parseFloat(svc.computeQuote(mkPool(10, 200_000, 30), "BTC", "1"));
    const ratio = withFee / noFee;
    assert.ok(ratio > 0.995 && ratio < 0.998, `expected ~0.997, got ${ratio}`);
  });

  it("quotes the inverse direction", () => {
    const pool = mkPool(10, 200_000, 30);
    // 1000 USDC in. out = 10 * 1000*0.997 / (200_000 + 1000*0.997) ≈ 0.0496 BTC
    const out = parseFloat(svc.computeQuote(pool, "USDC", "1000"));
    assert.ok(out > 0.049 && out < 0.0499, `expected ~0.0496, got ${out}`);
  });

  it("price impact grows with size", () => {
    const pool = mkPool(10, 200_000, 30);
    const tinyOut = parseFloat(svc.computeQuote(pool, "BTC", "0.01"));
    const bigOut = parseFloat(svc.computeQuote(pool, "BTC", "5"));
    const tinyMid = tinyOut / 0.01;
    const bigMid = bigOut / 5;
    assert.ok(
      bigMid < tinyMid,
      `large swap should give worse per-unit price (tiny=${tinyMid}, big=${bigMid})`,
    );
  });
});

describe("PoolService.initialize (DEX-46)", () => {
  it("threads lpPolicyCid + extraArgs into the Pool_Initialize argument", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    await svc.initialize({
      poolCid: pool.contractId,
      recipient: "lp" as never,
      baseHoldingCids: [],
      quoteHoldingCids: [],
      baseAmount: "10.0",
      quoteAmount: "200000.0",
      requestedAt: "1970-01-01T00:00:00Z" as never,
    });

    assert.ok(ledger.lastSubmit, "a command was submitted");
    const cmd = ledger.lastSubmit!.command;
    assert.equal(cmd.kind, "exercise");
    assert.equal(
      (cmd as { templateId: string }).templateId,
      "CantonDex.Dex.PoolRules:PoolRules",
      "init drives the PoolRules contract",
    );
    assert.equal((cmd as { choice: string }).choice, "PoolRules_Initialize");
    const arg = (cmd as { argument: Record<string, unknown> }).argument;
    assert.equal(arg.lpPolicyCid, "#lp:0", "lpPolicyCid is the looked-up policy cid");
    assert.equal(arg.expectedPoolId, "BTC-USDC", "expectedPoolId guard is set");
    assert.equal(arg.poolStateCid, "#ps:0", "poolStateCid is threaded");
    assert.ok(arg.extraArgs, "extraArgs (choice context) is present");
  });

  it("fails loudly when no LPTokenPolicy exists for the pool", async () => {
    const pool = mkPool(0, 0);
    // Capturing ledger that serves the pool contracts but no policy rows.
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    ledger.servePolicy = false;
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);
    await assert.rejects(
      () =>
        svc.initialize({
          poolCid: pool.contractId,
          recipient: "lp" as never,
          baseHoldingCids: [],
          quoteHoldingCids: [],
          baseAmount: "10.0",
          quoteAmount: "200000.0",
          requestedAt: "1970-01-01T00:00:00Z" as never,
        }),
      /no active LPTokenPolicy/,
    );
  });
});
