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
import {
  FixedRegistryClient,
  RegistryClient,
} from "@canton-dex/registry-client";
import type {
  ContractId,
  DisclosedContract,
} from "@canton-dex/registry-client";
import type {
  LPTokenPolicy,
  Pool,
  LiquidityAllocationAcceptanceContract,
  Party,
} from "../src/types.js";

class StubRegistry extends FixedRegistryClient {
  constructor() {
    super(() => ({
      allocationFactoryCid: "#alloc:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "#settle:0" as ContractId<"SettlementFactory">,
      disclosure: [],
    }));
  }
}

function disclosed(contractId: string): DisclosedContract {
  return {
    contractId,
    templateId: "Registry:Rules",
    createdEventBlob: `blob:${contractId}`,
  };
}

class PerAdminRegistry extends FixedRegistryClient {
  constructor() {
    super((admin: Party) => ({
      allocationFactoryCid: `#alloc:${admin}` as ContractId<"AllocationFactory">,
      settlementFactoryCid: `#settle:${admin}` as ContractId<"SettlementFactory">,
      disclosure: [disclosed("#shared-rules"), disclosed(`#factory:${admin}`)],
    }));
  }
}

const LP_ID = { admin: "lp", id: "BTC-USDC-LP" };

// mkPool administers both sides under "ad"; the swap input is a full {admin,id}.
const BTC = { admin: "ad", id: "BTC" };
const USDC = { admin: "ad", id: "USDC" };

// Capturing ledger: answers the split-pool queries listActive() makes
// (config + state + slices + rules) + fetchLpPolicy, and records the
// last submitted command so a test can inspect the choice argument.
class CapturingLedger implements LedgerSubmitter {
  lastSubmit: SubmitRequest | null = null;
  readonly submissions: SubmitRequest[] = [];
  servePolicy = true;
  acceptances: LiquidityAllocationAcceptanceContract[] = [];
  treeEvents: Array<{ contractId: string; templateId: string }> = [];
  private allocationCounter = 0;
  private readonly policies: LPTokenPolicy[];
  constructor(private readonly pool: Pool, policyOrPolicies: LPTokenPolicy | LPTokenPolicy[]) {
    this.policies = Array.isArray(policyOrPolicies)
      ? policyOrPolicies
      : [policyOrPolicies];
  }
  async submit<R>(req: SubmitRequest): Promise<R> {
    this.lastSubmit = req;
    this.submissions.push(req);
    const choice = (req.command as { choice?: string }).choice;
    if (choice === "PoolLiquidityRules_PreviewAddAllocations") {
      return {
        baseReceiver: {},
        quoteReceiver: {},
        lpMintSender: {},
      } as R;
    }
    if (choice === "PoolLiquidityRules_PreviewRemoveAllocations") {
      return { lpBurnReceiver: {} } as R;
    }
    if (
      choice === "PoolLiquidityRules_PreviewAddSettlement" ||
      choice === "PoolLiquidityRules_PreviewRemoveSettlement"
    ) {
      // Daml `Map Party SettleBatch`, JSON-encoded as an array of [admin, args]
      // pairs: the asset admins (deduped) plus the LP registrar. A single-admin
      // pool collapses base and quote to one key.
      return this.settlementPreview(true) as R;
    }
    if (choice === "PoolRules_PreviewSwapSettlement") {
      // Swap settles under the input/output instrument admins only (no LP).
      return this.settlementPreview(false) as R;
    }
    if (choice === "AllocationFactory_Allocate") {
      const allocationCid = `#created-allocation:${this.allocationCounter++}`;
      return {
        output: {
          tag: "AllocationInstructionResult_Completed",
          value: { allocationCid },
        },
      } as R;
    }
    return "#result:0" as R;
  }
  async treeCreatedEvents() {
    return this.treeEvents;
  }
  private assetAdmins(): Party[] {
    const b = this.pool.baseInstrumentId.admin;
    const q = this.pool.quoteInstrumentId.admin;
    return b === q ? [b] : [b, q];
  }
  // The per-admin settlement preview: one [admin, SettleBatch] pair per admin.
  private settlementPreview(includeLp: boolean): Array<[Party, Record<string, unknown>]> {
    const admins = includeLp
      ? [...this.assetAdmins(), this.pool.lpRegistrar]
      : this.assetAdmins();
    return admins.map((admin) => [admin, {}]);
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
          lpRegistrar: p.lpRegistrar,
          baseInstrumentId: p.baseInstrumentId, quoteInstrumentId: p.quoteInstrumentId,
          lpInstrumentId: p.lpInstrumentId, feeBps: p.feeBps,
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
      case "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules":
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
      case "CantonDex.Lp.Policy:LPTokenPolicy":
        return this.servePolicy ? (this.policies as unknown as T[]) : [];
      case "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance":
        return this.acceptances as unknown as T[];
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
    totalSupply: "0.0",
    active: true,
  };
}

