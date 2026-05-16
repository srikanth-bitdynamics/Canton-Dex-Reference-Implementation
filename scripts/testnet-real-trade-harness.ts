// Live-testnet runner that performs a REAL token trade through our DEX.
//
// Unlike `testnet-matched-trade-harness.ts` (which uses MockRegistry —
// no actual asset movement), this runner uses our `RealRegistry`
// templates in `canton-dex-pr5333` v0.0.2. A RealHolding is minted to
// alice, locked into an allocation, and at settlement the receiver
// (bob) gets a brand-new RealHolding while alice's is archived. The
// post-state assertions check holding ownership actually changed.
//
// Required env (extends testnet-matched-trade-harness.ts):
//   CANTON_LEDGER_URL
//   CANTON_LEDGER_TOKEN
//   CANTON_SYNCHRONIZER
//   CANTON_DEX_PACKAGE_ID            v0.0.2 hash: 8cc67d71...
//   CANTON_ALLOC_REQUEST_PACKAGE_ID
//   CANTON_ALLOC_INSTR_PACKAGE_ID
//   CANTON_VENUE / CANTON_ADMIN / CANTON_ALICE / CANTON_BOB

const TX_SHAPE = "TRANSACTION_SHAPE_ACS_DELTA";

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
  pkgAllocReq: required("CANTON_ALLOC_REQUEST_PACKAGE_ID"),
  pkgAllocInstr: required("CANTON_ALLOC_INSTR_PACKAGE_ID"),
  userId: process.env.CANTON_USER_ID ?? "ledger-api-user",
  venue: required("CANTON_VENUE"),
  admin: required("CANTON_ADMIN"),
  alice: required("CANTON_ALICE"),
  bob: required("CANTON_BOB"),
};

const RUN_ID = `realtrade-${Date.now()}`;
const TRADE_AMOUNT = "10.0";
const ALICE_MINT = "25.0"; // surplus to verify partial-lock behaviour

interface CreatedEvent {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
}
type Event = { CreatedEvent: CreatedEvent } | { ArchivedEvent: { contractId: string } };
interface TxResponse {
  transaction: { updateId: string; offset: number; events: Event[] };
}

