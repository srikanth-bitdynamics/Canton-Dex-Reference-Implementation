// Headless AMM liquidity round trip against a live Canton participant.
//
// Stands in for the trader's wallet (the one piece a browser CIP-0103
// wallet normally does): it authors the trader's allocations and drives a
// self-contained add -> swap -> partial remove through the JSON Ledger API.
//
// It does NOT exercise the operator HTTP server, dApp, a real wallet transport,
// or browser authentication. Those boundaries need separate tests.
//
// Self-contained: creates its own V2 Registry (admin == pool admin ==
// lpRegistrar, the self-registry case), registers base/quote/LP
// instruments, mints to the LP and swapper, creates the pool contracts, then:
//   1. adds liquidity and asserts reserves + LP supply/holding;
//   2. swaps quote -> base and asserts exact balances/reserves + x*y;
//   3. redeems half the LP position and asserts returned balances, remaining
//      reserves/slices/supply, and reserve-per-LP invariants.
//
// STATE WARNING: a successful or partially failed run leaves contracts on the
// participant. Use a throwaway LocalNet. The unique `dvp-<timestamp>` run id
// printed at startup identifies the pool and command ids left by this run.
//
// Env:
//   CANTON_LEDGER_URL, CANTON_LEDGER_TOKEN,
//   CANTON_DEX_PACKAGE_ID (e.g. #canton-dex-trading-v2),
//   CANTON_ALLOC_INSTR_PACKAGE_ID
//     (e.g. #splice-api-token-allocation-instruction-v2),
//   CANTON_USER_ID (default ledger-api-user),
//   CANTON_SYNCHRONIZER (optional; omit to let a single-synchronizer
//     participant route the submission),
//   CANTON_OPERATOR, CANTON_ADMIN, CANTON_TRADER,
//   CANTON_SWAPPER (optional; defaults to CANTON_TRADER)
//   (operator == venue; admin == instrument issuer == lpRegistrar;
//    trader == the LP). A full round trip requires swapper != operator because
//    a swap cannot contain self-transfer legs. The token must have actAs for
//    every distinct configured party.
//
// Run from services/operator-backend (which has tsx on its path):
//   npm run live:roundtrip       # add -> swap -> partial remove
//   npm run live:add-liquidity   # add only; still needs trader != operator

import * as dec from "../services/operator-backend/src/pool/decimal.js";

function req(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(2); }
  return v;
}

const trader = req("CANTON_TRADER");
const cfg = {
  baseUrl: req("CANTON_LEDGER_URL"),
  token: req("CANTON_LEDGER_TOKEN"),
  sync: process.env.CANTON_SYNCHRONIZER || undefined,
  pkg: req("CANTON_DEX_PACKAGE_ID"),
  userId: process.env.CANTON_USER_ID ?? "ledger-api-user",
  operator: req("CANTON_OPERATOR"),
  admin: req("CANTON_ADMIN"),
  trader,
  swapper: process.env.CANTON_SWAPPER ?? trader,
  // AllocationFactory_Allocate is a token-standard INTERFACE choice; it must
  // be exercised against the interface id (alloc-instruction-v2 package),
  // not the concrete Registry template.
  pkgAllocInstr: req("CANTON_ALLOC_INSTR_PACKAGE_ID"),
};
const lpRegistrar = cfg.admin; // self-registry: admin issues base/quote AND LP
// Distinct settlement admins for a DvP add/remove batch: the asset admin and
// the LP registrar. They collapse to one key when they are the same party, so
// batchesByAdmin has exactly one entry per distinct admin the pool settles.
const settleAdmins = [...new Set([cfg.admin, lpRegistrar])];

const RUN = `dvp-${Date.now()}`;
const BASE = "BTC", QUOTE = "USDC", LP = `BTC-USDC-LP-${RUN}`;
const ADD_BASE = "4.0", ADD_QUOTE = "12000.0";
const SWAP_IN = "1000.0"; // USDC -> BTC
const FEE_BPS = 30;
const CAP = "1000000000.0";
const ADD_ONLY = process.argv.includes("--add-only");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--add-only");
if (unknownArgs.length > 0) {
  console.error(`unknown argument(s): ${unknownArgs.join(", ")}`);
  process.exit(2);
}
if (cfg.trader === cfg.operator) {
  console.error(
    "liquidity flow requires CANTON_TRADER != CANTON_OPERATOR because a deposit cannot self-transfer",
  );
  process.exit(2);
}
if (!ADD_ONLY && cfg.swapper === cfg.operator) {
  console.error(
    "full round trip requires CANTON_SWAPPER != CANTON_OPERATOR; " +
      "use a second sandbox party or pass --add-only",
  );
  process.exit(2);
}
const tid = (m: string) => `${cfg.pkg}:${m}`;
const acct = (p: string) => ({ owner: p, provider: null, id: "" });
const EXTRA = { context: { values: {} }, meta: { values: {} } };

interface Created { contractId: string; templateId: string; createArgument: Record<string, unknown> }
interface Exercised { choice: string; exerciseResult: unknown }
type Ev =
  | { CreatedEvent: Created }
  | { ArchivedEvent: { contractId: string } }
  | { ExercisedEvent: Exercised };
