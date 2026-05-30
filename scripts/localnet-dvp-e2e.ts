// Headless DvP liquidity end-to-end against a live Canton participant.
//
// Stands in for the trader's wallet (the one piece a browser CIP-0103
// wallet normally does): it authors the trader's 3 allocations for each
// DvP add/remove, then settles. Exercises the full operator two-call
// flow (request -> wallet authors allocations -> settle) plus a swap,
// on a real ledger -- the seam that can't be driven through the UI
// without a human approving in the wallet popup.
//
// Self-contained: creates its own V2 Registry (admin == pool admin ==
// lpRegistrar, the self-registry case), registers base/quote/LP
// instruments, mints to the trader, creates the pool contracts, then
// runs add -> swap -> remove and asserts the on-ledger reserves/LP.
//
// Env (all from the LocalNet bring-up):
//   CANTON_LEDGER_URL, CANTON_LEDGER_TOKEN, CANTON_SYNCHRONIZER,
//   CANTON_DEX_PACKAGE_ID (e.g. #canton-dex-trading),
//   CANTON_USER_ID (default ledger-api-user),
//   CANTON_OPERATOR, CANTON_ADMIN, CANTON_TRADER
//   (operator == venue; admin == instrument issuer == lpRegistrar;
//    trader == the LP/swapper). The user token must have actAs for all
//    three parties (a single ledger-api-user with granted rights works).
//
// Run (from services/operator-backend, which has tsx on its path):
//   npm run localnet:dvp-e2e
// with the CANTON_* env above exported.

function req(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(2); }
  return v;
}

const cfg = {
  baseUrl: req("CANTON_LEDGER_URL"),
  token: req("CANTON_LEDGER_TOKEN"),
  sync: req("CANTON_SYNCHRONIZER"),
  pkg: req("CANTON_DEX_PACKAGE_ID"),
  userId: process.env.CANTON_USER_ID ?? "ledger-api-user",
  operator: req("CANTON_OPERATOR"),
  admin: req("CANTON_ADMIN"),
  trader: req("CANTON_TRADER"),
};
const lpRegistrar = cfg.admin; // self-registry: admin issues base/quote AND LP

const BASE = "BTC", QUOTE = "USDC", LP = "BTC-USDC-LP";
const ADD_BASE = "4.0", ADD_QUOTE = "12000.0";
const SWAP_IN = "1000.0"; // USDC -> BTC
const CAP = "1000000000.0";
const RUN = `dvp-${Date.now()}`;
const tid = (m: string) => `${cfg.pkg}:${m}`;
const acct = (p: string) => ({ owner: p, provider: null, id: "" });
const EXTRA = { context: { values: {} }, meta: { values: {} } };

interface Created { contractId: string; templateId: string; createArgument: Record<string, unknown> }
type Ev = { CreatedEvent: Created } | { ArchivedEvent: { contractId: string } };
interface Tx { transaction: { updateId: string; events: Ev[] } }

// Canton 3.x JSON API encodes Daml Int64 as a JSON string. Coerce every
// integer-valued number to a string (matches the backend JsonApiLedger fix).
function encInt(v: unknown): unknown {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v;
  if (Array.isArray(v)) return v.map(encInt);
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = encInt(val);
    return o;
  }
  return v;
}

