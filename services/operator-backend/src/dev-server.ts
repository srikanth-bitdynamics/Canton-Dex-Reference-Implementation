// Dev server boot script. Wires the in-memory ledger + a stub registry
// into the OperatorBackend and starts the HTTP shim on :8080 so the
// dApp (vite preview / dev) can fetch real shaped data without a Canton
// participant running.
//
// Scope:
//   - Seeds: one DexPair (BTC/USDC), one Pool (BTC/USDC, Active, two
//     slices per side), some Holdings for a demo trader.
//   - Registers ledger choice handlers needed by the HTTP endpoints the
//     dApp calls today (Pool_Initialize, Pool_AddLiquidity,
//     Pool_RemoveLiquidity, Pool_Swap, Order_Fund/Cancel,
//     OrderFundingRequest_Bind, Rfq_Accept, MatchedTrade_* are
//     stubbed minimally; admin/* re-use built-in create).
//
// This is NOT a production server. It is the smallest amount of
// scaffolding that lets the UI demo end-to-end without a Canton
// participant. Production swaps in JsonApiLedger + a real registry.

import { InMemoryLedger } from "./ledger/in-memory.js";
import { OperatorBackend } from "./index.js";
import { startHttpServer } from "./http/index.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type {
  ContractId,
  Decimal,
  Party,
  Pool,
  PoolSlice,
} from "./types.js";

// Stub registry that returns canned factory CIDs for any admin party.
class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub-registry" });
  }
  override async getFactories(): Promise<{
    allocationFactoryCid: ContractId<"AllocationFactory">;
    settlementFactoryCid: ContractId<"SettlementFactory">;
    disclosure: never[];
  }> {
    return {
      allocationFactoryCid: "#alloc-fac:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "#settle-fac:0" as ContractId<"SettlementFactory">,
      disclosure: [],
    };
  }
}

function registerHandlers(
  ledger: InMemoryLedger,
  operator: Party,
  lpRegistrar: Party,
  admin: Party,
): void {
  // Pool creation visible to operator + lpRegistrar.
  ledger.registerCreateHandler("CantonDex.Dex.Pool:Pool", () => ({
    observers: [operator, lpRegistrar],
  }));
  ledger.registerCreateHandler("CantonDex.Dex.DexPair:DexPair", () => ({
    observers: [operator, admin],
  }));
  ledger.registerCreateHandler(
    "CantonDex.Instrument.Holding:Holding",
    (payload) => ({
      // Operator is included so the dApp's /v1/holdings route (which
      // queries with observingParty = operator) sees trader holdings.
      // Production would route this through the trader's session
      // observation; for the demo the operator is a stand-in.
      observers: [
        admin,
        operator,
        (payload as { owner: Party }).owner,
      ],
    }),
  );
  ledger.registerCreateHandler("CantonDex.Dex.Order:Order", (payload) => ({
    observers: [operator, (payload as { trader: Party }).trader],
  }));

  // Minimal Pool_Swap handler: updates head-slice amounts and reserves
  // exactly the way the Daml choice does, so listActive shows the
  // post-swap state. Returns a fake settlement result.
  ledger.registerChoice("CantonDex.Dex.Pool:Pool", "Pool_Swap", (ctx) => {
    const pool = ctx.self.payload as Pool;
    const arg = ctx.arg as {
      inputInstrumentId: string;
      inputAmount: Decimal;
      minOutputAmount: Decimal;
    };
    const isBaseIn = arg.inputInstrumentId === pool.baseInstrumentId;
    const reserveIn = parseFloat(
      isBaseIn ? pool.reserves.baseAmount : pool.reserves.quoteAmount,
    );
    const reserveOut = parseFloat(
      isBaseIn ? pool.reserves.quoteAmount : pool.reserves.baseAmount,
    );
    const feeMul = (10000 - pool.feeBps) / 10000;
    const dx = parseFloat(arg.inputAmount) * feeMul;
    const out = (reserveOut * dx) / (reserveIn + dx);

    const newReserveBase = (
      isBaseIn
        ? parseFloat(pool.reserves.baseAmount) + parseFloat(arg.inputAmount)
        : parseFloat(pool.reserves.baseAmount) - out
    ).toFixed(10);
    const newReserveQuote = (
      isBaseIn
        ? parseFloat(pool.reserves.quoteAmount) - out
        : parseFloat(pool.reserves.quoteAmount) + parseFloat(arg.inputAmount)
    ).toFixed(10);

    // Head slice deltas: input side grows by inputAmount, output shrinks
    // by `out`. For demo simplicity we adjust head slice in place
    // without rotating CIDs (real Daml rotates to next-iter CIDs).
    const bumpHead = (
      slices: PoolSlice[],
      delta: number,
    ): PoolSlice[] => {
      if (slices.length === 0) return slices;
      const [head, ...rest] = slices;
      return [
        { ...head!, amount: (parseFloat(head!.amount) + delta).toFixed(10) },
        ...rest,
      ];
    };
    const newBaseSlices = bumpHead(
      pool.baseSlices,
      isBaseIn ? parseFloat(arg.inputAmount) : -out,
    );
    const newQuoteSlices = bumpHead(
      pool.quoteSlices,
      isBaseIn ? -out : parseFloat(arg.inputAmount),
    );

    ctx.archive(ctx.self.contractId);
    const newCid = ctx.create(
      "CantonDex.Dex.Pool:Pool",
      {
        ...pool,
        reserves: {
          baseAmount: newReserveBase,
          quoteAmount: newReserveQuote,
        },
        baseSlices: newBaseSlices,
        quoteSlices: newQuoteSlices,
      },
      [operator, lpRegistrar],
    );

    return {
      poolCid: newCid,
      amountOut: out.toFixed(10),
      settleResult: { allocationSettleResults: [], meta: {} },
    };
  });

  // Order cancel: archive the order, no allocation tracking in the mock.
  ledger.registerChoice("CantonDex.Dex.Order:Order", "Order_Cancel", (ctx) => {
    ctx.archive(ctx.self.contractId);
    return { cancelResult: null, releasedHoldings: {} };
  });

  // DexPair toggles
  ledger.registerChoice(
    "CantonDex.Dex.DexPair:DexPair",
    "DexPair_SetActive",
    (ctx) => {
      const pair = ctx.self.payload as Record<string, unknown>;
      const arg = ctx.arg as { newActive: boolean };
      ctx.archive(ctx.self.contractId);
      return ctx.create(
        "CantonDex.Dex.DexPair:DexPair",
        { ...pair, active: arg.newActive },
        [operator, admin],
      );
    },
  );
  ledger.registerChoice(
    "CantonDex.Dex.DexPair:DexPair",
    "DexPair_UpdateFeeModel",
    (ctx) => {
      const pair = ctx.self.payload as Record<string, unknown>;
      const arg = ctx.arg as { newFeeModel: unknown };
      ctx.archive(ctx.self.contractId);
      return ctx.create(
        "CantonDex.Dex.DexPair:DexPair",
        { ...pair, feeModel: arg.newFeeModel },
        [operator, admin],
      );
    },
  );
  ledger.registerChoice(
    "CantonDex.Dex.DexPair:DexPair",
    "DexPair_UpdateTradingMode",
    (ctx) => {
      const pair = ctx.self.payload as Record<string, unknown>;
      const arg = ctx.arg as { newTradingMode: string };
      ctx.archive(ctx.self.contractId);
      return ctx.create(
        "CantonDex.Dex.DexPair:DexPair",
        { ...pair, tradingMode: arg.newTradingMode },
        [operator, admin],
      );
    },
  );
}