interface Tx { transaction: { updateId: string; events: Ev[] } }
interface PoolStateArg {
  poolId: string;
  status: string;
  reserves: { baseAmount: string; quoteAmount: string };
  totalLpSupply: string;
}
interface SliceArg { poolId: string; operator: string; side: string; amount: string }
interface HoldingArg {
  admin: string; owner: string; instrumentId: string; amount: string; locked?: boolean;
}
interface RequestArg { allocations: unknown[]; settlement: unknown }
interface PolicyArg { totalSupply: string; lpInstrumentId: { admin: string; id: string } }
interface SwapRequestResult {
  settlement: unknown;
  allocationSpecs: unknown[];
  swapRequestCid: string;
  quoteBinding: SwapQuoteBinding | null;
}
interface AddAllocationPlan { baseReceiver: unknown; quoteReceiver: unknown; lpMintSender: unknown }
interface RemoveAllocationPlan { lpBurnReceiver: unknown }
// A RegistryBatchInput: the settlement factory + choice context for one admin.
type RegistryBatchInput = { factoryCid: string; extraArgs: typeof EXTRA };
interface SwapQuoteBinding {
  expectedPoolId: string;
  poolStateCid: string;
  inputSliceCid: string;
  outputSliceCids: string[];
  minOutputAmount: string;
}

const argOf = <T>(created: Created): T => created.createArgument as unknown as T;

function only<T>(values: T[], what: string): T {
  if (values.length !== 1) {
    throw new Error(`expected exactly 1 ${what}, found ${values.length}`);
  }
  return values[0]!;
}

// Canton 3.x JSON API encodes Daml Int64 as a JSON string. Coerce every
// integer-valued number before submission.
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

