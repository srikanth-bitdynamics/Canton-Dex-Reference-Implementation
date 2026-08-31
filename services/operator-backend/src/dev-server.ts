// Dev server boot script. Wires the in-memory ledger + a stub registry
// into the OperatorBackend and starts the HTTP shim on :8080 so the
// dApp (vite preview / dev) can fetch real shaped data without a Canton
// participant running.
//
// Scope:
//   - Seeds: one DexPair (Amulet/USDCx), one Pool (Amulet/USDCx, Active, two
//     slices per side), some Holdings for a demo trader.
//   - Registers ledger choice handlers needed by the HTTP endpoints the
//     dApp calls today (PoolRules_Swap, the DvP add/remove settles,
//     Order_Fund/Cancel, OrderFundingRequest_Bind, Rfq_Accept,
//     MatchedTrade_* are stubbed minimally; admin/* re-use built-in create).
//
// This is NOT a production server. It is the smallest amount of scaffolding
// needed to exercise the UI-to-HTTP loop without a Canton participant. It does
// not prove Daml execution or value movement. Live mode swaps in JsonApiLedger
// and a real registry.

import { InMemoryLedger } from "./ledger/in-memory.js";
import { OperatorBackend } from "./index.js";
import { startHttpServer } from "./http/index.js";
import { FixedRegistryClient } from "@canton-dex/registry-client";
import type {
  ContractId,
  Decimal,
  InstrumentId,
  Party,
  Pool,
  PoolSlice,
} from "./types.js";

// === Demo instrument identities ==============================================
// The only place the dev-server names an asset. Base and quote share one demo
// admin until cross-admin settlement lands; the LP admin is the lpRegistrar.
const DEMO_ADMIN: Party = "admin-demo";
const DEMO_LP_REGISTRAR: Party = "lp-registrar-demo";
const DEMO_BASE_INSTRUMENT: InstrumentId = { admin: DEMO_ADMIN, id: "Amulet" };
const DEMO_QUOTE_INSTRUMENT: InstrumentId = { admin: DEMO_ADMIN, id: "USDCx" };
const DEMO_LP_INSTRUMENT: InstrumentId = { admin: DEMO_LP_REGISTRAR, id: "Amulet-USDCx-LP" };
const DEMO_POOL_ID = `${DEMO_BASE_INSTRUMENT.id}-${DEMO_QUOTE_INSTRUMENT.id}`;

// Stub registry that returns canned factory CIDs for any admin party.
class StubRegistry extends FixedRegistryClient {
  constructor() {
    super(() => ({
      allocationFactoryCid: "#alloc-fac:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "#settle-fac:0" as ContractId<"SettlementFactory">,
      disclosure: [],
    }));
  }
}