async function seed(
  ledger: InMemoryLedger,
  operator: Party,
  lpRegistrar: Party,
  admin: Party,
  trader: Party,
): Promise<void> {
  // DexPair BTC/USDC.
  await ledger.submit({
    actAs: [operator],
    commandId: "seed-pair-btcusdc",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.DexPair:DexPair",
      argument: {
        operator,
        admin,
        baseInstrumentId: "BTC",
        quoteInstrumentId: "USDC",
        tradingMode: "TM_Both",
        feeModel: { makerFeeBps: 10, takerFeeBps: 30, poolFeeBps: 30 },
        active: true,
        publicReaders: null,
        accumulatedMakerFees: null,
        accumulatedTakerFees: null,
      },
    },
  });

  // Pool: 10 BTC + 200000 USDC across two slices per side (one big + one
  // small) so the UI can show the slice count.
  await ledger.submit({
    actAs: [operator],
    commandId: "seed-pool-btcusdc",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.Pool:Pool",
      argument: {
        operator,
        lpRegistrar,
        admin,
        baseInstrumentId: "BTC",
        quoteInstrumentId: "USDC",
        lpInstrumentId: "BTC-USDC-LP",
        feeBps: 30,
        status: "Active",
        reserves: { baseAmount: "10.0000000000", quoteAmount: "200000.0000000000" },
        totalLpSupply: "1414.2135623731",
        baseSlices: [
          { allocationCid: "#alloc-base-1:0", amount: "7.5000000000" },
          { allocationCid: "#alloc-base-2:0", amount: "2.5000000000" },
        ],
        quoteSlices: [
          { allocationCid: "#alloc-quote-1:0", amount: "150000.0000000000" },
          { allocationCid: "#alloc-quote-2:0", amount: "50000.0000000000" },
        ],
        operatorFeeBps: null,
        accumulatedOperatorFees: null,
        publicReaders: null,
      },
    },
  });

  // A few holdings for the demo trader.
  for (const [instrumentId, amount] of [
    ["USDC", "5000.0000000000"],
    ["BTC", "0.2500000000"],
  ]) {
    await ledger.submit({
      actAs: [admin],
      commandId: `seed-holding-${trader}-${instrumentId}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Instrument.Holding:Holding",
        argument: {
          admin,
          owner: trader,
          instrumentId,
          amount,
          locked: false,
        },
      },
    });
  }
}

async function main(): Promise<void> {
  const operator: Party = "operator-demo";
  const lpRegistrar: Party = "lp-registrar-demo";
  const admin: Party = "admin-demo";
  const trader: Party = "trader-demo";

  const ledger = new InMemoryLedger();
  registerHandlers(ledger, operator, lpRegistrar, admin);

  await seed(ledger, operator, lpRegistrar, admin, trader);

  const backend = new OperatorBackend({
    ledger,
    registry: new StubRegistry(),
    operatorParty: operator,
  });

  const port = Number(process.env.PORT ?? 8080);
  const { url } = startHttpServer({
    backend,
    port,
    host: "127.0.0.1",
    context: {
      operator,
      lpRegistrar,
      admin,
      allocationFactoryCid: "#alloc-fac:0",
      settlementFactoryCid: "#settle-fac:0",
      network: process.env.CANTON_NETWORK ?? "canton:devnet",
    },
  });
  // eslint-disable-next-line no-console
  console.log(`[operator-backend] dev server listening at ${url}`);
  console.log(
    `[operator-backend] parties: operator=${operator}, lpRegistrar=${lpRegistrar}, admin=${admin}, trader=${trader}`,
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[operator-backend] fatal:", e);
  process.exit(1);
});
