// Pool_Initialize + Pool_AddLiquidity against a live Canton participant.
// Creates a fresh V2 Registry per run, registers BTC + USDC, mints seed
// holdings to the operator, then exercises the two pool choices.
// Reads CANTON_POOL_CID for an existing PS_Unfunded Pool to initialize.

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

const cfg = {
  baseUrl: required("CANTON_LEDGER_URL"),
  token: required("CANTON_LEDGER_TOKEN"),
  synchronizerId: required("CANTON_SYNCHRONIZER"),
  pkgDex: required("CANTON_DEX_PACKAGE_ID"),
  userId: process.env.CANTON_USER_ID ?? "ledger-api-user",
  venue: required("CANTON_VENUE"),
  lpRegistrar: required("CANTON_LP_REGISTRAR"),
  admin: required("CANTON_ADMIN"),
  poolCid: required("CANTON_POOL_CID"),
};

const RUN_ID = `pool-${Date.now()}`;
const BASE_AMOUNT = "1.0";
const QUOTE_AMOUNT = "30000.0";
const ADD_BASE = "0.5";        // half-size top-up
const ADD_QUOTE = "15000.0";
const SWAP_INPUT = "1000.0";   // swap 1000 USDC for ~0.033 BTC at parity
const SUPPLY_CAP = "1000000000.0";

interface CreatedEvent {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
}
type Event = { CreatedEvent: CreatedEvent } | { ArchivedEvent: { contractId: string } };
interface TxResponse { transaction: { updateId: string; offset: number; events: Event[] } }

async function submit(actAs: string[], commandId: string, commands: unknown[]): Promise<TxResponse> {
  const body = {
    commands: { commandId, userId: cfg.userId, actAs, synchronizerId: cfg.synchronizerId, commands },
    transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
  };
  const res = await fetch(`${cfg.baseUrl}/v2/commands/submit-and-wait-for-transaction`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`submit ${commandId} → HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as TxResponse;
}

function findCreates(tx: TxResponse, suffix: string): CreatedEvent[] {
  return tx.transaction.events
    .filter((e): e is { CreatedEvent: CreatedEvent } => "CreatedEvent" in e)
    .map((e) => e.CreatedEvent)
    .filter((c) => c.templateId.endsWith(suffix));
}

const tid = (pkg: string, modEnt: string) => `${pkg}:${modEnt}`;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n=== ${name} ===`);
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`✓ ${name} (${Date.now() - t0}ms)`);
    return out;
  } catch (e) {
    console.error(`✗ ${name}: ${(e as Error).message}`);
    throw e;
  }
}

async function findActiveHoldings(party: string, instrumentId: string): Promise<string[]> {
  const endRes = await fetch(`${cfg.baseUrl}/v2/state/ledger-end`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  const { offset } = (await endRes.json()) as { offset: number };
  const res = await fetch(`${cfg.baseUrl}/v2/state/active-contracts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      verbose: false,
      activeAtOffset: offset,
      filter: {
        filtersByParty: {
          [party]: {
            cumulative: [
              {
                identifierFilter: {
                  TemplateFilter: {
                    value: {
                      templateId: `#canton-dex-trading:CantonDex.Registry.V2:Holding`,
                      includeCreatedEventBlob: false,
                    },
                  },
                },
              },
            ],
          },
        },
      },
    }),
  });
  const acs = (await res.json()) as Array<{ contractEntry?: { JsActiveContract?: { createdEvent?: CreatedEvent } } }>;
  return acs
    .map((e) => e.contractEntry?.JsActiveContract?.createdEvent)
    .filter((ev): ev is CreatedEvent => ev !== undefined)
    .filter((ev) => {
      const p = ev.createArgument as { owner: string; instrumentId: string };
      return p.owner === party && p.instrumentId === instrumentId;
    })
    .map((ev) => ev.contractId);
}