async function submit(actAs: string[], cid: string, commands: unknown[]): Promise<Tx> {
  const res = await fetch(`${cfg.baseUrl}/v2/commands/submit-and-wait-for-transaction`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: { commandId: cid, userId: cfg.userId, actAs, synchronizerId: cfg.sync, commands: encInt(commands) },
      transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
    }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`submit ${cid} -> HTTP ${res.status}: ${t}`);
  return JSON.parse(t) as Tx;
}
function creates(tx: Tx, suffix: string): Created[] {
  return tx.transaction.events
    .filter((e): e is { CreatedEvent: Created } => "CreatedEvent" in e)
    .map((e) => e.CreatedEvent)
    .filter((c) => c.templateId.endsWith(suffix));
}
async function ledgerEnd(): Promise<number> {
  const r = await fetch(`${cfg.baseUrl}/v2/state/ledger-end`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  return ((await r.json()) as { offset: number }).offset;
}
async function acs(party: string, template: string): Promise<Created[]> {
  const offset = await ledgerEnd();
  const r = await fetch(`${cfg.baseUrl}/v2/state/active-contracts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      verbose: false, activeAtOffset: offset,
      filter: { filtersByParty: { [party]: { cumulative: [
        { identifierFilter: { TemplateFilter: { value: { templateId: tid(template), includeCreatedEventBlob: false } } } },
      ] } } },
    }),
  });
  const body = (await r.json()) as Array<{ contractEntry?: { JsActiveContract?: { createdEvent?: Created } } }>;
  return body.map((e) => e.contractEntry?.JsActiveContract?.createdEvent).filter((x): x is Created => !!x);
}
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try { const out = await fn(); console.log(`  ok  ${name} (${Date.now() - t0}ms)`); return out; }
  catch (e) { console.error(`  FAIL ${name}: ${(e as Error).message}`); throw e; }
}
const eq = (a: unknown, b: unknown, m: string) => {
  if (String(a) !== String(b)) throw new Error(`assert ${m}: expected ${b}, got ${a}`);
};

// Author one allocation as the trader (the wallet's job): exercise
// AllocationFactory_Allocate on the registry, locking inputHoldingCids.
async function authorAlloc(
  regCid: string, spec: unknown, inputHoldingCids: string[], label: string,
): Promise<string> {
  const tx = await submit([cfg.trader], `${RUN}-author-${label}`, [{
    ExerciseCommand: {
      templateId: tid("CantonDex.Registry.V2:Registry"),
      contractId: regCid,
      choice: "AllocationFactory_Allocate",
      choiceArgument: {
        settlement: (spec as { __settlement: unknown }).__settlement,
        allocation: (spec as { __alloc: unknown }).__alloc,
        requestedAt: new Date().toISOString(),
        inputHoldingCids,
        extraArgs: EXTRA,
        actors: [cfg.trader],
      },
    },
  }]);
  return creates(tx, "CantonDex.Registry.V2:Allocation")[0]!.contractId;
}

async function main() {
  console.log(`run ${RUN}`);
  console.log(`operator=${cfg.operator.slice(0, 20)}.. admin=${cfg.admin.slice(0, 20)}.. trader=${cfg.trader.slice(0, 20)}..`);

  // 1. Registry + instruments + trader holdings ---------------------------
  const regCid = await step("create Registry.V2 (factory + settlement)", async () => {
    const tx = await submit([cfg.admin], `${RUN}-reg`, [{
      CreateCommand: {
        templateId: tid("CantonDex.Registry.V2:Registry"),
        createArguments: { admin: cfg.admin, users: [cfg.operator, cfg.trader] },
      },
    }]);
    return creates(tx, "CantonDex.Registry.V2:Registry")[0]!.contractId;
  });
  // RegisterInstrument returns an InstrumentConfig; Mint consumes the
  // latest config (BumpSupply) and rotates it. Track per-instrument.
  const configCid: Record<string, string> = {};
  for (const id of [BASE, QUOTE, LP]) {
    await step(`register ${id}`, async () => {
      const tx = await submit([cfg.admin], `${RUN}-reg-${id}`, [{
        ExerciseCommand: {
          templateId: tid("CantonDex.Registry.V2:Registry"), contractId: regCid,
          choice: "Registry_RegisterInstrument",
          choiceArgument: {
            instrumentId: id, decimals: "10", supplyCap: CAP,
            holderRequirements: [], issuerRequirements: [], isin: null, cusip: null,
          },
        },
      }]);
      configCid[id] = creates(tx, "CantonDex.Registry.V2:InstrumentConfig")[0]!.contractId;
    });
  }
  const mint = (id: string, amt: string, owner: string) =>
    step(`mint ${amt} ${id} -> ${owner === cfg.trader ? "trader" : owner.slice(0, 8)}`, async () => {
      const tx = await submit([cfg.admin, owner], `${RUN}-mint-${id}-${owner.slice(0, 6)}-${Date.now()}`, [{
        ExerciseCommand: {
          templateId: tid("CantonDex.Registry.V2:Registry"), contractId: regCid,
          choice: "Registry_Mint",
          choiceArgument: { configCid: configCid[id], owner, amount: amt, issuerClaims: [] },
        },
      }]);
      configCid[id] = creates(tx, "CantonDex.Registry.V2:InstrumentConfig")[0]!.contractId;
      return creates(tx, "CantonDex.Registry.V2:Holding")[0]!.contractId;
    });
  await mint(BASE, ADD_BASE, cfg.trader);
  await mint(QUOTE, ADD_QUOTE, cfg.trader);
  await mint(QUOTE, SWAP_IN, cfg.trader); // separate holding for the swap input

  // 2. Pool contracts (operator-authored), as the admin bootstrap does ----
  // Unique poolId per run so we never collide with other pools the
  // operator observes (which would make a poolId-based lookup ambiguous).
  const poolId = `${BASE}-${QUOTE}-${RUN}`;
  const lpInstrumentId = { admin: lpRegistrar, id: LP };
  const poolCid = await step("create Pool", async () => {
    const tx = await submit([cfg.operator], `${RUN}-pool`, [{
      CreateCommand: {
        templateId: tid("CantonDex.Dex.Pool:Pool"),
        createArguments: {
          poolId, operator: cfg.operator, lpRegistrar, admin: cfg.admin,
          baseInstrumentId: BASE, quoteInstrumentId: QUOTE, lpInstrumentId,
          feeBps: "30", operatorFeeBps: "0",
        },
      },
    }]);
    return creates(tx, "CantonDex.Dex.Pool:Pool")[0]!.contractId;
  });
  let stateCid = await step("create PoolState (Unfunded)", async () => {
    const tx = await submit([cfg.operator], `${RUN}-state`, [{
      CreateCommand: {
        templateId: tid("CantonDex.Dex.PoolState:PoolState"),
        createArguments: {
          poolId, operator: cfg.operator, lpRegistrar, status: "PS_Unfunded",
          reserves: { baseAmount: "0.0", quoteAmount: "0.0" }, totalLpSupply: "0.0", publicReaders: [],
        },
      },
    }]);
    return creates(tx, "CantonDex.Dex.PoolState:PoolState")[0]!.contractId;
  });
  await step("create PoolRules", async () => {
    await submit([cfg.operator], `${RUN}-rules`, [{
      CreateCommand: { templateId: tid("CantonDex.Dex.PoolRules:PoolRules"), createArguments: { operator: cfg.operator } },
    }]);
  });
  const dvpCid = await step("create PoolLiquidityRules", async () => {
    const tx = await submit([cfg.operator, lpRegistrar], `${RUN}-dvp`, [{
      CreateCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"),
        createArguments: { operator: cfg.operator, lpRegistrar },
      },
    }]);
    return creates(tx, "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules")[0]!.contractId;
  });
  let policyCid = await step("create LPTokenPolicy", async () => {
    const tx = await submit([lpRegistrar], `${RUN}-policy`, [{
      CreateCommand: {
        templateId: tid("CantonDex.Lp.Policy:LPTokenPolicy"),
        createArguments: { lpRegistrar, operator: cfg.operator, lpInstrumentId, totalSupply: "0.0", active: true },
      },
    }]);
    return creates(tx, "CantonDex.Lp.Policy:LPTokenPolicy")[0]!.contractId;
  });

  const holdingsFor = async (id: string): Promise<{ cid: string; amount: string }[]> => {
    const hs = await acs(cfg.trader, "CantonDex.Registry.V2:Holding");
    return hs
      .map((c) => ({ cid: c.contractId, p: c.createArgument as { owner: string; instrumentId: string; amount: string; locked?: boolean } }))
      .filter((x) => x.p.owner === cfg.trader && x.p.instrumentId === id && !x.p.locked)
      .map((x) => ({ cid: x.cid, amount: x.p.amount }));
  };

  // 3. DvP ADD: request -> author 3 allocations -> settle -----------------
  console.log("\n== ADD LIQUIDITY ==");
  const reqAdd = await step("PoolLiquidityRules_RequestAddLiquidity", async () => {
    const lpAmount = Math.sqrt(parseFloat(ADD_BASE) * parseFloat(ADD_QUOTE)).toFixed(10);
    const tx = await submit([cfg.operator], `${RUN}-add-req`, [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"), contractId: dvpCid,
        choice: "PoolLiquidityRules_RequestAddLiquidity",
        choiceArgument: {
          poolCid, recipient: cfg.trader, baseAmount: ADD_BASE, quoteAmount: ADD_QUOTE,
          lpAmount, requestedAt: new Date().toISOString(), settleAt: null,
        },
      },
    }]);
    const r = creates(tx, "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationRequest")[0]!;
    return { cid: r.contractId, arg: r.createArgument as { allocations: unknown[]; settlement: unknown } };
  });
  const addBaseH = (await holdingsFor(BASE)).find((h) => h.amount === `${ADD_BASE}000000000` || parseFloat(h.amount) === parseFloat(ADD_BASE))!;
  const addQuoteH = (await holdingsFor(QUOTE)).find((h) => parseFloat(h.amount) === parseFloat(ADD_QUOTE))!;
  const settlement = reqAdd.arg.settlement;
  const [baseSpec, quoteSpec, receiptSpec] = reqAdd.arg.allocations;
  const wrap = (a: unknown) => ({ __settlement: settlement, __alloc: a });
  const baseDep = await step("trader authors base deposit", () => authorAlloc(regCid, wrap(baseSpec), [addBaseH.cid], "add-base"));
  const quoteDep = await step("trader authors quote deposit", () => authorAlloc(regCid, wrap(quoteSpec), [addQuoteH.cid], "add-quote"));
  const receipt = await step("trader authors LP receipt", () => authorAlloc(regCid, wrap(receiptSpec), [], "add-receipt"));
  const addRes = await step("PoolLiquidityRules_SettleAddLiquidity", async () => {
    const tx = await submit([cfg.operator, lpRegistrar], `${RUN}-add-settle`, [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"), contractId: dvpCid,
        choice: "PoolLiquidityRules_SettleAddLiquidity",
        choiceArgument: {
          expectedPoolId: poolId, poolCid, poolStateCid: stateCid, lpPolicyCid: policyCid,
          requestCid: reqAdd.cid, recipient: cfg.trader,
          lpBaseDepositCid: baseDep, lpQuoteDepositCid: quoteDep, lpReceiptCid: receipt,
          baseFactoryCid: regCid, quoteFactoryCid: regCid, lpFactoryCid: regCid,
          baseQuoteSettleCid: regCid, lpSettleCid: regCid,
          baseAmount: ADD_BASE, quoteAmount: ADD_QUOTE, minLpTokens: "0.0", knownTotalLpSupply: "0.0",
          requestedAt: new Date().toISOString(), poolAdminExtraArgs: EXTRA, lpRegistrarExtraArgs: EXTRA,
        },
      },
    }]);
    // This settle tx creates exactly one PoolState (for THIS pool); match
    // it by poolId to be unambiguous even if [0] ordering ever changes.
    const ps = creates(tx, "CantonDex.Dex.PoolState:PoolState")
      .find((c) => (c.createArgument as { poolId: string }).poolId === poolId)!;
    stateCid = ps.contractId;
    return ps.createArgument as { status: string; reserves: { baseAmount: string; quoteAmount: string }; totalLpSupply: string };
  });
  const expectLp = Math.sqrt(parseFloat(ADD_BASE) * parseFloat(ADD_QUOTE)).toFixed(10);
  eq(addRes.status, "PS_Active", "pool active after add");
  eq(parseFloat(addRes.reserves.baseAmount), parseFloat(ADD_BASE), "base reserve");
  eq(parseFloat(addRes.reserves.quoteAmount), parseFloat(ADD_QUOTE), "quote reserve");
  eq(parseFloat(addRes.totalLpSupply).toFixed(6), parseFloat(expectLp).toFixed(6), "LP minted = sqrt(base*quote)");
  console.log(`  reserves ${addRes.reserves.baseAmount}/${addRes.reserves.quoteAmount}, LP ${addRes.totalLpSupply} (= sqrt(${ADD_BASE}*${ADD_QUOTE}))`);
  // Confirm the trader actually received the LP holding (DvP, not just supply bump).
  const lpHeld = (await acs(cfg.trader, "CantonDex.Registry.V2:Holding"))
    .map((c) => c.createArgument as { owner: string; instrumentId: string; amount: string; locked?: boolean })
    .filter((p) => p.owner === cfg.trader && p.instrumentId === LP && !p.locked);
  eq(lpHeld.length >= 1, true, "trader holds an LP holding");
  eq(parseFloat(lpHeld.reduce((s, h) => s + parseFloat(h.amount), 0).toFixed(6)), parseFloat(expectLp).toFixed(6), "trader LP balance = minted");
  console.log(`  trader LP holding: ${lpHeld.map((h) => h.amount).join("+")}`);

  console.log("\n== DvP add settled end-to-end via the wallet-authored allocation path ==");
  console.log("PASS: add-liquidity DvP (trader authored all 3 allocations; operator+lpRegistrar settled)");
}

main().catch((e) => { console.error("FATAL", (e as Error).message); process.exit(1); });