function mkLpPolicyWithSupply(contractId: string, totalSupply: string): LPTokenPolicy {
  return {
    ...mkLpPolicy(),
    contractId: contractId as ContractId<"LPTokenPolicy">,
    totalSupply,
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
    poolLiquidityRulesCid: "#liquidity-rules:0" as never,
    operator: "op" as never,
    lpRegistrar: "lp" as never,
    baseInstrumentId: { admin: "ad", id: "BTC" },
    quoteInstrumentId: { admin: "ad", id: "USDC" },
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
    accumulatedOperatorFees: null,
    publicReaders: null,
  } as unknown as Pool;
}

// mkPool derives the supply from a JS sqrt; ratio tests need reserves and a
// supply that are exact to the last decimal place.
function mkFundedPool(baseReserve: string, quoteReserve: string, totalLpSupply: string): Pool {
  return {
    ...mkPool(1, 1),
    reserves: { baseAmount: baseReserve, quoteAmount: quoteReserve },
    totalLpSupply,
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
    const out = svc.computeQuote(pool, BTC, "0.01");
    const n = parseFloat(out);
    assert.ok(n > 199.7 && n < 199.85, `expected ~199.8, got ${n}`);
  });

  it("applies the fee (30 bps) — 0.3% less than no-fee quote", () => {
    const noFee = parseFloat(
      new PoolService(
        new InMemoryLedger(),
        new StubRegistry(),
        "op" as never,
      ).computeQuote(mkPool(10, 200_000, 0), BTC, "1"),
    );
    const withFee = parseFloat(svc.computeQuote(mkPool(10, 200_000, 30), BTC, "1"));
    const ratio = withFee / noFee;
    assert.ok(ratio > 0.995 && ratio < 0.998, `expected ~0.997, got ${ratio}`);
  });

  it("quotes the inverse direction", () => {
    const pool = mkPool(10, 200_000, 30);
    // 1000 USDC in. out = 10 * 1000*0.997 / (200_000 + 1000*0.997) ≈ 0.0496 BTC
    const out = parseFloat(svc.computeQuote(pool, USDC, "1000"));
    assert.ok(out > 0.049 && out < 0.0499, `expected ~0.0496, got ${out}`);
  });

  it("floors the output the way the on-ledger swap does", () => {
    // 7 USDC into a zero-fee 1000/1000 pool prices at 7000/1007; half-even
    // rounding lands on ...57, one ulp above the exact quotient, which would
    // quote an output the ledger refuses to pay.
    assert.equal(svc.computeQuote(mkPool(1000, 1000, 0), USDC, "7"), "6.9513406156");
  });

  it("price impact grows with size", () => {
    const pool = mkPool(10, 200_000, 30);
    const tinyOut = parseFloat(svc.computeQuote(pool, BTC, "0.01"));
    const bigOut = parseFloat(svc.computeQuote(pool, BTC, "5"));
    const tinyMid = tinyOut / 0.01;
    const bigMid = bigOut / 5;
    assert.ok(
      bigMid < tinyMid,
      `large swap should give worse per-unit price (tiny=${tinyMid}, big=${bigMid})`,
    );
  });
});

