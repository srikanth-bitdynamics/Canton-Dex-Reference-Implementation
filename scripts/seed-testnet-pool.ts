// Seed an EXISTING live pool with liquidity, then prove a swap against it.
//
// Everything this script needs on-ledger already exists and is only ever
// read: the V2 Registry (which is also the allocation + settlement factory),
// its registered instruments, and the pool's Pool / PoolState / PoolRules /
// PoolLiquidityRules / LPTokenPolicy contracts. Nothing here creates a
// registry, registers an instrument, or creates a pool -- the whole surface
// is resolved from the ACS by instrument pair, so a re-run seeds more
// liquidity into the same pool instead of forking a second one.
//
// What it proves, in order:
//   1. mint  -- base + quote + the swap input to the LP party, through
//               Registry_Mint on the existing registry
//   2. add   -- the wallet-authored DvP add (request -> the LP authors its
//               three allocations -> settle), the flow proven headlessly in
//               scripts/localnet-dvp-e2e.ts
//   3. swap  -- PoolRules_RequestSwap -> the swapper authors its input
//               allocation -> PoolRules_Swap, then asserts against the
//               ledger that the reserves moved by exactly the
//               constant-product amounts, that the swapper's holdings moved
//               by input/output, that x*y=k did not decrease, and that the
//               reserves still equal the sum of the pool's slices
//               (on-ledger, via PoolRules_ReconcileState)
//
// Every assertion is fatal: a failure exits non-zero.
//
// Env (ledger + parties):
//   CANTON_LEDGER_URL, CANTON_LEDGER_TOKEN, CANTON_SYNCHRONIZER,
//   CANTON_DEX_PACKAGE_ID (e.g. #canton-dex-trading),
//   CANTON_ALLOC_INSTR_PACKAGE_ID (e.g. #splice-api-token-allocation-instruction-v2),
//   CANTON_USER_ID (default ledger-api-user),
//   CANTON_OPERATOR -- the venue party; admin + lpRegistrar are read off the
//   Pool contract rather than configured twice.
//   CANTON_LP        (default: the pool's lpRegistrar) -- the party that is
//                    minted to and provides the liquidity.
//   CANTON_SWAPPER   (default: CANTON_LP) -- must differ from the operator.
//   CANTON_REGISTRY_CID / CANTON_LP_REGISTRY_CID -- optional overrides for
//   the Registry.V2 of the asset admin / of the LP registrar; both are
//   discovered from the ACS when unset.
//
// Env (what to seed and trade):
//   POOL_BASE (default BTC), POOL_QUOTE (default USDC), POOL_ID (optional,
//   disambiguates two pools over the same pair), SEED_BASE, SEED_QUOTE,
//   SWAP_IN, SWAP_IN_SIDE (base|quote, default quote).
//
// The token must have actAs for the operator, the asset admin, the LP
// registrar, the LP and the swapper.
//
// Run (from services/operator-backend, which has tsx on its path):
//   node --import tsx ../../scripts/seed-testnet-pool.ts

import { createHash } from "node:crypto";

import * as dec from "../services/operator-backend/src/pool/decimal.js";

function req(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(2); }
  return v;
}
const opt = (name: string, fallback: string): string => process.env[name] ?? fallback;

const cfg = {
  baseUrl: req("CANTON_LEDGER_URL"),
  token: req("CANTON_LEDGER_TOKEN"),
  sync: req("CANTON_SYNCHRONIZER"),
  pkg: req("CANTON_DEX_PACKAGE_ID"),
  // AllocationFactory_Allocate is a token-standard INTERFACE choice; it must
  // be exercised against the interface id (alloc-instruction-v2 package),
  // not the concrete Registry template.
  pkgAllocInstr: req("CANTON_ALLOC_INSTR_PACKAGE_ID"),
  userId: opt("CANTON_USER_ID", "ledger-api-user"),
  operator: req("CANTON_OPERATOR"),
  lp: process.env.CANTON_LP ?? null,
  swapper: process.env.CANTON_SWAPPER ?? null,
  registryCid: process.env.CANTON_REGISTRY_CID ?? null,
  lpRegistryCid: process.env.CANTON_LP_REGISTRY_CID ?? null,
  base: opt("POOL_BASE", "BTC"),
  quote: opt("POOL_QUOTE", "USDC"),
  poolId: process.env.POOL_ID ?? null,
  seedBase: opt("SEED_BASE", "1.0"),
  seedQuote: opt("SEED_QUOTE", "100000.0"),
  swapIn: opt("SWAP_IN", "1000.0"),
  swapInSide: opt("SWAP_IN_SIDE", "quote"),
};

