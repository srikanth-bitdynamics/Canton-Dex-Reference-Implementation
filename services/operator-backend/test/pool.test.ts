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
        return [...p.baseSlices, ...p.quoteSlices].map((s) => ({
          contractId: s.contractId, poolId: p.poolId, operator: p.operator,
          side: s.side, allocationCid: s.allocationCid, amount: s.amount,
        })) as unknown as T[];
      case "CantonDex.Dex.PoolRules:PoolRules":
        return [{ contractId: p.rulesCid, operator: p.operator } as unknown as T];
      case "CantonDex.Dex.LpDvpRules:LpDvpRules":
        return [{
          contractId: "#dvp:0", operator: p.operator, lpRegistrar: p.lpRegistrar,
        } as unknown as T];
      case "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationRequest":
        // submit() returns "#result:0"; /request reads the created request
        // back by that cid. Specs left empty — tests assert the choice args.
        return [{
          contractId: "#result:0", operator: p.operator, lp: "lp",
          settlement: { executors: [p.operator], id: "s", cid: null, meta: {} },
          allocations: [], requestedAt: "1970-01-01T00:00:00Z", settleAt: null,
        } as unknown as T];
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
    lpDvpRulesCid: "#dvp:0" as never,
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

describe("PoolService DvP liquidity (DEX-53)", () => {
  const requestedAt = "1970-01-01T00:00:00Z" as never;

  it("requestAddLiquidity creates the LiquidityAllocationRequest with a floored LP quote", async () => {
    const pool = mkPool(0, 0); // unfunded → first-funding sqrt quote
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    const out = await svc.requestAddLiquidity({
      poolCid: pool.contractId,
      recipient: "lp" as never,
      baseAmount: "10.0",
      quoteAmount: "200000.0",
      requestedAt,
    });

    const cmd = ledger.lastSubmit!.command as {
      kind: string; templateId: string; contractId: string; choice: string;
      argument: Record<string, unknown>;
    };
    assert.equal(cmd.templateId, "CantonDex.Dex.LpDvpRules:LpDvpRules");
    assert.equal(cmd.choice, "LpDvpRules_RequestAddLiquidity");
    assert.equal(cmd.contractId, "#dvp:0", "drives the venue LpDvpRules contract");
    assert.deepEqual(ledger.lastSubmit!.actAs, ["op"], "request is operator-only");
    assert.equal(cmd.argument.recipient, "lp");
    assert.equal(cmd.argument.baseAmount, "10.0");
    // sqrt(10 * 200000) = sqrt(2_000_000) ≈ 1414.2135623..., floored to 10dp.
    assert.equal(out.lpAmount, "1414.2135623730");
    assert.equal(cmd.argument.lpAmount, "1414.2135623730", "floored quote is passed on-ledger");
  });

  it("settleAddLiquidity is co-signed and threads requestCid + both registries' factories", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    await svc.settleAddLiquidity({
      poolCid: pool.contractId,
      requestCid: "#req:0" as never,
      recipient: "lp" as never,
      lpBaseDepositCid: "#b:0" as never,
      lpQuoteDepositCid: "#q:0" as never,
      lpReceiptCid: "#r:0" as never,
      baseAmount: "10.0",
      quoteAmount: "200000.0",
      minLpTokens: "0.0",
      knownTotalLpSupply: "0.0",
      requestedAt,
    });

    const cmd = ledger.lastSubmit!.command as {
      choice: string; argument: Record<string, unknown>;
    };
    assert.equal(cmd.choice, "LpDvpRules_SettleAddLiquidity");
    assert.deepEqual(
      ledger.lastSubmit!.actAs,
      ["op", "lp"],
      "settle is co-signed [operator, lpRegistrar]",
    );
    assert.equal(cmd.argument.requestCid, "#req:0");
    assert.equal(cmd.argument.lpBaseDepositCid, "#b:0");
    assert.equal(cmd.argument.lpReceiptCid, "#r:0");
    assert.ok(cmd.argument.baseFactoryCid, "base/quote factory present");
    assert.ok(cmd.argument.lpFactoryCid, "LP factory present");
    assert.ok(cmd.argument.lpSettleCid, "LP settlement factory present");
  });

  // A pool whose 15 BTC / 300k USDC reserves are split across two slices
  // per side, so a full redemption draws across both.
  function mkSlicedPool(): Pool {
    return {
      ...mkPool(15, 300_000),
      baseSlices: [
        { contractId: "#bs:0", allocationCid: "#ba:0", amount: "10.0000000000", side: "BaseSide" },
        { contractId: "#bs:1", allocationCid: "#ba:1", amount: "5.0000000000", side: "BaseSide" },
      ],
      quoteSlices: [
        { contractId: "#qs:0", allocationCid: "#qa:0", amount: "200000.0000000000", side: "QuoteSide" },
        { contractId: "#qs:1", allocationCid: "#qa:1", amount: "100000.0000000000", side: "QuoteSide" },
      ],
    } as unknown as Pool;
  }

  it("requestRemoveLiquidity derives the slice prefix + per-slice outs (caller passes only redeem)", async () => {
    const pool = mkSlicedPool();
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    // Redeem the full supply → share 1.0 → draw both slices per side fully.
    const out = await svc.requestRemoveLiquidity({
      poolCid: pool.contractId,
      holder: "lp" as never,
      lpTokensToRedeem: pool.totalLpSupply,
      requestedAt,
    });

    const cmd = ledger.lastSubmit!.command as {
      choice: string; argument: Record<string, unknown>;
    };
    assert.equal(cmd.choice, "LpDvpRules_RequestRemoveLiquidity");
    // Full slices are passed verbatim (no float round-trip); lpBurnAmount = redeem.
    assert.deepEqual(cmd.argument.baseOuts, ["10.0000000000", "5.0000000000"]);
    assert.deepEqual(cmd.argument.quoteOuts, ["200000.0000000000", "100000.0000000000"]);
    assert.equal(cmd.argument.lpBurnAmount, pool.totalLpSupply);
    // The derived plan is echoed for the settle call.
    assert.deepEqual(out.baseSliceCids, ["#bs:0", "#bs:1"]);
    assert.deepEqual(out.quoteSliceCids, ["#qs:0", "#qs:1"]);
  });

  it("settleRemoveLiquidity derives slice cids itself + co-signs", async () => {
    const pool = mkSlicedPool();
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    await svc.settleRemoveLiquidity({
      poolCid: pool.contractId,
      requestCid: "#req:1" as never,
      holder: "lp" as never,
      lpTokensToRedeem: pool.totalLpSupply,
      knownTotalLpSupply: pool.totalLpSupply,
      minBaseOut: "0.0",
      minQuoteOut: "0.0",
      holderBaseReceiptCid: "#br:0" as never,
      holderQuoteReceiptCid: "#qr:0" as never,
      holderBurnSenderCid: "#burn:0" as never,
      requestedAt,
    });

    const cmd = ledger.lastSubmit!.command as {
      choice: string; argument: Record<string, unknown>;
    };
    // Slice cids are operator-derived, not caller-supplied.
    assert.deepEqual(cmd.argument.baseSliceCids, ["#bs:0", "#bs:1"]);
    assert.deepEqual(cmd.argument.quoteSliceCids, ["#qs:0", "#qs:1"]);
    assert.equal(cmd.choice, "LpDvpRules_SettleRemoveLiquidity");
    assert.deepEqual(ledger.lastSubmit!.actAs, ["op", "lp"]);
    assert.equal(cmd.argument.requestCid, "#req:1");
    assert.equal(cmd.argument.holderBurnSenderCid, "#burn:0");
  });

  it("requireDvpRules fails loudly when the venue has no LpDvpRules", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    // Suppress the LpDvpRules row so lpDvpRulesCid resolves to null.
    const origQuery = ledger.query.bind(ledger);
    ledger.query = (async (filter) => {
      if (filter.templateId === "CantonDex.Dex.LpDvpRules:LpDvpRules") return [];
      return origQuery(filter);
    }) as typeof ledger.query;
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);
    await assert.rejects(
      () =>
        svc.requestAddLiquidity({
          poolCid: pool.contractId,
          recipient: "lp" as never,
          baseAmount: "10.0",
          quoteAmount: "200000.0",
          requestedAt,
        }),
      /no LpDvpRules/,
    );
  });
});