describe("PoolService DvP liquidity", () => {
  const requestedAt = "1970-01-01T00:00:00Z" as never;

  it("recoverDvpAllocations recovers the Allocation cids (in order) + acceptance from updateId", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    // A realistic add-liquidity submission tree: acceptance receipt + a locked
    // holding + the three Allocation creates, interleaved out of order by node.
    ledger.treeEvents = [
      { contractId: "#acc:0", templateId: "pkg:CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance" },
      { contractId: "#hold:0", templateId: "pkg:CantonDex.Registry.V2:Holding" },
      { contractId: "#alloc:base", templateId: "pkg:CantonDex.Registry.V2:Allocation" },
      { contractId: "#alloc:quote", templateId: "pkg:CantonDex.Registry.V2:Allocation" },
      { contractId: "#alloc:receipt", templateId: "pkg:CantonDex.Registry.V2:Allocation" },
    ];
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    const got = await svc.recoverDvpAllocations("update-1", "lp" as never, 3);
    assert.deepEqual(got.allocationCids, ["#alloc:base", "#alloc:quote", "#alloc:receipt"]);
    assert.equal(got.acceptanceCid, "#acc:0");

    // Wrong expected count is a loud failure (guards a partial/garbled tree).
    await assert.rejects(
      svc.recoverDvpAllocations("update-1", "lp" as never, 4),
      /expected 4 Allocation creates/,
    );
  });

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
    assert.equal(cmd.templateId, "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules");
    assert.equal(cmd.choice, "PoolLiquidityRules_RequestAddLiquidity");
    assert.equal(cmd.contractId, "#dvp:0", "drives the venue PoolLiquidityRules contract");
    assert.deepEqual(ledger.lastSubmit!.actAs, ["op"], "request is operator-only");
    assert.equal(cmd.argument.recipient, "lp");
    assert.equal(cmd.argument.baseAmount, "10.0");
    // sqrt(10 * 200000) = sqrt(2_000_000) ≈ 1414.2135623..., floored to 10dp.
    assert.equal(out.lpAmount, "1414.2135623730");
    assert.equal(cmd.argument.lpAmount, "1414.2135623730", "floored quote is passed on-ledger");
  });

  it("off-ratio add quotes the matched share and the refunded excess, and is not refused by default", async () => {
    const pool = mkFundedPool("5.3317059088", "471735.6718858735", "1581.0163443902");
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    const out = await svc.requestAddLiquidity({
      poolCid: pool.contractId,
      recipient: "lp" as never,
      baseAmount: "0.1",
      quoteAmount: "10000.0",
      requestedAt,
    });

    // LP is minted on the base leg: (0.1 * 1581.0163443902) / 5.3317059088.
    assert.equal(out.lpAmount, "29.6531048680");
    assert.equal(out.matchedBaseAmount, "0.1000000000");
    // What the settle draws: ceil(0.1 * 471735.6718858735 / 5.3317059088).
    // Routing this through the LP amount instead rounds twice and lands
    // 22e-10 low, quoting a refund the ledger does not pay.
    assert.equal(out.matchedQuoteAmount, "8847.7436669430");
    assert.equal(out.refundedBaseAmount, "0.0000000000");
    assert.equal(out.refundedQuoteAmount, "1152.2563330570");
    assert.equal(out.offRatioBps, "1152.2563330570");

    const cmd = ledger.lastSubmit!.command as { argument: Record<string, unknown> };
    assert.equal(cmd.argument.quoteAmount, "10000.0", "the whole quote leg still enters the pool");
    assert.equal(cmd.argument.lpAmount, "29.6531048680");
  });

  it("quotes the ledger's matched share when a reserve is large", async () => {
    // Deriving the matched leg from the LP amount rounds twice, and the slack
    // scales with the far reserve: here it returns the whole 1.0 quote, so the
    // caller is told nothing is refundable while the settle refunds 0.999.
    const pool = mkFundedPool("1000.0", "10000000000.0", "3162277.6601683794");
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    const out = await svc.requestAddLiquidity({
      poolCid: pool.contractId,
      recipient: "lp" as never,
      baseAmount: "0.0000000001",
      quoteAmount: "1.0",
      requestedAt,
    });

    // PM.ratioMatchedDeposit: 1e-10 base pairs with 1e-10 * 1e10 / 1000 quote.
    assert.equal(out.matchedBaseAmount, "0.0000000001");
    assert.equal(out.matchedQuoteAmount, "0.0010000000");
    assert.equal(out.refundedBaseAmount, "0.0000000000");
    assert.equal(out.refundedQuoteAmount, "0.9990000000");
  });

  it("at-ratio add matches both legs in full and refunds nothing", async () => {
    const pool = mkFundedPool("10.0", "200000.0", "1000.0");
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    const out = await svc.requestAddLiquidity({
      poolCid: pool.contractId,
      recipient: "lp" as never,
      baseAmount: "1.0",
      quoteAmount: "20000.0",
      requestedAt,
      maxOffRatioBps: 0,
    });

    assert.equal(out.lpAmount, "100.0000000000");
    assert.equal(out.matchedBaseAmount, "1.0000000000");
    assert.equal(out.matchedQuoteAmount, "20000.0000000000");
    assert.equal(out.refundedBaseAmount, "0.0000000000");
    assert.equal(out.refundedQuoteAmount, "0.0000000000");
    assert.equal(out.offRatioBps, "0.0000000000");
    assert.ok(ledger.lastSubmit, "a strict tolerance must not refuse an at-ratio add");
  });

  it("first funding matches both legs whatever the ratio", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    const out = await svc.requestAddLiquidity({
      poolCid: pool.contractId,
      recipient: "lp" as never,
      baseAmount: "10.0",
      quoteAmount: "200000.0",
      requestedAt,
      maxOffRatioBps: 0,
    });

    assert.equal(out.lpAmount, "1414.2135623730");
    assert.equal(out.matchedBaseAmount, "10.0000000000");
    assert.equal(out.matchedQuoteAmount, "200000.0000000000");
    assert.equal(out.offRatioBps, "0.0000000000");
  });

  it("maxOffRatioBps refuses an off-ratio add before anything is submitted", async () => {
    const pool = mkFundedPool("5.3317059088", "471735.6718858735", "1581.0163443902");
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    await assert.rejects(
      () =>
        svc.requestAddLiquidity({
          poolCid: pool.contractId,
          recipient: "lp" as never,
          baseAmount: "0.1",
          quoteAmount: "10000.0",
          requestedAt,
          maxOffRatioBps: 100,
        }),
      /1152.2563330570 bps off the pool ratio/,
    );
    assert.equal(ledger.lastSubmit, null, "no LiquidityAllocationRequest may be created");
  });

  it("maxOffRatioBps admits an add exactly at the limit and refuses one a hair over", async () => {
    const pool = mkFundedPool("5.3317059088", "471735.6718858735", "1581.0163443902");
    const svc = (ledger: CapturingLedger) =>
      new PoolService(ledger, new StubRegistry(), "op" as never);
    const add = (maxOffRatioBps: string) => ({
      poolCid: pool.contractId,
      recipient: "lp" as never,
      baseAmount: "0.1",
      quoteAmount: "10000.0",
      requestedAt,
      maxOffRatioBps,
    });

    const atLimit = new CapturingLedger(pool, mkLpPolicy());
    await svc(atLimit).requestAddLiquidity(add("1152.2563330570"));
    assert.ok(atLimit.lastSubmit);

    const belowLimit = new CapturingLedger(pool, mkLpPolicy());
    await assert.rejects(() => svc(belowLimit).requestAddLiquidity(add("1152.2563330569")));
    assert.equal(belowLimit.lastSubmit, null);
  });

  it("maxOffRatioBps outside 0..10000, or not a number, is refused", async () => {
    const pool = mkFundedPool("10.0", "200000.0", "1000.0");
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);
    const add = (maxOffRatioBps: unknown) =>
      svc.requestAddLiquidity({
        poolCid: pool.contractId,
        recipient: "lp" as never,
        baseAmount: "1.0",
        quoteAmount: "20000.0",
        requestedAt,
        maxOffRatioBps: maxOffRatioBps as number,
      });

    await assert.rejects(() => add(10001), /between 0 and 10000/);
    await assert.rejects(() => add(-1), /between 0 and 10000/);
    await assert.rejects(() => add(Number.NaN), /finite number/);
    await assert.rejects(() => add("half a percent"), /Daml Decimal string/);
    assert.equal(ledger.lastSubmit, null);
  });

  it("settleAddLiquidity is co-signed and threads requestCid + both self-registry factory sets", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new PerAdminRegistry(), "op" as never);

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
    assert.equal(cmd.choice, "PoolLiquidityRules_SettleAddLiquidity");
    assert.deepEqual(
      ledger.lastSubmit!.actAs,
      ["op", "lp"],
      "settle is co-signed [operator, lpRegistrar]",
    );
    assert.equal(cmd.argument.requestCid, "#req:0");
    // Direct-allocation integration binds to the live request, not evidence.
    assert.equal(cmd.argument.acceptanceCid, null, "no acceptance evidence on the direct path");
    assert.equal(cmd.argument.lpBaseDepositCid, "#b:0");
    assert.equal(cmd.argument.lpReceiptCid, "#r:0");
    // Allocation factories, per admin: base+quote receivers under the pool's
    // asset admin, the mint under the LP registrar.
    assert.equal(cmd.argument.baseFactoryCid, "#alloc:ad");
    assert.equal(cmd.argument.quoteFactoryCid, "#alloc:ad");
    assert.equal(cmd.argument.lpFactoryCid, "#alloc:lp");
    // Settlement is one batch per admin (GenMap: array of [admin, batch] pairs).
    // A single-admin pool collapses base and quote into the pool admin's batch.
    assert.deepEqual(cmd.argument.batchesByAdmin, [
      ["ad", { factoryCid: "#settle:ad", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
      ["lp", { factoryCid: "#settle:lp", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
    ]);
    // No collapsed single-admin settlement fields survive.
    assert.equal(cmd.argument.baseQuoteSettleCid, undefined);
    assert.equal(cmd.argument.lpSettleCid, undefined);
    assert.equal(cmd.argument.poolAdminExtraArgs, undefined);
    assert.equal(cmd.argument.extraArgs, undefined, "no collapsed single extraArgs");
    const disclosureIds = ledger.lastSubmit!.disclosure!.map((d) => d.contractId);
    assert.deepEqual(new Set(disclosureIds), new Set([
      "#shared-rules",
      "#factory:ad",
      "#factory:lp",
    ]));
    assert.equal(disclosureIds.length, new Set(disclosureIds).size);
  });

  it("stops before allocation when operation-specific registry discovery fails", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(
      ledger,
      new RegistryClient({
        baseUrl: "https://registry.example",
        fetchImpl: async () => new Response(null, { status: 404 }),
      }),
      "op" as never,
    );

    await assert.rejects(
      svc.settleAddLiquidity({
        poolCid: pool.contractId,
        requestCid: "#req:unsupported" as never,
        recipient: "lp" as never,
        lpBaseDepositCid: "#b:unsupported" as never,
        lpQuoteDepositCid: "#q:unsupported" as never,
        lpReceiptCid: "#r:unsupported" as never,
        baseAmount: "10.0",
        quoteAmount: "200000.0",
        minLpTokens: "0.0",
        knownTotalLpSupply: "0.0",
        requestedAt,
      }),
      /registry: not-found: \/registry\/allocation-instruction\/v2\/allocation-factory/,
    );
    assert.equal(
      (ledger.lastSubmit!.command as { choice?: string }).choice,
      "PoolLiquidityRules_PreviewAddAllocations",
      "only the read-only plan may run before registry discovery fails",
    );
  });

  it("settleAddLiquidity binds to acceptance evidence when no live request is supplied", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    // Canonical stock-wallet flow: accept consumed the request, so the dApp
    // forwards the acceptance evidence cid instead.
    await svc.settleAddLiquidity({
      poolCid: pool.contractId,
      acceptanceCid: "#acc:0" as never,
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

    const cmd = ledger.lastSubmit!.command as { argument: Record<string, unknown> };
    assert.equal(cmd.argument.acceptanceCid, "#acc:0", "acceptance evidence threaded to the choice");
    assert.equal(cmd.argument.requestCid, null, "no live request on the acceptance path");
  });

  it("settleAddLiquidity (operator-discovery) recovers the 3 cids + acceptance from updateId", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    // updateId-only wallet (PartyLayer): the operator recovers the created cids
    // from the transaction tree. Acceptance + locked holding are present too.
    ledger.treeEvents = [
      { contractId: "#acc:0", templateId: "pkg:CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationAcceptance" },
      { contractId: "#hold:0", templateId: "pkg:CantonDex.Registry.V2:Holding" },
      { contractId: "#a:base", templateId: "pkg:CantonDex.Registry.V2:Allocation" },
      { contractId: "#a:quote", templateId: "pkg:CantonDex.Registry.V2:Allocation" },
      { contractId: "#a:receipt", templateId: "pkg:CantonDex.Registry.V2:Allocation" },
    ];
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    // No explicit cids — only updateId.
    await svc.settleAddLiquidity({
      poolCid: pool.contractId,
      updateId: "update-7",
      recipient: "lp" as never,
      baseAmount: "10.0",
      quoteAmount: "200000.0",
      minLpTokens: "0.0",
      knownTotalLpSupply: "0.0",
      requestedAt,
    });

    const cmd = ledger.lastSubmit!.command as { argument: Record<string, unknown> };
    assert.equal(cmd.argument.lpBaseDepositCid, "#a:base", "recovered base deposit (order)");
    assert.equal(cmd.argument.lpQuoteDepositCid, "#a:quote", "recovered quote deposit (order)");
    assert.equal(cmd.argument.lpReceiptCid, "#a:receipt", "recovered LP receipt (order)");
    assert.equal(cmd.argument.acceptanceCid, "#acc:0", "recovered acceptance evidence");
    assert.equal(cmd.argument.requestCid, null, "request consumed on the discovery path");
  });

  it("swap (operator-discovery) recovers the signed allocation from updateId", async () => {
    const pool = mkSlicedPool();
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    ledger.treeEvents = [
      { contractId: "#hold:0", templateId: "pkg:CantonDex.Registry.V2:Holding" },
      { contractId: "#swapAlloc", templateId: "pkg:CantonDex.Registry.V2:Allocation" },
    ];
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    await svc.swap({
      poolCid: pool.contractId,
      swapperAccount: { owner: "swapper", provider: null, id: "" } as never,
      inputInstrumentId: BTC,
      inputAmount: "0.01",
      minOutputAmount: "0",
      quoteBinding: {
        expectedPoolId: pool.poolId,
        poolStateCid: pool.poolStateCid,
        inputSliceCid: pool.baseSlices[0]!.contractId,
        outputSliceCids: [pool.quoteSlices[0]!.contractId],
        minOutputAmount: "0",
      },
      updateId: "u-swap",
    });

    const cmd = ledger.lastSubmit!.command as { argument: Record<string, unknown> };
    // Single-admin swap: the recovered allocation keyed under the pool admin.
    assert.deepEqual(cmd.argument.swapperAllocationCidsByAdmin, [["ad", "#swapAlloc"]]);
    assert.equal(cmd.argument.swapperAllocationCid, undefined, "no collapsed single cid");
    // batchesByAdmin discovered per admin (one for a single-admin swap).
    assert.deepEqual(cmd.argument.batchesByAdmin, [
      ["ad", { factoryCid: "#settle:0", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
    ]);
    assert.deepEqual(cmd.argument.swapAllocationRequestCids, []);
    assert.deepEqual(cmd.argument.quoteBinding, {
      expectedPoolId: pool.poolId,
      poolStateCid: pool.poolStateCid,
      inputSliceCid: "#bs:0",
      outputSliceCids: ["#qs:0"],
      minOutputAmount: "0",
    });
  });

  it("discoverAcceptance disambiguates by originalRequestCid (lp + settlement.id collide)", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const mkAcc = (
      contractId: string, originalRequestCid: string,
    ): LiquidityAllocationAcceptanceContract => ({
      contractId: contractId as never,
      operator: "op" as never,
      lp: "lp" as never,
      // Same lp AND the same constant settlement id ("DexPool", as poolSettlement
      // produces in prod) across all rows — only originalRequestCid disambiguates.
      settlement: { executors: ["op"], id: "DexPool", cid: null, meta: { values: {} } } as never,
      allocations: [],
      settleAt: null,
      acceptedAt: "1970-01-01T00:00:00Z" as never,
      originalRequestCid: originalRequestCid as never,
    });
    ledger.acceptances = [
      mkAcc("#acc:req-A", "#req:A"),
      mkAcc("#acc:req-B", "#req:B"),
    ];
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    // The (lp, settlement.id) key would be ambiguous here; the requestCid key is unique.
    const cid = await svc.discoverAcceptance("#req:B" as never);
    assert.equal(cid, "#acc:req-B", "matches the unique originalRequestCid");

    await assert.rejects(
      svc.discoverAcceptance("#req:none" as never),
      /no LiquidityAllocationAcceptance/,
      "throws when no acceptance matches the request cid",
    );
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
    assert.equal(cmd.choice, "PoolLiquidityRules_RequestRemoveLiquidity");
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
    const svc = new PoolService(ledger, new PerAdminRegistry(), "op" as never);

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
    assert.equal(cmd.choice, "PoolLiquidityRules_SettleRemoveLiquidity");
    assert.deepEqual(ledger.lastSubmit!.actAs, ["op", "lp"]);
    assert.equal(cmd.argument.requestCid, "#req:1");
    assert.equal(cmd.argument.holderBurnSenderCid, "#burn:0");
    // Settlement is one batch per admin (GenMap of [admin, batch] pairs);
    // base+quote collapse to the pool admin, LP under the registrar.
    assert.deepEqual(cmd.argument.batchesByAdmin, [
      ["ad", { factoryCid: "#settle:ad", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
      ["lp", { factoryCid: "#settle:lp", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
    ]);
    // The LP allocation factory is retained; base/quote settle fields are gone.
    assert.equal(cmd.argument.lpFactoryCid, "#alloc:lp");
    assert.equal(cmd.argument.baseQuoteSettleCid, undefined);
    assert.equal(cmd.argument.poolAdminExtraArgs, undefined);
    assert.equal(cmd.argument.extraArgs, undefined, "no collapsed single extraArgs");
    const disclosureIds = ledger.lastSubmit!.disclosure!.map((d) => d.contractId);
    assert.deepEqual(new Set(disclosureIds), new Set([
      "#shared-rules",
      "#factory:ad",
      "#factory:lp",
    ]));
    assert.equal(disclosureIds.length, new Set(disclosureIds).size);
  });

  it("prefers the LP policy whose supply matches the pool state", async () => {
    const pool = mkSlicedPool();
    const ledger = new CapturingLedger(pool, [
      mkLpPolicyWithSupply("#lp:wrong", "0.0"),
      mkLpPolicyWithSupply("#lp:match", pool.totalLpSupply),
    ]);
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    await svc.settleRemoveLiquidity({
      poolCid: pool.contractId,
      requestCid: "#req:2" as never,
      holder: "lp" as never,
      lpTokensToRedeem: pool.totalLpSupply,
      knownTotalLpSupply: pool.totalLpSupply,
      minBaseOut: "0.0",
      minQuoteOut: "0.0",
      holderBaseReceiptCid: "#br:1" as never,
      holderQuoteReceiptCid: "#qr:1" as never,
      holderBurnSenderCid: "#burn:1" as never,
      requestedAt,
    });

    const cmd = ledger.lastSubmit!.command as {
      choice: string; argument: Record<string, unknown>;
    };
    assert.equal(cmd.choice, "PoolLiquidityRules_SettleRemoveLiquidity");
    assert.equal(cmd.argument.lpPolicyCid, "#lp:match");
  });

  it("requirePoolLiquidityRules fails loudly when the venue has no PoolLiquidityRules", async () => {
    const pool = mkPool(0, 0);
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    // Suppress the PoolLiquidityRules row so poolLiquidityRulesCid resolves to null.
    const origQuery = ledger.query.bind(ledger);
    ledger.query = (async (filter) => {
      if (filter.templateId === "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules") return [];
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
      /no PoolLiquidityRules/,
    );
  });
});

// A pool whose base and quote instruments are administered by two different
// registries; LP is a third. Every flow must settle one batch per admin and
// hold no readAs on an external registrar.
describe("PoolService cross-admin settlement", () => {
  const requestedAt = "1970-01-01T00:00:00Z" as never;

  function mkCrossAdminPool(): Pool {
    return {
      ...mkPool(0, 0),
      baseInstrumentId: { admin: "baseAdmin", id: "BTC" },
      quoteInstrumentId: { admin: "quoteAdmin", id: "USDC" },
    } as unknown as Pool;
  }

  it("settleAddLiquidity discovers a factory per admin, merges disclosures, and holds no external readAs", async () => {
    const pool = mkCrossAdminPool();
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new PerAdminRegistry(), "op" as never);

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
    assert.equal(cmd.choice, "PoolLiquidityRules_SettleAddLiquidity");
    // The base and quote receivers are authored under their own instrument
    // admins, not both under the base admin.
    assert.equal(cmd.argument.baseFactoryCid, "#alloc:baseAdmin");
    assert.equal(cmd.argument.quoteFactoryCid, "#alloc:quoteAdmin");
    assert.equal(cmd.argument.lpFactoryCid, "#alloc:lp");
    // One settlement batch per admin: three distinct keys.
    assert.deepEqual(cmd.argument.batchesByAdmin, [
      ["baseAdmin", { factoryCid: "#settle:baseAdmin", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
      ["quoteAdmin", { factoryCid: "#settle:quoteAdmin", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
      ["lp", { factoryCid: "#settle:lp", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
    ]);
    // Co-signed by the operator and its own LP registrar; no readAs on any
    // external asset admin.
    assert.deepEqual(ledger.lastSubmit!.actAs, ["op", "lp"]);
    assert.equal(ledger.lastSubmit!.readAs, undefined);
    const disclosureIds = ledger.lastSubmit!.disclosure!.map((d) => d.contractId);
    assert.deepEqual(new Set(disclosureIds), new Set([
      "#shared-rules",
      "#factory:baseAdmin",
      "#factory:quoteAdmin",
      "#factory:lp",
    ]));
    assert.equal(disclosureIds.length, new Set(disclosureIds).size, "disclosures merged, no repeats");
  });

  it("swap discovers input- and output-admin factories and never reads as an admin", async () => {
    const pool = {
      ...mkPool(15, 300_000),
      baseInstrumentId: { admin: "baseAdmin", id: "BTC" },
      quoteInstrumentId: { admin: "quoteAdmin", id: "USDC" },
      baseSlices: [
        { contractId: "#bs:0", allocationCid: "#ba:0", amount: "15.0000000000", side: "BaseSide" },
      ],
      quoteSlices: [
        { contractId: "#qs:0", allocationCid: "#qa:0", amount: "300000.0000000000", side: "QuoteSide" },
      ],
    } as unknown as Pool;
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new PerAdminRegistry(), "op" as never);

    await svc.swap({
      poolCid: pool.contractId,
      swapperAccount: { owner: "swapper", provider: null, id: "" } as never,
      inputInstrumentId: { admin: "baseAdmin", id: "BTC" } as never,
      inputAmount: "0.01",
      minOutputAmount: "0",
      quoteBinding: {
        expectedPoolId: pool.poolId,
        poolStateCid: pool.poolStateCid,
        inputSliceCid: "#bs:0" as never,
        outputSliceCids: ["#qs:0" as never],
        minOutputAmount: "0",
      },
      // Canonical order: input instrument's admin first, output's second.
      swapperAllocationCids: ["#swapIn" as never, "#swapOut" as never],
    });

    const cmd = ledger.lastSubmit!.command as { choice: string; argument: Record<string, unknown> };
    assert.equal(cmd.choice, "PoolRules_Swap");
    assert.deepEqual(cmd.argument.swapperAllocationCidsByAdmin, [
      ["baseAdmin", "#swapIn"],
      ["quoteAdmin", "#swapOut"],
    ]);
    assert.deepEqual(cmd.argument.batchesByAdmin, [
      ["baseAdmin", { factoryCid: "#settle:baseAdmin", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
      ["quoteAdmin", { factoryCid: "#settle:quoteAdmin", extraArgs: { context: { values: {} }, meta: { values: {} } } }],
    ]);
    // No readAs at all: not on the swapper (a self-custody trader will not grant
    // it) and not on either instrument admin. The operator is the settlement
    // executor named on the allocations, and the merged registry disclosures
    // cover each admin's settlement factory.
    assert.equal(ledger.lastSubmit!.readAs, undefined);
    const disclosureIds = ledger.lastSubmit!.disclosure!.map((d) => d.contractId);
    assert.deepEqual(new Set(disclosureIds), new Set([
      "#shared-rules",
      "#factory:baseAdmin",
      "#factory:quoteAdmin",
    ]));
  });

  it("swap holds no readAs on the trader in either the preview or the settle", async () => {
    // Single-admin sliced pool: one swapper allocation covers both sides.
    const pool = {
      ...mkPool(15, 300_000),
      baseSlices: [
        { contractId: "#bs:0", allocationCid: "#ba:0", amount: "15.0000000000", side: "BaseSide" },
      ],
      quoteSlices: [
        { contractId: "#qs:0", allocationCid: "#qa:0", amount: "300000.0000000000", side: "QuoteSide" },
      ],
    } as unknown as Pool;
    const ledger = new CapturingLedger(pool, mkLpPolicy());
    const svc = new PoolService(ledger, new StubRegistry(), "op" as never);

    await svc.swap({
      poolCid: pool.contractId,
      swapperAccount: { owner: "swapper", provider: null, id: "" } as never,
      inputInstrumentId: BTC,
      inputAmount: "0.01",
      minOutputAmount: "0",
      quoteBinding: {
        expectedPoolId: pool.poolId,
        poolStateCid: pool.poolStateCid,
        inputSliceCid: pool.baseSlices[0]!.contractId,
        outputSliceCids: [pool.quoteSlices[0]!.contractId],
        minOutputAmount: "0",
      },
      swapperAllocationCids: ["#swapAlloc" as never],
    });

    // A self-custody trader does not grant the operator readAs. Neither the
    // PoolRules_PreviewSwapSettlement preview nor the PoolRules_Swap settle may
    // carry the swapper (or any admin) in readAs.
    const swapSubmits = ledger.submissions.filter((s) =>
      String((s.command as { choice?: string }).choice).startsWith("PoolRules_"),
    );
    assert.equal(swapSubmits.length, 2, "a preview and a settle submission");
    for (const s of swapSubmits) {
      assert.ok(
        !(s.readAs ?? []).includes("swapper" as never),
        "no readAs on the swapper",
      );
      assert.ok((s.readAs ?? []).length === 0, "no readAs on any party");
    }
  });
});

// The output plus the fields a trading client would otherwise recompute from
// reserves + feeBps.
describe("PoolService.computeQuoteDetailed", () => {
  const svc = new PoolService(
    new InMemoryLedger(),
    new StubRegistry(),
    "op" as never,
  );

  it("returns exact fee, spot/execution price, and impact", () => {
    const q = svc.computeQuoteDetailed(mkPool(10, 200_000, 30), BTC, "0.5");
    assert.equal(q.outputAmount, "9496.5947516311");
    assert.equal(q.inputInstrumentId, "BTC");
    assert.equal(q.outputInstrumentId, "USDC");
    assert.equal(q.feeBps, 30);
    assert.equal(q.feeAmount, "0.0015000000"); // 0.5 * 30/10000
    assert.equal(q.spotPrice, "20000.0000000000"); // 200000/10
    assert.equal(q.poolCid, "#p:0");
    assert.equal(q.poolId, "BTC-USDC");
    const impact = parseFloat(q.priceImpact);
    assert.ok(impact > 0 && impact < 0.1, `impact ~0.05, got ${impact}`);
    const exec = parseFloat(q.executionPrice);
    assert.ok(exec > 18900 && exec < 19000, `exec ~18993, got ${exec}`);
  });
});