const RUN = `seed-${Date.now()}`;
const tid = (m: string) => `${cfg.pkg}:${m}`;
const acct = (p: string) => ({ owner: p, provider: null, id: "" });
const EXTRA = { context: { values: {} }, meta: { values: {} } };
const short = (p: string) => `${p.slice(0, 12)}..`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ledger command ids are capped at 255 chars and a party id is ~113 of them
// (a contract id ~138), so variable-length parts go in as a digest and are
// never concatenated.
function cmdId(label: string, ...parts: string[]): string {
  if (parts.length === 0) return `${RUN}-${label}`;
  const digest = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${RUN}-${label}-${digest}`;
}

interface Created { contractId: string; templateId: string; createArgument: Record<string, unknown> }
interface Exercised { choice: string; exerciseResult: unknown }
type Ev =
  | { CreatedEvent: Created }
  | { ArchivedEvent: { contractId: string } }
  | { ExercisedEvent: Exercised };
interface Tx { transaction: { updateId: string; events: Ev[] } }

// On-ledger payloads, as the JSON API renders them.
interface PoolArg {
  poolId: string; operator: string; lpRegistrar: string; admin: string;
  baseInstrumentId: string; quoteInstrumentId: string;
  lpInstrumentId: { admin: string; id: string }; feeBps: string | number;
}
interface PoolStateArg {
  poolId: string; operator: string; status: string;
  reserves: { baseAmount: string; quoteAmount: string }; totalLpSupply: string;
}
interface SliceArg { poolId: string; operator: string; side: string; amount: string }
interface HoldingArg { admin: string; owner: string; instrumentId: string; amount: string; locked: boolean }
interface PolicyArg { lpRegistrar: string; lpInstrumentId: { admin: string; id: string }; totalSupply: string; active: boolean }
interface RegistryArg { admin: string }
interface InstrumentConfigArg { admin: string; instrumentId: string }
interface RulesArg { operator: string }
interface LiquidityRulesArg { operator: string; lpRegistrar: string }
interface RequestArg { allocations: unknown[]; settlement: unknown }
interface SwapRequestResult { settlement: unknown; allocationSpec: unknown }

const argOf = <T>(c: Created): T => c.createArgument as unknown as T;

function only<T>(xs: T[], what: string): T {
  if (xs.length !== 1) throw new Error(`expected exactly 1 ${what}, found ${xs.length}`);
  return xs[0]!;
}

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

// A contract disclosed to a submitter that is not one of its stakeholders.
// `createdEventBlob` is the opaque payload the participant validates against the
// contract id, so it cannot be tampered with (DISCLOSED_CONTRACT_AUTHENTICATION_FAILED).
interface Disclosed { templateId: string; contractId: string; createdEventBlob: string }

async function submit(
  actAs: string[], commandId: string, commands: unknown[], readAs: string[] = [],
  disclosed: Disclosed[] = [],
): Promise<Tx> {
  const res = await fetch(`${cfg.baseUrl}/v2/commands/submit-and-wait-for-transaction`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: {
        commandId, userId: cfg.userId, actAs,
        ...(readAs.length > 0 ? { readAs } : {}),
        ...(disclosed.length > 0 ? { disclosedContracts: disclosed } : {}),
        synchronizerId: cfg.sync, commands: encInt(commands),
      },
      transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
    }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`submit ${commandId} -> HTTP ${res.status}: ${t}`);
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

async function acs(party: string, template: string, withBlob = false): Promise<Created[]> {
  const offset = await ledgerEnd();
  const r = await fetch(`${cfg.baseUrl}/v2/state/active-contracts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      verbose: false, activeAtOffset: offset,
      filter: { filtersByParty: { [party]: { cumulative: [
        { identifierFilter: { TemplateFilter: { value: { templateId: tid(template), includeCreatedEventBlob: withBlob } } } },
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
const eqDec = (a: bigint, b: bigint, m: string) => {
  if (a !== b) throw new Error(`assert ${m}: expected ${dec.formatDecimal(b)}, got ${dec.formatDecimal(a)}`);
};
const atLeast = (a: bigint, b: bigint, m: string) => {
  if (a < b) throw new Error(`assert ${m}: expected >= ${dec.formatDecimal(b)}, got ${dec.formatDecimal(a)}`);
};

// InstrumentConfig_BumpSupply is consuming, so every mint rotates the config
// cid and two mints of one instrument race for it. Re-resolve inside the
// closure and retry on the errors that race produces.
const CONTENDED = ["contention", "inconsistent", "contract_not_found", "locked_contracts", "already_archived"];
async function retrying<T>(what: string, fn: (attempt: number) => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn(i);
    } catch (e) {
      const msg = (e as Error).message.toLowerCase();
      if (i >= attempts - 1 || !CONTENDED.some((c) => msg.includes(c))) throw e;
      console.log(`  ..  ${what} contended, retrying (${i + 1}/${attempts - 1})`);
      await sleep(500 * (i + 1));
    }
  }
}

// The constant-product math of CantonDex.Dex.PoolModel, in exact 10dp
// decimal so the expectation is computed the way the ledger computes it
// (a JS double drifts in the last digits, and the swap is asserted exactly).
// The Daml floors the result to 10dp afterwards, which is a no-op on a value
// that already carries 10 decimals.
function constantProductOut(reserveIn: bigint, reserveOut: bigint, feeBps: number, inputAmount: bigint): bigint {
  const feeMultiplier = dec.div(dec.parseDecimal(String(10000 - feeBps)), dec.parseDecimal("10000"));
  const amountInAfterFee = dec.mul(inputAmount, feeMultiplier);
  return dec.div(dec.mul(amountInAfterFee, reserveOut), reserveIn + amountInAfterFee);
}

// The LP entitlement PoolLiquidityRules_SettleAddLiquidity bounds the receipt
// against: sqrt(k) at first funding, else pro-rata over the reserves.
function lpQuote(state: PoolStateArg, base: bigint, quote: bigint): bigint {
  const supply = dec.parseDecimal(state.totalLpSupply);
  if (supply === 0n) return dec.sqrt(dec.mul(base, quote));
  return dec.min(
    dec.div(dec.mul(base, supply), dec.parseDecimal(state.reserves.baseAmount)),
    dec.div(dec.mul(quote, supply), dec.parseDecimal(state.reserves.quoteAmount)),
  );
}

// A choice result is absent from an ACS_DELTA transaction. Take it from the
// submit response when the participant includes exercised events...
function exercisedResult(tx: Tx, choice: string): unknown {
  for (const e of tx.transaction.events) {
    if ("ExercisedEvent" in e && e.ExercisedEvent.choice === choice) return e.ExercisedEvent.exerciseResult;
  }
  return undefined;
}

// ...and otherwise from the transaction tree, where participants that still
// serve trees carry it.
async function treeExercisedResult(updateId: string, party: string, choice: string): Promise<unknown> {
  const url = new URL(`/v2/updates/transaction-tree-by-id/${encodeURIComponent(updateId)}`, cfg.baseUrl);
  url.searchParams.append("parties", party);
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!r.ok) return undefined;
  const body = (await r.json()) as {
    transaction?: { eventsById?: Record<string, { ExercisedTreeEvent?: { value?: Exercised } }> };
  };
  for (const ev of Object.values(body.transaction?.eventsById ?? {})) {
    const v = ev.ExercisedTreeEvent?.value;
    if (v?.choice === choice) return v.exerciseResult;
  }
  return undefined;
}

// Author one allocation as `party` (the wallet's job): exercise
// AllocationFactory_Allocate on the registry, locking inputHoldingCids.
async function authorAlloc(
  party: string, factoryCid: string, settlement: unknown, allocation: unknown,
  inputHoldingCids: string[], label: string, disclosed: Disclosed[] = [],
): Promise<string> {
  const tx = await submit([party], cmdId(`author-${label}`, factoryCid, party), [{
    ExerciseCommand: {
      templateId: `${cfg.pkgAllocInstr}:Splice.Api.Token.AllocationInstructionV2:AllocationFactory`,
      contractId: factoryCid,
      choice: "AllocationFactory_Allocate",
      choiceArgument: {
        settlement, allocation,
        requestedAt: new Date().toISOString(),
        inputHoldingCids, extraArgs: EXTRA, actors: [party],
      },
    },
  }], [], disclosed);
  return only(creates(tx, "CantonDex.Registry.V2:Allocation"), `${label} allocation`).contractId;
}

// The Registry is `signatory admin, observer users`, so a party outside `users`
// -- every faucet-created tester -- cannot see the factory it must exercise.
// Explicit contract disclosure is the mechanism for exactly this: fetch the
// contract's createdEventBlob as someone who CAN see it (the admin) and attach
// it to the submitter's command. This is what a registry's off-ledger API
// returns as `disclosedContracts` alongside factoryId and choiceContextData.
async function discloseRegistry(admin: string, registryCid: string): Promise<Disclosed[]> {
  const withBlob = await acs(admin, "CantonDex.Registry.V2:Registry", true);
  const c = withBlob.find((x) => x.contractId === registryCid);
  if (!c) throw new Error(`registry ${registryCid.slice(0, 12)} not visible to admin`);
  const blob = (c as unknown as { createdEventBlob?: string }).createdEventBlob;
  if (!blob) throw new Error("registry createdEventBlob missing (includeCreatedEventBlob ignored?)");
  // Use the templateId the ledger reported, NOT tid(): a disclosed contract's
  // template id must carry the resolved package-id hash. The `#package-name`
  // form that ACS *filters* require is rejected here ("non expected character
  // 0x23 in Daml-LF Package ID") -- the two sides of the API take opposite forms.
  const templateId = (c as unknown as { templateId?: string }).templateId;
  if (!templateId) throw new Error("registry createdEvent has no templateId");
  return [{ templateId, contractId: registryCid, createdEventBlob: blob }];
}

async function main() {
  console.log(`run ${RUN}  pair ${cfg.base}/${cfg.quote}`);

  // 1. Resolve the pool surface that already exists ------------------------
  const ctx = await step("resolve pool, registries and rules", async () => {
    const pools = await acs(cfg.operator, "CantonDex.Dex.Pool:Pool");
    const poolC = only(
      pools.filter((c) => {
        const p = argOf<PoolArg>(c);
        return p.operator === cfg.operator
          && p.baseInstrumentId === cfg.base
          && p.quoteInstrumentId === cfg.quote
          && (cfg.poolId === null || p.poolId === cfg.poolId);
      }),
      `Pool for ${cfg.base}/${cfg.quote}${cfg.poolId ? ` (poolId ${cfg.poolId})` : ""}`,
    );
    const pool = argOf<PoolArg>(poolC);
    const stateC = only(
      (await acs(cfg.operator, "CantonDex.Dex.PoolState:PoolState"))
        .filter((c) => argOf<PoolStateArg>(c).poolId === pool.poolId
          && argOf<PoolStateArg>(c).operator === cfg.operator),
      `PoolState for ${pool.poolId}`,
    );
    // PoolRules carries only `operator` -- it has no pool identity, because the
    // choices bind to a pool through their `expectedPoolId` argument instead.
    // So every PoolRules for this operator is interchangeable, and an operator
    // that runs more than one pool legitimately has more than one. Take the
    // first rather than demanding exactly one.
    const rulesCandidates = (await acs(cfg.operator, "CantonDex.Dex.PoolRules:PoolRules"))
      .filter((c) => argOf<RulesArg>(c).operator === cfg.operator);
    if (rulesCandidates.length === 0) throw new Error("no PoolRules for the operator");
    const rulesC = rulesCandidates[0]!;
    const dvpC = only(
      (await acs(cfg.operator, "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"))
        .filter((c) => {
          const r = argOf<LiquidityRulesArg>(c);
          return r.operator === cfg.operator && r.lpRegistrar === pool.lpRegistrar;
        }),
      `PoolLiquidityRules for operator + lpRegistrar ${short(pool.lpRegistrar)}`,
    );
    const policies = (await acs(pool.lpRegistrar, "CantonDex.Lp.Policy:LPTokenPolicy"))
      .filter((c) => {
        const p = argOf<PolicyArg>(c);
        return p.active
          && p.lpInstrumentId.id === pool.lpInstrumentId.id
          && p.lpInstrumentId.admin === pool.lpInstrumentId.admin;
      });
    const state = argOf<PoolStateArg>(stateC);
    // Several policies can be active for one instrument only if a previous
    // run left one behind; the settle requires the one whose supply matches
    // the pool state.
    const policyC = policies.find((c) => argOf<PolicyArg>(c).totalSupply === state.totalLpSupply)
      ?? only(policies, `active LPTokenPolicy for ${pool.lpInstrumentId.id}`);

    // The registry is the AllocationFactory and the SettlementFactory. The
    // LP-mint batch settles under the LP registrar's own registry, which is a
    // different contract whenever lpRegistrar != admin (the factory rejects a
    // spec whose admin is not its own).
    const registryFor = async (admin: string): Promise<string> =>
      only(
        (await acs(admin, "CantonDex.Registry.V2:Registry")).filter((c) => argOf<RegistryArg>(c).admin === admin),
        `Registry.V2 with admin ${short(admin)}`,
      ).contractId;
    const registryCid = cfg.registryCid ?? (await registryFor(pool.admin));
    const lpRegistryCid = cfg.lpRegistryCid
      ?? (pool.lpRegistrar === pool.admin ? registryCid : await registryFor(pool.lpRegistrar));

    return { poolC, pool, stateC, state, rulesC, dvpC, policyC, registryCid, lpRegistryCid };
  });

  const { pool } = ctx;
  const lp = cfg.lp ?? pool.lpRegistrar;
  const swapper = cfg.swapper ?? lp;
  const feeBps = Number(pool.feeBps);
  // The swap legs are swapper->pool and pool->swapper; if the swapper were the
  // operator both sides would collapse into self-transfers and the batch could
  // not balance. PoolRules_Swap rejects it -- fail earlier and clearer.
  if (swapper === cfg.operator) throw new Error("CANTON_SWAPPER must differ from CANTON_OPERATOR");
  if (cfg.swapInSide !== "base" && cfg.swapInSide !== "quote") {
    throw new Error(`SWAP_IN_SIDE must be "base" or "quote", got ${cfg.swapInSide}`);
  }
  const inputIsBase = cfg.swapInSide === "base";
  const inputId = inputIsBase ? pool.baseInstrumentId : pool.quoteInstrumentId;
  const outputId = inputIsBase ? pool.quoteInstrumentId : pool.baseInstrumentId;

  console.log(`pool ${pool.poolId} (${ctx.state.status}) fee ${feeBps}bps`);
  console.log(`operator=${short(cfg.operator)} admin=${short(pool.admin)} lpRegistrar=${short(pool.lpRegistrar)}`);
  console.log(`lp=${short(lp)} swapper=${short(swapper)} lpInstrument=${pool.lpInstrumentId.id}`);
  console.log(`reserves ${ctx.state.reserves.baseAmount} ${cfg.base} / ${ctx.state.reserves.quoteAmount} ${cfg.quote}, LP supply ${ctx.state.totalLpSupply}`);

  // 2. Mint what the add and the swap consume ------------------------------
  const configCidFor = async (instrumentId: string): Promise<string> =>
    only(
      (await acs(pool.admin, "CantonDex.Registry.V2:InstrumentConfig")).filter((c) => {
        const i = argOf<InstrumentConfigArg>(c);
        return i.admin === pool.admin && i.instrumentId === instrumentId;
      }),
      `Registry.V2 InstrumentConfig for ${instrumentId}`,
    ).contractId;

  // `purpose` keeps the command id distinct: two mints can otherwise agree on
  // instrument, amount and owner, and the second would be swallowed by the
  // participant's command deduplication.
  const mint = (purpose: string, instrumentId: string, amount: string, owner: string) =>
    step(`mint ${amount} ${instrumentId} -> ${short(owner)} (${purpose})`, () =>
      retrying(`mint ${instrumentId}`, async (attempt) => {
        // Re-resolved per attempt: the previous mint rotated the config cid.
        const configCid = await configCidFor(instrumentId);
        const tx = await submit([pool.admin, owner], cmdId(`mint-${purpose}-${attempt}`, instrumentId, amount, owner), [{
          ExerciseCommand: {
            templateId: tid("CantonDex.Registry.V2:Registry"), contractId: ctx.registryCid,
            choice: "Registry_Mint",
            choiceArgument: { configCid, owner, amount, issuerClaims: [] },
          },
        }]);
        return only(creates(tx, "CantonDex.Registry.V2:Holding"), `minted ${instrumentId} Holding`).contractId;
      }));

  const baseHoldingCid = await mint("seed-base", pool.baseInstrumentId, cfg.seedBase, lp);
  const quoteHoldingCid = await mint("seed-quote", pool.quoteInstrumentId, cfg.seedQuote, lp);
  // A separate holding for the swap: the add locks the two deposits.
  const swapHoldingCid = await mint("swap-in", inputId, cfg.swapIn, swapper);

  // 3. DvP add: request -> the LP authors 3 allocations -> settle -----------
  console.log("\n== ADD LIQUIDITY ==");
  const seedBase = dec.parseDecimal(cfg.seedBase);
  const seedQuote = dec.parseDecimal(cfg.seedQuote);
  const lpAmount = dec.formatDecimal(lpQuote(ctx.state, seedBase, seedQuote));
  const reqAdd = await step("PoolLiquidityRules_RequestAddLiquidity", async () => {
    const tx = await submit([cfg.operator], cmdId("add-req"), [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"), contractId: ctx.dvpC.contractId,
        choice: "PoolLiquidityRules_RequestAddLiquidity",
        choiceArgument: {
          poolCid: ctx.poolC.contractId, recipient: lp,
          baseAmount: cfg.seedBase, quoteAmount: cfg.seedQuote, lpAmount,
          requestedAt: new Date().toISOString(), settleAt: null,
        },
      },
    }]);
    const r = only(
      creates(tx, "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationRequest"),
      "LiquidityAllocationRequest",
    );
    return { cid: r.contractId, arg: argOf<RequestArg>(r) };
  });
  const [baseSpec, quoteSpec, receiptSpec] = reqAdd.arg.allocations;
  const settlement = reqAdd.arg.settlement;
  const baseDep = await step("LP authors base deposit", () =>
    authorAlloc(lp, ctx.registryCid, settlement, baseSpec, [baseHoldingCid], "add-base"));
  const quoteDep = await step("LP authors quote deposit", () =>
    authorAlloc(lp, ctx.registryCid, settlement, quoteSpec, [quoteHoldingCid], "add-quote"));
  // The LP-mint receipt names the LP registrar as its admin, so it is
  // authored against that registrar's registry.
  const receipt = await step("LP authors LP receipt", () =>
    authorAlloc(lp, ctx.lpRegistryCid, settlement, receiptSpec, [], "add-receipt"));

  const lpBefore = await lpBalance(lp, pool);
  const addState = await step("PoolLiquidityRules_SettleAddLiquidity", async () => {
    const tx = await submit([cfg.operator, pool.lpRegistrar], cmdId("add-settle", reqAdd.cid), [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules"), contractId: ctx.dvpC.contractId,
        choice: "PoolLiquidityRules_SettleAddLiquidity",
        choiceArgument: {
          expectedPoolId: pool.poolId, poolCid: ctx.poolC.contractId, poolStateCid: ctx.stateC.contractId,
          lpPolicyCid: ctx.policyC.contractId, requestCid: reqAdd.cid, acceptanceCid: null, recipient: lp,
          lpBaseDepositCid: baseDep, lpQuoteDepositCid: quoteDep, lpReceiptCid: receipt,
          baseFactoryCid: ctx.registryCid, quoteFactoryCid: ctx.registryCid, lpFactoryCid: ctx.lpRegistryCid,
          baseQuoteSettleCid: ctx.registryCid, lpSettleCid: ctx.lpRegistryCid,
          baseAmount: cfg.seedBase, quoteAmount: cfg.seedQuote,
          minLpTokens: "0.0", knownTotalLpSupply: ctx.state.totalLpSupply,
          requestedAt: new Date().toISOString(), poolAdminExtraArgs: EXTRA, lpRegistrarExtraArgs: EXTRA,
        },
      },
    }]);
    // The settle writes exactly one PoolState for THIS pool; match it by
    // poolId so the read stays unambiguous.
    const ps = creates(tx, "CantonDex.Dex.PoolState:PoolState")
      .find((c) => argOf<PoolStateArg>(c).poolId === pool.poolId);
    if (!ps) throw new Error("settle did not write a PoolState for this pool");
    return { cid: ps.contractId, arg: argOf<PoolStateArg>(ps) };
  });

  eq(addState.arg.status, "PS_Active", "pool active after add");
  eqDec(
    dec.parseDecimal(addState.arg.reserves.baseAmount),
    dec.parseDecimal(ctx.state.reserves.baseAmount) + seedBase, "base reserve after add",
  );
  eqDec(
    dec.parseDecimal(addState.arg.reserves.quoteAmount),
    dec.parseDecimal(ctx.state.reserves.quoteAmount) + seedQuote, "quote reserve after add",
  );
  eqDec(
    dec.parseDecimal(addState.arg.totalLpSupply),
    dec.parseDecimal(ctx.state.totalLpSupply) + dec.parseDecimal(lpAmount), "LP supply after add",
  );
  // DvP, not just a supply bump: the LP must actually hold the new tokens.
  const lpAfter = await lpBalance(lp, pool);
  eqDec(lpAfter - lpBefore, dec.parseDecimal(lpAmount), "LP token holdings received");
  console.log(`  reserves ${addState.arg.reserves.baseAmount}/${addState.arg.reserves.quoteAmount}, LP minted ${lpAmount} (holdings ${dec.formatDecimal(lpAfter)})`);

  // 4. Swap: request -> the swapper authors its input -> settle -------------
  console.log("\n== SWAP ==");
  const slices = await step("read pool slices", () => poolSlices(pool.poolId));
  const inputSlices = inputIsBase ? slices.base : slices.quote;
  const outputSlices = inputIsBase ? slices.quote : slices.base;
  const headInput = inputSlices[0];
  if (!headInput) throw new Error(`pool has no ${cfg.swapInSide}-side slice to receive the swap input`);

  const swapIn = dec.parseDecimal(cfg.swapIn);
  const reserveIn = dec.parseDecimal(inputIsBase ? addState.arg.reserves.baseAmount : addState.arg.reserves.quoteAmount);
  const reserveOut = dec.parseDecimal(inputIsBase ? addState.arg.reserves.quoteAmount : addState.arg.reserves.baseAmount);
  const expectedOut = constantProductOut(reserveIn, reserveOut, feeBps, swapIn);
  if (expectedOut <= 0n) throw new Error(`swap of ${cfg.swapIn} ${inputId} prices out at 0 ${outputId}`);
  if (expectedOut >= reserveOut) throw new Error(`swap of ${cfg.swapIn} ${inputId} would drain the ${outputId} reserve`);
  // The provided prefix has to cover amountOut; the ledger draws from the
  // front of it and leaves the rest untouched.
  const outputSliceCids: string[] = [];
  let covered = 0n;
  for (const s of outputSlices) {
    outputSliceCids.push(s.contractId);
    covered += dec.parseDecimal(argOf<SliceArg>(s).amount);
    if (covered >= expectedOut) break;
  }
  if (covered < expectedOut) {
    throw new Error(`${outputId} slices cover ${dec.formatDecimal(covered)}, need ${dec.formatDecimal(expectedOut)}`);
  }

  const inBefore = await balance(swapper, pool.admin, inputId);
  const outBefore = await balance(swapper, pool.admin, outputId);

  const swapReq = await step("PoolRules_RequestSwap", async () => {
    const tx = await submit([cfg.operator], cmdId("swap-req"), [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolRules:PoolRules"), contractId: ctx.rulesC.contractId,
        choice: "PoolRules_RequestSwap",
        choiceArgument: {
          poolCid: ctx.poolC.contractId, swapper,
          inputInstrumentId: inputId, inputAmount: cfg.swapIn,
        },
      },
    }]);
    const result = exercisedResult(tx, "PoolRules_RequestSwap")
      ?? (await treeExercisedResult(tx.transaction.updateId, cfg.operator, "PoolRules_RequestSwap"));
    if (result) return result as SwapRequestResult;
    // The participant served neither the choice result nor a tree, so rebuild
    // what the choice returns (PoolModel.poolSettlement +
    // Utils.mkPrefundedAllocationSpecification). Nothing is taken on trust:
    // the registry re-checks the funding at allocate and PoolRules_Swap
    // re-checks every leg at settle, so a wrong spec aborts the swap.
    console.log("  ..  choice result unavailable, rebuilding the allocation spec locally");
    return {
      settlement: { executors: [cfg.operator], id: "DexPool", cid: ctx.poolC.contractId, meta: { values: {} } },
      allocationSpec: {
        admin: pool.admin, authorizer: acct(swapper), transferLegSides: [],
        settlementDeadline: null, nextIterationFunding: { [inputId]: cfg.swapIn },
        committed: false, meta: { values: {} },
      },
    } satisfies SwapRequestResult;
  });

  // The swapper is an arbitrary party (a faucet tester in the real flow), so it
  // is not an observer of the asset registry. Disclose the registry to it.
  const registryDisclosure = await step("disclose registry to the swapper", () =>
    discloseRegistry(pool.admin, ctx.registryCid));

  const swapAlloc = await step("swapper authors the input allocation", () =>
    authorAlloc(swapper, ctx.registryCid, swapReq.settlement, swapReq.allocationSpec, [swapHoldingCid],
      "swap-in", registryDisclosure));

  const swapState = await step("PoolRules_Swap", async () => {
    const tx = await submit([cfg.operator], cmdId("swap", swapAlloc), [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolRules:PoolRules"), contractId: ctx.rulesC.contractId,
        choice: "PoolRules_Swap",
        choiceArgument: {
          expectedPoolId: pool.poolId, poolCid: ctx.poolC.contractId, poolStateCid: addState.cid,
          swapperAccount: acct(swapper), inputInstrumentId: inputId, inputAmount: cfg.swapIn,
          // The off-ledger quote IS the slippage floor: if the ledger prices
          // the swap any lower than the constant-product expectation, the
          // choice aborts instead of settling a swap this script would then
          // have to explain.
          minOutputAmount: dec.formatDecimal(expectedOut),
          swapperAllocationCid: swapAlloc,
          inputSliceCid: headInput.contractId, outputSliceCids,
          factoryCid: ctx.registryCid, extraArgs: EXTRA,
        },
      },
    }], [swapper]);
    const ps = creates(tx, "CantonDex.Dex.PoolState:PoolState")
      .find((c) => argOf<PoolStateArg>(c).poolId === pool.poolId);
    if (!ps) throw new Error("swap did not write a PoolState for this pool");
    return { cid: ps.contractId, arg: argOf<PoolStateArg>(ps) };
  });

  // 5. Assert the swap on the ledger's own numbers --------------------------
  const newBase = dec.parseDecimal(swapState.arg.reserves.baseAmount);
  const newQuote = dec.parseDecimal(swapState.arg.reserves.quoteAmount);
  const oldBase = dec.parseDecimal(addState.arg.reserves.baseAmount);
  const oldQuote = dec.parseDecimal(addState.arg.reserves.quoteAmount);
  eq(swapState.arg.status, "PS_Active", "pool still active after swap");
  eqDec(newBase, inputIsBase ? oldBase + swapIn : oldBase - expectedOut, "base reserve after swap");
  eqDec(newQuote, inputIsBase ? oldQuote - expectedOut : oldQuote + swapIn, "quote reserve after swap");
  eqDec(dec.parseDecimal(swapState.arg.totalLpSupply), dec.parseDecimal(addState.arg.totalLpSupply), "LP supply unchanged by the swap");
  // The fee stays in the pool, so the invariant may only grow.
  atLeast(dec.mul(newBase, newQuote), dec.mul(oldBase, oldQuote), "x*y=k non-decreasing");

  const inAfter = await balance(swapper, pool.admin, inputId);
  const outAfter = await balance(swapper, pool.admin, outputId);
  eqDec(inBefore - inAfter, swapIn, `swapper paid ${inputId}`);
  eqDec(outAfter - outBefore, expectedOut, `swapper received ${outputId}`);

  // Reserves are derived state; the slices are the funds. Prove they still
  // agree ON-LEDGER (the choice aborts if any per-side sum diverges).
  const reconciled = await step("PoolRules_ReconcileState", async () => {
    const s = await poolSlices(pool.poolId);
    const cids = [...s.base, ...s.quote].map((c) => c.contractId);
    await submit([cfg.operator], cmdId("reconcile", swapState.cid), [{
      ExerciseCommand: {
        templateId: tid("CantonDex.Dex.PoolRules:PoolRules"), contractId: ctx.rulesC.contractId,
        choice: "PoolRules_ReconcileState",
        choiceArgument: {
          expectedPoolId: pool.poolId, poolCid: ctx.poolC.contractId,
          poolStateCid: swapState.cid, sliceCids: cids,
        },
      },
    }]);
    return { slices: cids.length };
  });

  console.log(`\nfinal reserves: ${swapState.arg.reserves.baseAmount} ${pool.baseInstrumentId} / ${swapState.arg.reserves.quoteAmount} ${pool.quoteInstrumentId}`);
  console.log(`swap: in ${cfg.swapIn} ${inputId} -> out ${dec.formatDecimal(expectedOut)} ${outputId} (fee ${feeBps}bps, ${reconciled.slices} slices reconciled)`);
  console.log(`swapper balances: ${inputId} ${dec.formatDecimal(inBefore)} -> ${dec.formatDecimal(inAfter)}, ${outputId} ${dec.formatDecimal(outBefore)} -> ${dec.formatDecimal(outAfter)}`);
  console.log(`LP supply ${swapState.arg.totalLpSupply}`);
  console.log("PASS: existing pool seeded via the wallet-authored DvP add, and a swap settled and asserted against it");
}