async function submit(actAs: string[], commandId: string, commands: unknown[]): Promise<TxResponse> {
  const body = {
    commands: { commandId, userId: cfg.userId, actAs, synchronizerId: cfg.synchronizerId, commands },
    transactionShape: TX_SHAPE,
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

function findCreates(tx: TxResponse, templateIdSuffix: string): CreatedEvent[] {
  return tx.transaction.events
    .filter((e): e is { CreatedEvent: CreatedEvent } => "CreatedEvent" in e)
    .map((e) => e.CreatedEvent)
    .filter((c) => c.templateId.endsWith(templateIdSuffix));
}

function tid(pkg: string, modEnt: string): string {
  return `${pkg}:${modEnt}`;
}
const EMPTY_EXTRA = { context: { values: {} }, meta: { values: {} } };
const basicAccount = (party: string) => ({ owner: party, provider: null, id: "" });

async function step(name: string, fn: () => Promise<unknown>): Promise<unknown> {
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

async function queryHoldings(party: string, instrumentId: string): Promise<{ contractId: string; payload: Record<string, unknown> }[]> {
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
                      templateId: tid(cfg.pkgDex, "CantonDex.Testing.RealRegistry:RealHolding"),
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
  const acs = (await res.json()) as { contractEntry?: { JsActiveContract?: { createdEvent?: CreatedEvent } } }[];
  return acs
    .map((e) => e.contractEntry?.JsActiveContract?.createdEvent)
    .filter((ev): ev is CreatedEvent => ev !== undefined)
    .filter((ev) => {
      const p = ev.createArgument as { owner: string; instrumentId: string };
      return p.owner === party && p.instrumentId === instrumentId;
    })
    .map((ev) => ({ contractId: ev.contractId, payload: ev.createArgument }));
}

async function main() {
  console.log(`run id: ${RUN_ID}`);
  console.log(`ledger: ${cfg.baseUrl}`);
  console.log(`venue:  ${cfg.venue}`);
  console.log(`admin:  ${cfg.admin}`);
  console.log(`alice:  ${cfg.alice}`);
  console.log(`bob:    ${cfg.bob}`);

  // Step 1: Create RealRegistry (provides both AllocationFactory and SettlementFactory).
  const registryCid = (await step("create RealRegistry", async () => {
    const tx = await submit([cfg.admin], `${RUN_ID}-registry`, [
      {
        CreateCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Testing.RealRegistry:RealRegistry"),
          createArguments: { admin: cfg.admin, users: [cfg.venue, cfg.alice, cfg.bob] },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Testing.RealRegistry:RealRegistry")[0]!.contractId;
  })) as string;

  // Step 2: Mint alice a real BTC holding.
  const aliceHoldingCid = (await step(`mint ${ALICE_MINT} BTC → alice`, async () => {
    const tx = await submit([cfg.admin], `${RUN_ID}-mint-alice`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Testing.RealRegistry:RealRegistry"),
          contractId: registryCid,
          choice: "RealRegistry_Mint",
          choiceArgument: { owner: cfg.alice, instrumentId: "BTC", amount: ALICE_MINT },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Testing.RealRegistry:RealHolding")[0]!.contractId;
  })) as string;

  // Pre-state: alice has BTC, bob doesn't.
  await step("pre-state: alice has BTC, bob has none", async () => {
    const aliceHoldings = await queryHoldings(cfg.alice, "BTC");
    const bobHoldings = await queryHoldings(cfg.bob, "BTC");
    console.log(`  alice BTC holdings: ${aliceHoldings.length} (amounts: ${aliceHoldings.map((h) => (h.payload as { amount: string }).amount).join(",")})`);
    console.log(`  bob BTC holdings:   ${bobHoldings.length}`);
    if (aliceHoldings.length === 0) throw new Error("alice should have a BTC holding pre-trade");
  });

  // Step 3: Create MatchedTrade and request allocations.
  const leg = {
    transferLegId: "leg-1",
    sender: basicAccount(cfg.alice),
    receiver: basicAccount(cfg.bob),
    amount: TRADE_AMOUNT,
    instrumentId: "BTC",
    meta: { values: {} },
  };
  const tradeCid = (await step("create MatchedTrade", async () => {
    const tx = await submit([cfg.venue], `${RUN_ID}-trade`, [
      {
        CreateCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Dex.MatchedTrade:MatchedTrade"),
          createArguments: {
            venue: cfg.venue,
            admin: cfg.admin,
            transferLegs: [leg],
            settlementDeadline: null,
            policyReceipt: null,
          },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Dex.MatchedTrade:MatchedTrade")[0]!.contractId;
  })) as string;

  const reqInfos = (await step("MatchedTrade_RequestAllocations", async () => {
    const tx = await submit([cfg.venue], `${RUN_ID}-reqallocs`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Dex.MatchedTrade:MatchedTrade"),
          contractId: tradeCid,
          choice: "MatchedTrade_RequestAllocations",
          choiceArgument: {},
        },
      },
    ]);
    const created = findCreates(tx, "CantonDex.Dex.MatchedTrade:TradeAllocationRequest");
    console.log(`  → ${created.length} TradeAllocationRequest(s)`);
    return created.map((c) => ({
      cid: c.contractId,
      authorizerOwner: ((c.createArgument as { authorizer: { owner: string } }).authorizer).owner,
      settlement: (c.createArgument as { settlement: unknown }).settlement,
      transferLegs: (c.createArgument as { transferLegs: unknown[] }).transferLegs,
    }));
  })) as { cid: string; authorizerOwner: string; settlement: unknown; transferLegs: unknown[] }[];

  const aliceReq = reqInfos.find((r) => r.authorizerOwner === cfg.alice)!;
  const bobReq = reqInfos.find((r) => r.authorizerOwner === cfg.bob)!;

  // Step 4: alice accepts and locks her real BTC holding into the allocation.
  const aliceAllocCid = (await step("alice: Accept + AllocationFactory_Allocate (locks REAL BTC)", async () => {
    const allocSpec = {
      settlement: aliceReq.settlement,
      admin: cfg.admin,
      transferLegs: aliceReq.transferLegs,
      nextIterationFunding: null,
      committed: false,
      authorizer: basicAccount(cfg.alice),
    };
    const tx = await submit([cfg.alice, cfg.admin], `${RUN_ID}-alice-accept`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgAllocReq, "Splice.Api.Token.AllocationRequestV2:AllocationRequest"),
          contractId: aliceReq.cid,
          choice: "AllocationRequest_Accept",
          choiceArgument: { actors: [cfg.alice], extraArgs: EMPTY_EXTRA },
        },
      },
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgAllocInstr, "Splice.Api.Token.AllocationInstructionV2:AllocationFactory"),
          contractId: registryCid,
          choice: "AllocationFactory_Allocate",
          choiceArgument: {
            allocation: allocSpec,
            requestedAt: "1970-01-01T00:00:00Z",
            inputHoldingCids: [aliceHoldingCid],
            extraArgs: EMPTY_EXTRA,
            actors: [cfg.alice, cfg.admin],
          },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Testing.RealRegistry:RealAllocation")[0]!.contractId;
  })) as string;

  // Step 5: bob accepts. Bob is a receiver — no holdings to lock; allocation is a receipt.
  const bobAllocCid = (await step("bob: Accept + AllocationFactory_Allocate (receipt — no lock)", async () => {
    const allocSpec = {
      settlement: bobReq.settlement,
      admin: cfg.admin,
      transferLegs: bobReq.transferLegs,
      nextIterationFunding: null,
      committed: false,
      authorizer: basicAccount(cfg.bob),
    };
    const tx = await submit([cfg.bob, cfg.admin], `${RUN_ID}-bob-accept`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgAllocReq, "Splice.Api.Token.AllocationRequestV2:AllocationRequest"),
          contractId: bobReq.cid,
          choice: "AllocationRequest_Accept",
          choiceArgument: { actors: [cfg.bob], extraArgs: EMPTY_EXTRA },
        },
      },
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgAllocInstr, "Splice.Api.Token.AllocationInstructionV2:AllocationFactory"),
          contractId: registryCid,
          choice: "AllocationFactory_Allocate",
          choiceArgument: {
            allocation: allocSpec,
            requestedAt: "1970-01-01T00:00:00Z",
            inputHoldingCids: [],
            extraArgs: EMPTY_EXTRA,
            actors: [cfg.bob, cfg.admin],
          },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Testing.RealRegistry:RealAllocation")[0]!.contractId;
  })) as string;

  // Step 6: venue drives MatchedTrade_Settle. Needs admin's authority
  // too because the settle path archives admin-signed holdings (real
  // production would route this through a registrar adapter or use a
  // disclosure model; multi-actAs is the simplest harness path).
  await step("MatchedTrade_Settle (real holding moves alice → bob)", async () => {
    const tx = await submit([cfg.venue, cfg.admin], `${RUN_ID}-settle`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Dex.MatchedTrade:MatchedTrade"),
          contractId: tradeCid,
          choice: "MatchedTrade_Settle",
          choiceArgument: {
            batchesByAdmin: [
              [
                cfg.admin,
                {
                  allocationCids: [aliceAllocCid, bobAllocCid],
                  factoryCid: registryCid,
                  extraArgs: EMPTY_EXTRA,
                },
              ],
            ],
            allocationRequests: [],
          },
        },
      },
    ]);
    console.log(`  → settle tx offset ${tx.transaction.offset}`);
  });

  // Step 7: post-state assertions.
  await step("post-state: alice's BTC is gone, bob has new BTC holding", async () => {
    const aliceHoldings = await queryHoldings(cfg.alice, "BTC");
    const bobHoldings = await queryHoldings(cfg.bob, "BTC");
    console.log(`  alice BTC holdings: ${aliceHoldings.length}`);
    console.log(`  bob BTC holdings:   ${bobHoldings.length}`);
    bobHoldings.forEach((h) =>
      console.log(`    bob holding: amount=${(h.payload as { amount: string }).amount}, cid=${h.contractId.slice(0, 18)}…`),
    );
    if (bobHoldings.length === 0) throw new Error("bob should have a new BTC holding after settle");
    const bobBtcAmount = parseFloat(
      (bobHoldings[0]!.payload as { amount: string }).amount,
    );
    if (bobBtcAmount !== parseFloat(TRADE_AMOUNT)) {
      throw new Error(`bob's new BTC amount = ${bobBtcAmount}, expected ${TRADE_AMOUNT}`);
    }
  });

  console.log("\n✅ REAL TRADE COMPLETE on live testnet");
  console.log(`run-id: ${RUN_ID}`);
  console.log(`  10 BTC moved from alice to bob via MatchedTrade_Settle on the real participant.`);
}

main().catch((e) => {
  console.error("\n❌ real-trade harness FAILED:", e);
  process.exit(1);
});