function registerHandlers(
  ledger: InMemoryLedger,
  operator: Party,
  lpRegistrar: Party,
  admin: Party,
): void {
  // Pool config + state + slices + rules visible to operator + lpRegistrar.
  for (const tid of [
    "CantonDex.Dex.Pool:Pool",
    "CantonDex.Dex.PoolState:PoolState",
    "CantonDex.Dex.PoolSlice:PoolSlice",
    "CantonDex.Dex.PoolRules:PoolRules",
    "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
  ]) {
    ledger.registerCreateHandler(tid, () => ({ observers: [operator, lpRegistrar] }));
  }
  ledger.registerCreateHandler("CantonDex.Dex.DexPair:DexPair", () => ({
    observers: [operator, admin],
  }));
  ledger.registerCreateHandler(
    "CantonDex.Registry.V2:Holding",
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

  // Minimal PoolRules_Swap handler: reads PoolState + the
  // input/output slices by cid from the ACS, recreates PoolState with the
  // new reserves, grows the input slice and shrinks the head output slice,
  // so listActive shows the post-swap state. Best-effort mock; the real
  // Daml choice rotates allocation cids via SettleBatch.
  ledger.registerChoice("CantonDex.Dex.PoolRules:PoolRules", "PoolRules_Swap", (ctx) => {
    const arg = ctx.arg as {
      poolCid: string;
      poolStateCid: string;
      inputInstrumentId: string;
      inputAmount: Decimal;
      inputSliceCid: string;
      outputSliceCids: string[];
    };
    const cfg = ctx.acs.get(arg.poolCid)?.payload as
      | { baseInstrumentId: InstrumentId; feeBps: number }
      | undefined;
    const stateEntry = ctx.acs.get(arg.poolStateCid);
    const state = stateEntry?.payload as
      | { reserves: { baseAmount: string; quoteAmount: string } } & Record<string, unknown>
      | undefined;
    if (!cfg || !state) throw new Error("dev-mock: pool config/state not found");

    const isBaseIn = arg.inputInstrumentId === cfg.baseInstrumentId.id;
    const reserveIn = parseFloat(isBaseIn ? state.reserves.baseAmount : state.reserves.quoteAmount);
    const reserveOut = parseFloat(isBaseIn ? state.reserves.quoteAmount : state.reserves.baseAmount);
    const feeMul = (10000 - cfg.feeBps) / 10000;
    const dx = parseFloat(arg.inputAmount) * feeMul;
    const out = (reserveOut * dx) / (reserveIn + dx);

    const newReserves = {
      baseAmount: (isBaseIn
        ? parseFloat(state.reserves.baseAmount) + parseFloat(arg.inputAmount)
        : parseFloat(state.reserves.baseAmount) - out).toFixed(10),
      quoteAmount: (isBaseIn
        ? parseFloat(state.reserves.quoteAmount) - out
        : parseFloat(state.reserves.quoteAmount) + parseFloat(arg.inputAmount)).toFixed(10),
    };

    // Recreate PoolState with the new reserves.
    ctx.archive(arg.poolStateCid);
    const newStateCid = ctx.create(
      "CantonDex.Dex.PoolState:PoolState",
      { ...state, reserves: newReserves },
      [operator, lpRegistrar],
    );

    // Grow the input slice; shrink the head output slice.
    const bump = (cid: string, delta: number): string => {
      const e = ctx.acs.get(cid);
      if (!e) return cid;
      const s = e.payload as { amount: string } & Record<string, unknown>;
      ctx.archive(cid);
      return ctx.create(
        "CantonDex.Dex.PoolSlice:PoolSlice",
        { ...s, amount: (parseFloat(s.amount) + delta).toFixed(10) },
        [operator, lpRegistrar],
      );
    };
    const newInputSliceCid = bump(arg.inputSliceCid, parseFloat(arg.inputAmount));
    const headOut = arg.outputSliceCids[0];
    const newBoundaryCid = headOut ? bump(headOut, -out) : null;

    return {
      poolStateCid: newStateCid,
      inputSliceCid: newInputSliceCid,
      boundaryOutputSliceCid: newBoundaryCid,
      outputSlicesConsumed: 1,
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
  // DexPair Amulet/USDCx.
  await ledger.submit({
    actAs: [operator],
    commandId: "seed-pair-amulet-usdcx",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.DexPair:DexPair",
      argument: {
        operator,
        baseInstrumentId: DEMO_BASE_INSTRUMENT,
        quoteInstrumentId: DEMO_QUOTE_INSTRUMENT,
        tradingMode: "TM_Both",
        feeModel: { makerFeeBps: 10, takerFeeBps: 30, poolFeeBps: 30 },
        active: true,
        publicReaders: null,
        accumulatedMakerFees: null,
        accumulatedTakerFees: null,
      },
    },
  });

  // Pool: immutable config + Active state + two slices
  // per side (one big + one small, so the UI shows the slice count) + the
  // per-venue rules contract.
  const poolId = DEMO_POOL_ID;
  await ledger.submit({
    actAs: [operator],
    commandId: "seed-pool-amulet-usdcx",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.Pool:Pool",
      argument: {
        poolId,
        operator,
        lpRegistrar,
        baseInstrumentId: DEMO_BASE_INSTRUMENT,
        quoteInstrumentId: DEMO_QUOTE_INSTRUMENT,
        lpInstrumentId: DEMO_LP_INSTRUMENT,
        feeBps: 30,
      },
    },
  });
  await ledger.submit({
    actAs: [operator],
    commandId: "seed-pool-state-amulet-usdcx",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.PoolState:PoolState",
      argument: {
        poolId,
        operator,
        lpRegistrar,
        status: "Active",
        reserves: { baseAmount: "10.0000000000", quoteAmount: "200000.0000000000" },
        totalLpSupply: "1414.2135623731",
        publicReaders: [],
      },
    },
  });
  const slices: Array<["BaseSide" | "QuoteSide", string, string]> = [
    ["BaseSide", "#alloc-base-1:0", "7.5000000000"],
    ["BaseSide", "#alloc-base-2:0", "2.5000000000"],
    ["QuoteSide", "#alloc-quote-1:0", "150000.0000000000"],
    ["QuoteSide", "#alloc-quote-2:0", "50000.0000000000"],
  ];
  for (const [side, allocationCid, amount] of slices) {
    await ledger.submit({
      actAs: [operator],
      commandId: `seed-pool-slice-${side}-${allocationCid}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Dex.PoolSlice:PoolSlice",
        argument: { poolId, operator, side, allocationCid, amount },
      },
    });
  }
  await ledger.submit({
    actAs: [operator],
    commandId: "seed-pool-rules",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.PoolRules:PoolRules",
      argument: { operator },
    },
  });

  // Co-controlled liquidity venue rules so add/remove-liquidity can resolve
  // a PoolLiquidityRules cid (PoolService.listActive / requirePoolLiquidityRules).
  await ledger.submit({
    actAs: [operator, lpRegistrar],
    commandId: "seed-pool-liquidity-rules",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules",
      argument: { operator, lpRegistrar },
    },
  });

  // Matching LP token policy so add/remove-liquidity can resolve the
  // pool's policy cid (PoolService.fetchLpAssetPolicy), matched by
  // lpInstrumentId + lpRegistrar.
  await ledger.submit({
    actAs: [lpRegistrar],
    commandId: "seed-lp-policy-amulet-usdcx",
    command: {
      kind: "create",
      templateId: "CantonDex.Lp.Policy:LPTokenPolicy",
      argument: {
        lpRegistrar,
        operator,
        lpInstrumentId: DEMO_LP_INSTRUMENT,
        totalSupply: "1414.2135623731",
        active: true,
      },
    },
  });

  // A few holdings for the demo trader.
  for (const [instrumentId, amount] of [
    [DEMO_QUOTE_INSTRUMENT.id, "5000.0000000000"],
    [DEMO_BASE_INSTRUMENT.id, "0.2500000000"],
  ]) {
    await ledger.submit({
      actAs: [admin],
      commandId: `seed-holding-${trader}-${instrumentId}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Registry.V2:Holding",
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
  const lpRegistrar: Party = DEMO_LP_REGISTRAR;
  const admin: Party = DEMO_ADMIN;
  const trader: Party = "trader-demo";

  const ledger = new InMemoryLedger();
  registerHandlers(ledger, operator, lpRegistrar, admin);

  await seed(ledger, operator, lpRegistrar, admin, trader);

  const backend = new OperatorBackend({
    ledger,
    registry: new StubRegistry(),
    operatorParty: operator,
  });

  // The dev server seeds bare-hint parties (e.g. "trader-demo"). When the
  // dev-open write bypass is active, allow those bare parties by default so the
  // demo's own seeded data passes write validation without a second flag.
  // Set DEX_ALLOW_BARE_PARTIES=0 to opt out.
  const devOpen = process.env.DEX_OPERATOR_API_TOKEN
    ? false
    : process.env.DEX_DEV_OPEN === "1";
  if (devOpen && process.env.DEX_ALLOW_BARE_PARTIES === undefined) {
    process.env.DEX_ALLOW_BARE_PARTIES = "1";
  }

  const port = Number(process.env.PORT ?? 8080);
  const { url } = await startHttpServer({
    backend,
    port,
    host: "127.0.0.1",
    context: {
      operator,
      lpRegistrar,
      admin,
      // A sentinel consumed by the dApp shell so the seeded preview can never
      // look like a synchronized Canton environment.
      network: "preview:in-memory",
    },
    // Operator-write auth: the dev server has no token, so default to the
    // explicit dev-open bypass unless an operator token is supplied.
    operatorToken: process.env.DEX_OPERATOR_API_TOKEN,
    devOpen,
    // Wallet relay is OFF unless explicitly enabled.
    walletRelayEnabled: process.env.DEX_DEV_WALLET_RELAY === "1",
    walletRelayParties: (process.env.DEX_DEV_RELAY_PARTIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // The in-memory demo owns its seeded trader authority. Real-Canton
    // testnet-server keeps this trusted relay disabled by default.
    hostedRfqEnabled: true,
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