/** Unlocked balance of one instrument, as issued by `admin`. */
async function balance(party: string, admin: string, instrumentId: string): Promise<bigint> {
  const holdings = await acs(party, "CantonDex.Registry.V2:Holding");
  return holdings
    .map((c) => argOf<HoldingArg>(c))
    .filter((h) => h.owner === party && h.admin === admin && h.instrumentId === instrumentId && !h.locked)
    .reduce((sum, h) => sum + dec.parseDecimal(h.amount), 0n);
}

const lpBalance = (party: string, pool: PoolArg): Promise<bigint> =>
  balance(party, pool.lpInstrumentId.admin, pool.lpInstrumentId.id);

/** The pool's active slices, split by side, in ACS order. */
async function poolSlices(poolId: string): Promise<{ base: Created[]; quote: Created[] }> {
  const all = (await acs(cfg.operator, "CantonDex.Dex.PoolSlice:PoolSlice"))
    .filter((c) => argOf<SliceArg>(c).poolId === poolId && argOf<SliceArg>(c).operator === cfg.operator);
  return {
    base: all.filter((c) => argOf<SliceArg>(c).side === "BaseSide"),
    quote: all.filter((c) => argOf<SliceArg>(c).side === "QuoteSide"),
  };
}

main().catch((e) => { console.error("FATAL", (e as Error).message); process.exit(1); });