async function submit(
  actAs: string[], cid: string, commands: unknown[], readAs: string[] = [],
): Promise<Tx> {
  const uniqueActAs = [...new Set(actAs)];
  const uniqueReadAs = [...new Set(readAs)].filter((party) => !uniqueActAs.includes(party));
  const res = await fetch(`${cfg.baseUrl}/v2/commands/submit-and-wait-for-transaction`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: {
        commandId: cid,
        userId: cfg.userId,
        actAs: uniqueActAs,
        ...(uniqueReadAs.length > 0 ? { readAs: uniqueReadAs } : {}),
        ...(cfg.sync ? { synchronizerId: cfg.sync } : {}),
        commands: encInt(commands),
      },
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
function exercisedResult(tx: Tx, choice: string): unknown {
  for (const event of tx.transaction.events) {
    if ("ExercisedEvent" in event && event.ExercisedEvent.choice === choice) {
      return event.ExercisedEvent.exerciseResult;
    }
  }
  return undefined;
}
async function treeExercisedResult(
  updateId: string, party: string, choice: string,
): Promise<unknown> {
  const url = new URL(
    `/v2/updates/transaction-tree-by-id/${encodeURIComponent(updateId)}`,
    cfg.baseUrl,
  );
  url.searchParams.append("parties", party);
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as {
    transaction?: { eventsById?: Record<string, { ExercisedTreeEvent?: { value?: Exercised } }> };
  };
  for (const event of Object.values(body.transaction?.eventsById ?? {})) {
    const exercised = event.ExercisedTreeEvent?.value;
    if (exercised?.choice === choice) return exercised.exerciseResult;
  }
  return undefined;
}
async function ledgerEnd(): Promise<number> {
  const r = await fetch(`${cfg.baseUrl}/v2/state/ledger-end`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!r.ok) throw new Error(`ledger end -> HTTP ${r.status}: ${await r.text()}`);
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
  if (!r.ok) throw new Error(`ACS ${template} -> HTTP ${r.status}: ${await r.text()}`);
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
const eqDec = (a: bigint, b: bigint, m: string) => {
  if (a !== b) {
    throw new Error(
      `assert ${m}: expected ${dec.formatDecimal(b)}, got ${dec.formatDecimal(a)}`,
    );
  }
};
const atLeastRaw = (a: bigint, b: bigint, m: string) => {
  if (a < b) throw new Error(`assert ${m}: expected left side >= right side`);
};

const sum = (values: bigint[]): bigint => values.reduce((total, value) => total + value, 0n);

function constantProductOut(
  reserveIn: bigint, reserveOut: bigint, feeBps: number, inputAmount: bigint,
): bigint {
  const feeNumerator = dec.parseDecimal(String(10000 - feeBps));
  const feeDenominator = dec.parseDecimal("10000");
  const afterFee = dec.divFloor(
    dec.mulFloor(inputAmount, feeNumerator),
    feeDenominator,
  );
  return dec.divFloor(dec.mulFloor(afterFee, reserveOut), reserveIn + afterFee);
}

function coveringPlan(slices: Created[], target: bigint, side: string): {
  cids: string[];
  outs: string[];
} {
  let remaining = target;
  const cids: string[] = [];
  const outs: string[] = [];
  for (const slice of slices) {
    if (remaining <= 0n) break;
    const amount = dec.parseDecimal(argOf<SliceArg>(slice).amount);
    const drawn = amount < remaining ? amount : remaining;
    cids.push(slice.contractId);
    outs.push(dec.formatDecimal(drawn));
    remaining -= drawn;
  }
  if (remaining > 0n) {
    throw new Error(
      `${side} slices cannot cover ${dec.formatDecimal(target)}; short ${dec.formatDecimal(remaining)}`,
    );
  }
  return { cids, outs };
}

// Author one allocation as the trader (the wallet's job): exercise
// AllocationFactory_Allocate on the registry, locking inputHoldingCids.
async function authorAlloc(
  regCid: string,
  party: string,
  settlement: unknown,
  allocation: unknown,
  inputHoldingCids: string[],
  label: string,
): Promise<string> {
  const tx = await submit([party], `${RUN}-author-${label}`, [{
    ExerciseCommand: {
      templateId: `${cfg.pkgAllocInstr}:Splice.Api.Token.AllocationInstructionV2:AllocationFactory`,
      contractId: regCid,
      choice: "AllocationFactory_Allocate",
      choiceArgument: {
        settlement,
        allocation,
        requestedAt: new Date().toISOString(),
        inputHoldingCids,
        extraArgs: EXTRA,
        actors: [party],
      },
    },
  }]);
  return only(
    creates(tx, "CantonDex.Registry.V2:Allocation"),
    `${label} allocation`,
  ).contractId;
}

// Stage one operator/registrar allocation from a preview plan: the plan is a
// complete AllocationFactory_Allocate argument (settlement, spec, actors, empty
// context), so it is exercised on the registry as-is under the plan's actor.
async function authorPlanAlloc(
  regCid: string,
  actAs: string,
  plan: unknown,
  label: string,
): Promise<string> {
  const tx = await submit([actAs], `${RUN}-stage-${label}`, [{
    ExerciseCommand: {
      templateId: `${cfg.pkgAllocInstr}:Splice.Api.Token.AllocationInstructionV2:AllocationFactory`,
      contractId: regCid,
      choice: "AllocationFactory_Allocate",
      choiceArgument: plan,
    },
  }]);
  return only(
    creates(tx, "CantonDex.Registry.V2:Allocation"),
    `${label} allocation`,
  ).contractId;
}

async function holdingsFor(
  party: string,
  instrumentId: string,
): Promise<Array<{ cid: string; amount: string }>> {
  const holdings = await acs(party, "CantonDex.Registry.V2:Holding");
  return holdings
    .map((created) => ({ cid: created.contractId, arg: argOf<HoldingArg>(created) }))
    .filter(
      ({ arg }) =>
        arg.owner === party &&
        arg.admin === cfg.admin &&
        arg.instrumentId === instrumentId &&
        !arg.locked,
    )
    .map(({ cid, arg }) => ({ cid, amount: arg.amount }));
}

async function balance(party: string, instrumentId: string): Promise<bigint> {
  return sum((await holdingsFor(party, instrumentId)).map((holding) => dec.parseDecimal(holding.amount)));
}

async function poolSlices(poolId: string): Promise<{ base: Created[]; quote: Created[] }> {
  const slices = (await acs(cfg.operator, "CantonDex.Dex.PoolSlice:PoolSlice"))
    .filter((created) => {
      const arg = argOf<SliceArg>(created);
      return arg.poolId === poolId && arg.operator === cfg.operator;
    });
  return {
    base: slices.filter((created) => argOf<SliceArg>(created).side === "BaseSide"),
    quote: slices.filter((created) => argOf<SliceArg>(created).side === "QuoteSide"),
  };
}

function sliceTotal(slices: Created[]): bigint {
  return sum(slices.map((created) => dec.parseDecimal(argOf<SliceArg>(created).amount)));
}

async function reconcile(
  rulesCid: string,
  poolId: string,
  poolCid: string,
  poolStateCid: string,
): Promise<number> {
  const slices = await poolSlices(poolId);
  const sliceCids = [...slices.base, ...slices.quote].map((created) => created.contractId);
  await submit([cfg.operator], `${RUN}-reconcile-${Date.now()}`, [{
    ExerciseCommand: {
      templateId: tid("CantonDex.Dex.PoolRules:PoolRules"),
      contractId: rulesCid,
      choice: "PoolRules_ReconcileState",
      choiceArgument: { expectedPoolId: poolId, poolCid, poolStateCid, sliceCids },
    },
  }]);
  return sliceCids.length;
}

async function main() {
  console.log(`run ${RUN}`);
  console.log(
    `operator=${cfg.operator.slice(0, 20)}.. admin=${cfg.admin.slice(0, 20)}.. ` +
      `trader=${cfg.trader.slice(0, 20)}.. swapper=${cfg.swapper.slice(0, 20)}..`,
  );

  // 1. Registry + instruments + trader holdings ---------------------------
  const regCid = await step("create Registry.V2 (factory + settlement)", async () => {
    const tx = await submit([cfg.admin], `${RUN}-reg`, [{
      CreateCommand: {
        templateId: tid("CantonDex.Registry.V2:Registry"),
        createArguments: {
          admin: cfg.admin,
          users: [...new Set([cfg.operator, cfg.trader, cfg.swapper])],
        },
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
  // Snapshot unrelated unlocked inventory before this run mints anything.
  // The driver is safe to repeat on a persistent LocalNet, so conservation
  // must compare deltas instead of pretending the participant was pristine.
  const valueParties = [...new Set([cfg.trader, cfg.swapper])];
  const initialUnlockedBase = sum(
    await Promise.all(valueParties.map((party) => balance(party, BASE))),
  );
  const initialUnlockedQuote = sum(
    await Promise.all(valueParties.map((party) => balance(party, QUOTE))),
  );
  await mint(BASE, ADD_BASE, cfg.trader);
  await mint(QUOTE, ADD_QUOTE, cfg.trader);
  if (!ADD_ONLY) await mint(QUOTE, SWAP_IN, cfg.swapper);

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
          poolId, operator: cfg.operator, lpRegistrar,
          baseInstrumentId: { admin: cfg.admin, id: BASE },
          quoteInstrumentId: { admin: cfg.admin, id: QUOTE },
          lpInstrumentId,
          feeBps: "30",
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
  const rulesCid = await step("create PoolRules", async () => {
    const tx = await submit([cfg.operator], `${RUN}-rules`, [{
      CreateCommand: { templateId: tid("CantonDex.Dex.PoolRules:PoolRules"), createArguments: { operator: cfg.operator } },
    }]);
    return only(creates(tx, "CantonDex.Dex.PoolRules:PoolRules"), "PoolRules").contractId;
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

  // 3. DvP ADD: request -> author 3 allocations -> settle -----------------
  console.log("\n== ADD LIQUIDITY ==");
  const reqAdd = await step("PoolLiquidityRules_RequestAddLiquidity", async () => {
    const lpAmount = dec.formatDecimal(
      dec.sqrt(dec.mul(dec.parseDecimal(ADD_BASE), dec.parseDecimal(ADD_QUOTE))),
    );
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
  const addBaseH = (await holdingsFor(cfg.trader, BASE))
    .find((holding) => dec.parseDecimal(holding.amount) === dec.parseDecimal(ADD_BASE));
  const addQuoteH = (await holdingsFor(cfg.trader, QUOTE))
    .find((holding) => dec.parseDecimal(holding.amount) === dec.parseDecimal(ADD_QUOTE));
  if (!addBaseH || !addQuoteH) throw new Error("trader add-liquidity holdings were not found");
  const settlement = reqAdd.arg.settlement;
  const [baseSpec, quoteSpec, receiptSpec] = reqAdd.arg.allocations;
  if (!baseSpec || !quoteSpec || !receiptSpec) throw new Error("add request did not return 3 allocation specs");
  const baseDep = await step("trader authors base deposit", () =>
    authorAlloc(regCid, cfg.trader, settlement, baseSpec, [addBaseH.cid], "add-base"));
  const quoteDep = await step("trader authors quote deposit", () =>
    authorAlloc(regCid, cfg.trader, settlement, quoteSpec, [addQuoteH.cid], "add-quote"));
  const receipt = await step("trader authors LP receipt", () =>
    authorAlloc(regCid, cfg.trader, settlement, receiptSpec, [], "add-receipt"));

  // Stage the operator receiver and registrar mint allocations. The settle
  // derives the per-admin batches; the driver pre-creates the operator-side
  // allocations exactly as the backend does, so allocationContextByAdmin stays
  // empty. PreviewAddAllocations returns the exact factory arguments to author.
  const addRequestedAt = new Date().toISOString();
  const addPrep = {
    expectedPoolId: poolId, poolCid, poolStateCid: stateCid, lpPolicyCid: policyCid,
    requestCid: reqAdd.cid, acceptanceCid: null, recipient: cfg.trader,
    lpBaseDepositCid: baseDep, lpQuoteDepositCid: quoteDep, lpReceiptCid: receipt,
    baseAmount: ADD_BASE, quoteAmount: ADD_QUOTE, minLpTokens: "0.0", knownTotalLpSupply: "0.0",
  };
  const addPlan = await step("PoolLiquidityRules_PreviewAddAllocations", async () => {
    const tx = await submit([cfg.operator, lpRegistrar], `${RUN}-add-preview`, [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"), contractId: dvpCid,
        choice: "PoolLiquidityRules_PreviewAddAllocations",
        choiceArgument: { preparation: addPrep, requestedAt: addRequestedAt },
      },
    }]);
    const result = exercisedResult(tx, "PoolLiquidityRules_PreviewAddAllocations")
      ?? await treeExercisedResult(tx.transaction.updateId, cfg.operator, "PoolLiquidityRules_PreviewAddAllocations");
    if (!result) throw new Error("participant did not expose the PreviewAddAllocations result");
    return result as AddAllocationPlan;
  });
  const opBaseReceiver = await step("stage operator base receiver", () =>
    authorPlanAlloc(regCid, cfg.operator, addPlan.baseReceiver, "add-op-base"));
  const opQuoteReceiver = await step("stage operator quote receiver", () =>
    authorPlanAlloc(regCid, cfg.operator, addPlan.quoteReceiver, "add-op-quote"));
  const registrarMint = await step("stage registrar LP mint", () =>
    authorPlanAlloc(regCid, lpRegistrar, addPlan.lpMintSender, "add-mint"));

  const addRes = await step("PoolLiquidityRules_SettleAddLiquidity", async () => {
    const tx = await submit([cfg.operator, lpRegistrar], `${RUN}-add-settle`, [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"), contractId: dvpCid,
        choice: "PoolLiquidityRules_SettleAddLiquidity",
        choiceArgument: {
          expectedPoolId: poolId, poolCid, poolStateCid: stateCid, lpPolicyCid: policyCid,
          requestCid: reqAdd.cid, acceptanceCid: null, recipient: cfg.trader,
          lpBaseDepositCid: baseDep, lpQuoteDepositCid: quoteDep, lpReceiptCid: receipt,
          baseFactoryCid: regCid, quoteFactoryCid: regCid, lpFactoryCid: regCid,
          baseAmount: ADD_BASE, quoteAmount: ADD_QUOTE, minLpTokens: "0.0", knownTotalLpSupply: "0.0",
          requestedAt: addRequestedAt,
          batchesByAdmin: settleAdmins.map((a): [string, RegistryBatchInput] =>
            [a, { factoryCid: regCid, extraArgs: EXTRA }]),
          operatorBaseReceiverCid: opBaseReceiver,
          operatorQuoteReceiverCid: opQuoteReceiver,
          registrarMintCid: registrarMint,
          allocationContextByAdmin: [],
        },
      },
    }]);
    // This settle tx creates exactly one PoolState (for THIS pool); match
    // it by poolId to be unambiguous even if [0] ordering ever changes.
    const ps = creates(tx, "CantonDex.Dex.PoolState:PoolState")
      .find((c) => (c.createArgument as { poolId: string }).poolId === poolId)!;
    const policy = only(
      creates(tx, "CantonDex.Lp.Policy:LPTokenPolicy")
        .filter((created) => argOf<PolicyArg>(created).lpInstrumentId.id === LP),
      "post-add LPTokenPolicy",
    );
    stateCid = ps.contractId;
    policyCid = policy.contractId;
    return argOf<PoolStateArg>(ps);
  });
  const expectLp = dec.sqrt(dec.mul(dec.parseDecimal(ADD_BASE), dec.parseDecimal(ADD_QUOTE)));
  eq(addRes.status, "PS_Active", "pool active after add");
  eqDec(dec.parseDecimal(addRes.reserves.baseAmount), dec.parseDecimal(ADD_BASE), "base reserve");
  eqDec(dec.parseDecimal(addRes.reserves.quoteAmount), dec.parseDecimal(ADD_QUOTE), "quote reserve");
  eqDec(dec.parseDecimal(addRes.totalLpSupply), expectLp, "LP minted = sqrt(base*quote)");
  console.log(`  reserves ${addRes.reserves.baseAmount}/${addRes.reserves.quoteAmount}, LP ${addRes.totalLpSupply} (= sqrt(${ADD_BASE}*${ADD_QUOTE}))`);
  // Confirm the trader actually received the LP holding (DvP, not just supply bump).
  const lpHeld = (await acs(cfg.trader, "CantonDex.Registry.V2:Holding"))
    .map((c) => c.createArgument as { owner: string; instrumentId: string; amount: string; locked?: boolean })
    .filter((p) => p.owner === cfg.trader && p.instrumentId === LP && !p.locked);
  eq(lpHeld.length >= 1, true, "trader holds an LP holding");
  eqDec(
    sum(lpHeld.map((holding) => dec.parseDecimal(holding.amount))),
    expectLp,
    "trader LP balance = minted",
  );
  console.log(`  trader LP holding: ${lpHeld.map((h) => h.amount).join("+")}`);

  const addSliceCount = await step("reconcile reserves against pool slices", () =>
    reconcile(rulesCid, poolId, poolCid, stateCid));
  console.log(`  ${addSliceCount} pool slices reconcile exactly with reserves`);

  if (ADD_ONLY) {
    console.log("\n== live-ledger add-liquidity probe complete ==");
    console.log("PASS: add-liquidity DvP (trader authored all 3 allocations; operator+lpRegistrar settled)");
    console.log(`created ledger state: run=${RUN}, registry=${regCid}, pool=${poolId}`);
    console.log("persistence is controlled by the enclosing environment; the DPM proof wrapper removes its throwaway sandbox");
    return;
  }

  // 4. SWAP: quote snapshot -> wallet allocation -> atomic settle ---------
  console.log("\n== SWAP QUOTE -> BASE ==");
  const beforeSwapSlices = await step("read active pool slices", () => poolSlices(poolId));
  const inputSlice = beforeSwapSlices.quote[0];
  if (!inputSlice) throw new Error("pool has no quote slice to receive swap input");

  const swapIn = dec.parseDecimal(SWAP_IN);
  const oldBase = dec.parseDecimal(addRes.reserves.baseAmount);
  const oldQuote = dec.parseDecimal(addRes.reserves.quoteAmount);
  const expectedOut = constantProductOut(oldQuote, oldBase, FEE_BPS, swapIn);
  if (expectedOut <= 0n || expectedOut >= oldBase) {
    throw new Error(`invalid quoted output ${dec.formatDecimal(expectedOut)} ${BASE}`);
  }
  const outputPlan = coveringPlan(beforeSwapSlices.base, expectedOut, "base");
  const quoteBinding: SwapQuoteBinding = {
    expectedPoolId: poolId,
    poolStateCid: stateCid,
    inputSliceCid: inputSlice.contractId,
    outputSliceCids: outputPlan.cids,
    minOutputAmount: dec.formatDecimal(expectedOut),
  };

  const swapHolding = (await holdingsFor(cfg.swapper, QUOTE))
    .find((holding) => dec.parseDecimal(holding.amount) === swapIn);
  if (!swapHolding) throw new Error(`swapper has no unlocked ${SWAP_IN} ${QUOTE} holding`);
  const swapperQuoteBefore = await balance(cfg.swapper, QUOTE);
  const swapperBaseBefore = await balance(cfg.swapper, BASE);

  const swapRequest = await step("PoolRules_RequestSwap", async () => {
    const tx = await submit([cfg.operator], `${RUN}-swap-request`, [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolRules:PoolRules"),
        contractId: rulesCid,
        choice: "PoolRules_RequestSwap",
        choiceArgument: {
          poolCid,
          swapper: cfg.swapper,
          inputInstrumentId: { admin: cfg.admin, id: QUOTE },
          inputAmount: SWAP_IN,
          requestedAt: new Date().toISOString(),
          settleAt: null,
          quoteBinding,
        },
      },
    }]);
    const result = exercisedResult(tx, "PoolRules_RequestSwap")
      ?? await treeExercisedResult(tx.transaction.updateId, cfg.operator, "PoolRules_RequestSwap");
    if (!result) {
      throw new Error(
        "participant did not expose the PoolRules_RequestSwap result in the transaction or transaction tree",
      );
    }
    return result as SwapRequestResult;
  });
  if (!swapRequest.quoteBinding) throw new Error("swap request returned no quote binding");
  eq(swapRequest.quoteBinding.poolStateCid, stateCid, "request is bound to current PoolState");
  eq(
    swapRequest.quoteBinding.minOutputAmount,
    quoteBinding.minOutputAmount,
    "request preserves quoted minimum",
  );

  // Input (QUOTE) and output (BASE) share cfg.admin, so the swap collapses to a
  // single combined allocation and a single settlement batch under that admin.
  const swapAdmins = [...new Set([cfg.admin, cfg.admin])];
  const swapSpec = swapRequest.allocationSpecs[0];
  if (!swapSpec) throw new Error("swap request did not return an allocation spec");
  const swapAllocationCid = await step("swapper authors the exact swap allocation", () =>
    authorAlloc(
      regCid,
      cfg.swapper,
      swapRequest.settlement,
      swapSpec,
      [swapHolding.cid],
      "swap-input",
    ));

  // Settle exactly as the production backend does: the operator acts alone,
  // with NO readAs on the swapper. The operator is the settlement executor named
  // on the swapper's allocation, so it already observes it; the registry factory
  // is the operator's own regCid. A swapper readAs here would flatter the proof
  // by granting a visibility production never takes.
  const swapRes = await step("PoolRules_Swap", async () => {
    const tx = await submit([cfg.operator], `${RUN}-swap-settle`, [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolRules:PoolRules"),
        contractId: rulesCid,
        choice: "PoolRules_Swap",
        choiceArgument: {
          expectedPoolId: poolId,
          poolCid,
          poolStateCid: stateCid,
          swapperAccount: acct(cfg.swapper),
          inputInstrumentId: { admin: cfg.admin, id: QUOTE },
          inputAmount: SWAP_IN,
          minOutputAmount: quoteBinding.minOutputAmount,
          swapperAllocationCidsByAdmin: swapAdmins.map((a): [string, string] =>
            [a, swapAllocationCid]),
          inputSliceCid: quoteBinding.inputSliceCid,
          outputSliceCids: quoteBinding.outputSliceCids,
          batchesByAdmin: swapAdmins.map((a): [string, RegistryBatchInput] =>
            [a, { factoryCid: regCid, extraArgs: EXTRA }]),
          swapAllocationRequestCids: [],
          quoteBinding,
        },
      },
    }]);
    const state = only(
      creates(tx, "CantonDex.Dex.PoolState:PoolState")
        .filter((created) => argOf<PoolStateArg>(created).poolId === poolId),
      "post-swap PoolState",
    );
    stateCid = state.contractId;
    return argOf<PoolStateArg>(state);
  });

  const postSwapBase = dec.parseDecimal(swapRes.reserves.baseAmount);
  const postSwapQuote = dec.parseDecimal(swapRes.reserves.quoteAmount);
  eq(swapRes.status, "PS_Active", "pool active after swap");
  eqDec(postSwapBase, oldBase - expectedOut, "base reserve after swap");
  eqDec(postSwapQuote, oldQuote + swapIn, "quote reserve after swap");
  eqDec(
    dec.parseDecimal(swapRes.totalLpSupply),
    dec.parseDecimal(addRes.totalLpSupply),
    "swap does not change LP supply",
  );
  atLeastRaw(postSwapBase * postSwapQuote, oldBase * oldQuote, "x*y does not decrease");
  eqDec(
    swapperQuoteBefore - await balance(cfg.swapper, QUOTE),
    swapIn,
    "swapper quote balance paid",
  );
  eqDec(
    await balance(cfg.swapper, BASE) - swapperBaseBefore,
    expectedOut,
    "swapper base balance received",
  );
  const postSwapSlices = await poolSlices(poolId);
  eqDec(sliceTotal(postSwapSlices.base), postSwapBase, "base slices equal base reserve after swap");
  eqDec(sliceTotal(postSwapSlices.quote), postSwapQuote, "quote slices equal quote reserve after swap");
  const swapSliceCount = await step("reconcile post-swap reserves and slices", () =>
    reconcile(rulesCid, poolId, poolCid, stateCid));
  console.log(
    `  ${SWAP_IN} ${QUOTE} -> ${dec.formatDecimal(expectedOut)} ${BASE}; ` +
      `reserves ${swapRes.reserves.baseAmount}/${swapRes.reserves.quoteAmount}; ` +
      `x*y non-decreasing; ${swapSliceCount} slices reconciled`,
  );

  // 5. REMOVE: request -> wallet allocations -> redeem half the LP --------
  console.log("\n== REMOVE HALF THE LP POSITION ==");
  const supplyBeforeRemove = dec.parseDecimal(swapRes.totalLpSupply);
  const redeemAmount = dec.divFloor(supplyBeforeRemove, dec.parseDecimal("2.0"));
  if (redeemAmount <= 0n) throw new Error("half-position redemption rounded to zero");
  const share = dec.divFloor(redeemAmount, supplyBeforeRemove);
  const baseOut = dec.mulFloor(postSwapBase, share);
  const quoteOut = dec.mulFloor(postSwapQuote, share);
  const removeSlices = await poolSlices(poolId);
  const basePlan = coveringPlan(removeSlices.base, baseOut, "base");
  const quotePlan = coveringPlan(removeSlices.quote, quoteOut, "quote");

  const lpHoldings = await holdingsFor(cfg.trader, LP);
  const lpInputCids: string[] = [];
  let lpCovered = 0n;
  for (const holding of lpHoldings) {
    lpInputCids.push(holding.cid);
    lpCovered += dec.parseDecimal(holding.amount);
    if (lpCovered >= redeemAmount) break;
  }
  if (lpCovered < redeemAmount) {
    throw new Error(
      `LP holdings cover ${dec.formatDecimal(lpCovered)}, need ${dec.formatDecimal(redeemAmount)}`,
    );
  }
  const traderBaseBeforeRemove = await balance(cfg.trader, BASE);
  const traderQuoteBeforeRemove = await balance(cfg.trader, QUOTE);
  const traderLpBeforeRemove = await balance(cfg.trader, LP);

  const removeRequest = await step("PoolLiquidityRules_RequestRemoveLiquidity", async () => {
    const tx = await submit([cfg.operator], `${RUN}-remove-request`, [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"),
        contractId: dvpCid,
        choice: "PoolLiquidityRules_RequestRemoveLiquidity",
        choiceArgument: {
          poolCid,
          holder: cfg.trader,
          baseOuts: basePlan.outs,
          quoteOuts: quotePlan.outs,
          lpBurnAmount: dec.formatDecimal(redeemAmount),
          requestedAt: new Date().toISOString(),
          settleAt: null,
        },
      },
    }]);
    const request = only(
      creates(tx, "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationRequest"),
      "remove LiquidityAllocationRequest",
    );
    return { cid: request.contractId, arg: argOf<RequestArg>(request) };
  });
  const [baseReceiptSpec, quoteReceiptSpec, burnSpec] = removeRequest.arg.allocations;
  if (!baseReceiptSpec || !quoteReceiptSpec || !burnSpec) {
    throw new Error("remove request did not return 3 allocation specs");
  }
  const holderBaseReceiptCid = await step("trader authors base receipt", () =>
    authorAlloc(
      regCid,
      cfg.trader,
      removeRequest.arg.settlement,
      baseReceiptSpec,
      [],
      "remove-base-receipt",
    ));
  const holderQuoteReceiptCid = await step("trader authors quote receipt", () =>
    authorAlloc(
      regCid,
      cfg.trader,
      removeRequest.arg.settlement,
      quoteReceiptSpec,
      [],
      "remove-quote-receipt",
    ));
  const holderBurnSenderCid = await step("trader authors LP burn sender", () =>
    authorAlloc(
      regCid,
      cfg.trader,
      removeRequest.arg.settlement,
      burnSpec,
      lpInputCids,
      "remove-lp-burn",
    ));

  // Stage the registrar burn-receiver allocation. Remove authors only the LP
  // burn side (base/quote come from existing slices), so allocationContextByAdmin
  // stays empty. PreviewRemoveAllocations returns the exact factory arguments.
  const removeRequestedAt = new Date().toISOString();
  const removePrep = {
    expectedPoolId: poolId, poolCid, poolStateCid: stateCid, lpPolicyCid: policyCid,
    requestCid: removeRequest.cid, acceptanceCid: null, holder: cfg.trader,
    lpTokensToRedeem: dec.formatDecimal(redeemAmount),
    knownTotalLpSupply: dec.formatDecimal(supplyBeforeRemove),
    minBaseOut: dec.formatDecimal(baseOut),
    minQuoteOut: dec.formatDecimal(quoteOut),
    baseSliceCids: basePlan.cids,
    quoteSliceCids: quotePlan.cids,
    holderBaseReceiptCid, holderQuoteReceiptCid, holderBurnSenderCid,
  };
  const removePlan = await step("PoolLiquidityRules_PreviewRemoveAllocations", async () => {
    const tx = await submit([cfg.operator, lpRegistrar], `${RUN}-remove-preview`, [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"),
        contractId: dvpCid,
        choice: "PoolLiquidityRules_PreviewRemoveAllocations",
        choiceArgument: { preparation: removePrep, requestedAt: removeRequestedAt },
      },
    }]);
    const result = exercisedResult(tx, "PoolLiquidityRules_PreviewRemoveAllocations")
      ?? await treeExercisedResult(tx.transaction.updateId, cfg.operator, "PoolLiquidityRules_PreviewRemoveAllocations");
    if (!result) throw new Error("participant did not expose the PreviewRemoveAllocations result");
    return result as RemoveAllocationPlan;
  });
  const registrarBurnReceiver = await step("stage registrar LP burn receiver", () =>
    authorPlanAlloc(regCid, lpRegistrar, removePlan.lpBurnReceiver, "remove-burn"));

  const removeRes = await step("PoolLiquidityRules_SettleRemoveLiquidity", async () => {
    const tx = await submit([cfg.operator, lpRegistrar], `${RUN}-remove-settle`, [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"),
        contractId: dvpCid,
        choice: "PoolLiquidityRules_SettleRemoveLiquidity",
        choiceArgument: {
          expectedPoolId: poolId,
          poolCid,
          poolStateCid: stateCid,
          lpPolicyCid: policyCid,
          requestCid: removeRequest.cid,
          acceptanceCid: null,
          holder: cfg.trader,
          lpTokensToRedeem: dec.formatDecimal(redeemAmount),
          knownTotalLpSupply: dec.formatDecimal(supplyBeforeRemove),
          minBaseOut: dec.formatDecimal(baseOut),
          minQuoteOut: dec.formatDecimal(quoteOut),
          baseSliceCids: basePlan.cids,
          quoteSliceCids: quotePlan.cids,
          holderBaseReceiptCid,
          holderQuoteReceiptCid,
          holderBurnSenderCid,
          lpFactoryCid: regCid,
          requestedAt: removeRequestedAt,
          batchesByAdmin: settleAdmins.map((a): [string, RegistryBatchInput] =>
            [a, { factoryCid: regCid, extraArgs: EXTRA }]),
          registrarBurnReceiverCid: registrarBurnReceiver,
          allocationContextByAdmin: [],
        },
      },
    }]);
    const state = only(
      creates(tx, "CantonDex.Dex.PoolState:PoolState")
        .filter((created) => argOf<PoolStateArg>(created).poolId === poolId),
      "post-remove PoolState",
    );
    const policy = only(
      creates(tx, "CantonDex.Lp.Policy:LPTokenPolicy")
        .filter((created) => argOf<PolicyArg>(created).lpInstrumentId.id === LP),
      "post-remove LPTokenPolicy",
    );
    stateCid = state.contractId;
    policyCid = policy.contractId;
    return { state: argOf<PoolStateArg>(state), policy: argOf<PolicyArg>(policy) };
  });

  const finalBase = dec.parseDecimal(removeRes.state.reserves.baseAmount);
  const finalQuote = dec.parseDecimal(removeRes.state.reserves.quoteAmount);
  const finalSupply = dec.parseDecimal(removeRes.state.totalLpSupply);
  eq(removeRes.state.status, "PS_Active", "partially redeemed pool remains active");
  eqDec(finalBase, postSwapBase - baseOut, "base reserve after remove");
  eqDec(finalQuote, postSwapQuote - quoteOut, "quote reserve after remove");
  eqDec(finalSupply, supplyBeforeRemove - redeemAmount, "LP supply after burn");
  eqDec(dec.parseDecimal(removeRes.policy.totalSupply), finalSupply, "policy supply equals PoolState supply");
  eqDec(
    await balance(cfg.trader, BASE) - traderBaseBeforeRemove,
    baseOut,
    "LP received base payout",
  );
  eqDec(
    await balance(cfg.trader, QUOTE) - traderQuoteBeforeRemove,
    quoteOut,
    "LP received quote payout",
  );
  eqDec(
    traderLpBeforeRemove - await balance(cfg.trader, LP),
    redeemAmount,
    "LP holding burned",
  );
  atLeastRaw(finalBase * supplyBeforeRemove, postSwapBase * finalSupply, "base per LP does not decrease");
  atLeastRaw(finalQuote * supplyBeforeRemove, postSwapQuote * finalSupply, "quote per LP does not decrease");

  const finalSlices = await poolSlices(poolId);
  eqDec(sliceTotal(finalSlices.base), finalBase, "final base slices equal reserve");
  eqDec(sliceTotal(finalSlices.quote), finalQuote, "final quote slices equal reserve");
  const finalSliceCount = await step("reconcile final reserves and slices", () =>
    reconcile(rulesCid, poolId, poolCid, stateCid));

  const finalUnlockedBase = sum(await Promise.all(valueParties.map((party) => balance(party, BASE))));
  const finalUnlockedQuote = sum(await Promise.all(valueParties.map((party) => balance(party, QUOTE))));
  eqDec(
    finalBase + finalUnlockedBase,
    initialUnlockedBase + dec.parseDecimal(ADD_BASE),
    "base value conserved",
  );
  eqDec(
    finalQuote + finalUnlockedQuote,
    initialUnlockedQuote + dec.parseDecimal(ADD_QUOTE) + dec.parseDecimal(SWAP_IN),
    "quote value conserved",
  );

  console.log(
    `  burned ${dec.formatDecimal(redeemAmount)} ${LP}; returned ` +
      `${dec.formatDecimal(baseOut)} ${BASE} + ${dec.formatDecimal(quoteOut)} ${QUOTE}`,
  );
  console.log(
    `  final reserves ${removeRes.state.reserves.baseAmount}/${removeRes.state.reserves.quoteAmount}; ` +
      `LP supply ${removeRes.state.totalLpSupply}; ${finalSliceCount} slices reconciled`,
  );
  console.log("\n== live-ledger AMM round trip complete ==");
  console.log(
    "PASS: add -> swap -> partial remove settled real holdings; balances, reserves, " +
      "slice totals, LP supply, x*y, reserve-per-LP, and value conservation all hold",
  );
  console.log(`created ledger state: run=${RUN}, registry=${regCid}, pool=${poolId}`);
  console.log("persistence is controlled by the enclosing environment; the DPM proof wrapper removes its throwaway sandbox");
}

main().catch((e) => { console.error("FATAL", (e as Error).message); process.exit(1); });