async function main() {
  console.log(`run id: ${RUN_ID}`);
  console.log(`venue (operator): ${cfg.venue}`);
  console.log(`admin (issuer):   ${cfg.admin}`);
  console.log(`lpRegistrar:      ${cfg.lpRegistrar}`);
  console.log(`pool cid:         ${cfg.poolCid.slice(0, 24)}…`);

  const registryCid = await step("create Registry (V2 AllocationFactory)", async () => {
    const tx = await submit([cfg.admin], `${RUN_ID}-reg`, [
      {
        CreateCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Registry.V2:Registry"),
          createArguments: { admin: cfg.admin, users: [cfg.venue, cfg.lpRegistrar] },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Registry.V2:Registry")[0]!.contractId;
  });

  const btcConfigCid = await step("Registry_RegisterInstrument BTC", async () => {
    const tx = await submit([cfg.admin], `${RUN_ID}-reg-btc`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Registry.V2:Registry"),
          contractId: registryCid,
          choice: "Registry_RegisterInstrument",
          choiceArgument: {
            instrumentId: "BTC",
            decimals: "8",
            supplyCap: SUPPLY_CAP,
            holderRequirements: [],
            issuerRequirements: [],
            isin: null,
            cusip: null,
          },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Registry.V2:InstrumentConfig")[0]!.contractId;
  });
  const usdcConfigCid = await step("Registry_RegisterInstrument USDC", async () => {
    const tx = await submit([cfg.admin], `${RUN_ID}-reg-usdc`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Registry.V2:Registry"),
          contractId: registryCid,
          choice: "Registry_RegisterInstrument",
          choiceArgument: {
            instrumentId: "USDC",
            decimals: "6",
            supplyCap: SUPPLY_CAP,
            holderRequirements: [],
            issuerRequirements: [],
            isin: null,
            cusip: null,
          },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Registry.V2:InstrumentConfig")[0]!.contractId;
  });

  // Registry_Mint exercises InstrumentConfig_BumpSupply (consuming) so
  // the config CID rotates each mint. Track the latest.
  let curBtcConfigCid = btcConfigCid;
  let curUsdcConfigCid = usdcConfigCid;

  const btcHoldingCid = await step(`Registry_Mint ${BASE_AMOUNT} BTC → operator`, async () => {
    const tx = await submit([cfg.admin, cfg.venue], `${RUN_ID}-mint-btc`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Registry.V2:Registry"),
          contractId: registryCid,
          choice: "Registry_Mint",
          choiceArgument: {
            configCid: curBtcConfigCid,
            owner: cfg.venue,
            amount: BASE_AMOUNT,
            issuerClaims: [],
          },
        },
      },
    ]);
    curBtcConfigCid = findCreates(tx, "CantonDex.Registry.V2:InstrumentConfig")[0]!.contractId;
    return findCreates(tx, "CantonDex.Registry.V2:Holding")[0]!.contractId;
  });
  const usdcHoldingCid = await step(`Registry_Mint ${QUOTE_AMOUNT} USDC → operator`, async () => {
    const tx = await submit([cfg.admin, cfg.venue], `${RUN_ID}-mint-usdc`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Registry.V2:Registry"),
          contractId: registryCid,
          choice: "Registry_Mint",
          choiceArgument: {
            configCid: curUsdcConfigCid,
            owner: cfg.venue,
            amount: QUOTE_AMOUNT,
            issuerClaims: [],
          },
        },
      },
    ]);
    curUsdcConfigCid = findCreates(tx, "CantonDex.Registry.V2:InstrumentConfig")[0]!.contractId;
    return findCreates(tx, "CantonDex.Registry.V2:Holding")[0]!.contractId;
  });

  await step("pre-state: operator has 1 BTC + 30000 USDC holdings", async () => {
    const btc = await findActiveHoldings(cfg.venue, "BTC");
    const usdc = await findActiveHoldings(cfg.venue, "USDC");
    console.log(`  operator BTC holdings: ${btc.length}`);
    console.log(`  operator USDC holdings: ${usdc.length}`);
    if (btc.length === 0 || usdc.length === 0) throw new Error("operator should hold seed liquidity pre-init");
  });

  const initResult = await step("Pool_Initialize (PS_Unfunded → PS_Active)", async () => {
    const tx = await submit([cfg.venue, cfg.lpRegistrar, cfg.admin], `${RUN_ID}-pool-init`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Dex.Pool:Pool"),
          contractId: cfg.poolCid,
          choice: "Pool_Initialize",
          choiceArgument: {
            recipient: cfg.lpRegistrar,
            baseFactoryCid: registryCid,
            quoteFactoryCid: registryCid,
            baseHoldingCids: [btcHoldingCid],
            quoteHoldingCids: [usdcHoldingCid],
            baseAmount: BASE_AMOUNT,
            quoteAmount: QUOTE_AMOUNT,
            requestedAt: new Date().toISOString(),
            lpPolicyCid: null,
          },
        },
      },
    ]);
    const newPool = findCreates(tx, "CantonDex.Dex.Pool:Pool")[0];
    const allocs = findCreates(tx, "CantonDex.Registry.V2:Allocation");
    const lpMintReq = findCreates(tx, "CantonDex.Dex.LP:LPMintRequest")[0];
    return {
      newPoolCid: newPool?.contractId,
      newPoolStatus: (newPool?.createArgument as { status: string }).status,
      allocCount: allocs.length,
      lpMintReqCid: lpMintReq?.contractId,
    };
  });

  console.log(`  Pool transitioned: PS_Unfunded → ${initResult.newPoolStatus}`);
  console.log(`  V2 allocations created: ${initResult.allocCount} (one per leg: base + quote)`);
  console.log(`  Active pool CID: ${initResult.newPoolCid?.slice(0, 24)}…`);

  // Pool_AddLiquidity. knownTotalLpSupply is sqrt(base * quote) from init.
  let activePoolCid = initResult.newPoolCid!;
  const knownLpSupply = Math.sqrt(parseFloat(BASE_AMOUNT) * parseFloat(QUOTE_AMOUNT)).toFixed(10);

  const addBtcHoldingCid = await step(`Registry_Mint ${ADD_BASE} BTC → operator (add LP)`, async () => {
    const tx = await submit([cfg.admin, cfg.venue], `${RUN_ID}-mint-btc2`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Registry.V2:Registry"),
          contractId: registryCid,
          choice: "Registry_Mint",
          choiceArgument: {
            configCid: curBtcConfigCid,
            owner: cfg.venue,
            amount: ADD_BASE,
            issuerClaims: [],
          },
        },
      },
    ]);
    curBtcConfigCid = findCreates(tx, "CantonDex.Registry.V2:InstrumentConfig")[0]!.contractId;
    return findCreates(tx, "CantonDex.Registry.V2:Holding")[0]!.contractId;
  });
  const addUsdcHoldingCid = await step(`Registry_Mint ${ADD_QUOTE} USDC → operator (add LP)`, async () => {
    const tx = await submit([cfg.admin, cfg.venue], `${RUN_ID}-mint-usdc2`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Registry.V2:Registry"),
          contractId: registryCid,
          choice: "Registry_Mint",
          choiceArgument: {
            configCid: curUsdcConfigCid,
            owner: cfg.venue,
            amount: ADD_QUOTE,
            issuerClaims: [],
          },
        },
      },
    ]);
    curUsdcConfigCid = findCreates(tx, "CantonDex.Registry.V2:InstrumentConfig")[0]!.contractId;
    return findCreates(tx, "CantonDex.Registry.V2:Holding")[0]!.contractId;
  });

  const addResult = await step("Pool_AddLiquidity (+0.5 BTC, +15K USDC)", async () => {
    const tx = await submit([cfg.venue, cfg.lpRegistrar, cfg.admin], `${RUN_ID}-pool-add`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Dex.Pool:Pool"),
          contractId: activePoolCid,
          choice: "Pool_AddLiquidity",
          choiceArgument: {
            recipient: cfg.lpRegistrar,
            baseFactoryCid: registryCid,
            quoteFactoryCid: registryCid,
            baseHoldingCids: [addBtcHoldingCid],
            quoteHoldingCids: [addUsdcHoldingCid],
            baseAmount: ADD_BASE,
            quoteAmount: ADD_QUOTE,
            minLpTokens: "0.0",
            knownTotalLpSupply: knownLpSupply,
            requestedAt: new Date().toISOString(),
            lpPolicyCid: null,
          },
        },
      },
    ]);
    const newPool = findCreates(tx, "CantonDex.Dex.Pool:Pool")[0];
    const allocs = findCreates(tx, "CantonDex.Registry.V2:Allocation");
    activePoolCid = newPool!.contractId;
    const r = newPool!.createArgument as { reserves: { baseAmount: string; quoteAmount: string }; baseSlices: unknown[] };
    return {
      newReserves: r.reserves,
      sliceCount: r.baseSlices.length,
      newAllocs: allocs.length,
    };
  });
  console.log(`  Reserves: ${addResult.newReserves.baseAmount} BTC / ${addResult.newReserves.quoteAmount} USDC, ${addResult.sliceCount} slice(s) per side`);
  console.log(`run-id: ${RUN_ID}`);
}

main().catch((err) => {
  console.error("\n❌ pool demo FAILED:", err);
  process.exit(1);
});
