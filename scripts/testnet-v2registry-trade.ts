// Matched-trade settlement against a live Canton participant using the
// V2 Registry as AllocationFactory + SettlementFactory + TransferFactory.
// Registers an instrument, mints to alice, posts a MatchedTrade, runs
// the V2 allocation accept on both sides, settles via SettleBatch.

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

const RUN_ID = `v2reg-${Date.now()}`;
const TRADE_AMOUNT = "10.0";
const ALICE_MINT = "25.0";
const SUPPLY_CAP = "1000000.0";

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

function findCreates(tx: TxResponse, templateIdSuffix: string): CreatedEvent[] {
  return tx.transaction.events
    .filter((e): e is { CreatedEvent: CreatedEvent } => "CreatedEvent" in e)
    .map((e) => e.CreatedEvent)
    .filter((c) => c.templateId.endsWith(templateIdSuffix));
}

const tid = (pkg: string, modEnt: string) => `${pkg}:${modEnt}`;
const EMPTY_EXTRA = { context: { values: {} }, meta: { values: {} } };
const basicAccount = (party: string) => ({ owner: party, provider: null, id: "" });

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

async function queryHoldings(party: string, instrumentId: string) {
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
                      // Canton 3.5+ requires `#package-name` in query filters.
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
  console.log(`registry package: canton-dex-trading v0.0.3 (${cfg.pkgDex.slice(0, 12)}…)`);
  console.log(`venue:  ${cfg.venue}`);
  console.log(`admin:  ${cfg.admin}  (instrument issuer)`);
  console.log(`alice:  ${cfg.alice}  (sender)`);
  console.log(`bob:    ${cfg.bob}   (receiver)`);

  // Create the reference registry (acts as AllocationFactory + SettlementFactory).
  const registryCid = await step("create reference Registry (implements V2 holding/allocation/settlement)", async () => {
    const tx = await submit([cfg.admin], `${RUN_ID}-registry`, [
      {
        CreateCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Registry.V2:Registry"),
          createArguments: { admin: cfg.admin, users: [cfg.venue, cfg.alice, cfg.bob] },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Registry.V2:Registry")[0]!.contractId;
  });

  // Register BTC under a supply cap, open credential reqs for the demo.
  const instrumentConfigCid = await step("Registry_RegisterInstrument (BTC, supply cap 1M)", async () => {
    const tx = await submit([cfg.admin], `${RUN_ID}-register-btc`, [
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

  // Mint BTC to alice (also rotates the InstrumentConfig CID).

  const aliceHoldingCid = await step(`Registry_Mint ${ALICE_MINT} BTC → alice (enforces cap + cred)`, async () => {
    const tx = await submit([cfg.admin, cfg.alice], `${RUN_ID}-mint-alice`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Registry.V2:Registry"),
          contractId: registryCid,
          choice: "Registry_Mint",
          choiceArgument: {
            configCid: instrumentConfigCid,
            owner: cfg.alice,
            amount: ALICE_MINT,
            issuerClaims: [],
          },
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Registry.V2:Holding")[0]!.contractId;
  });

  await step("pre-state: alice 25 BTC, bob 0 BTC", async () => {
    const a = await queryHoldings(cfg.alice, "BTC");
    const b = await queryHoldings(cfg.bob, "BTC");
    console.log(`  alice: ${a.length} (${a.map((h) => (h.payload as { amount: string }).amount).join(",")})`);
    console.log(`  bob:   ${b.length}`);
    if (a.length === 0) throw new Error("alice should have a BTC holding pre-trade");
  });

  // Venue posts the MatchedTrade.
  const leg = {
    transferLegId: "leg-1",
    sender: basicAccount(cfg.alice),
    receiver: basicAccount(cfg.bob),
    amount: TRADE_AMOUNT,
    instrumentId: "BTC",
    meta: { values: {} },
  };
  const tradeCid = await step("create MatchedTrade", async () => {
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
  });

  // Venue requests allocations — one per counterparty.
  const reqInfos = await step("MatchedTrade_RequestAllocations", async () => {
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
    // TradeAllocationRequest carries bidirectional TransferLegs;
    // AllocationSpecification expects one-sided TransferLegSides.
    type Leg = { transferLegId: string; sender: { owner: string }; receiver: { owner: string }; amount: string; instrumentId: string; meta: unknown };
    const legToSide = (authorizer: string, leg: Leg) =>
      leg.sender.owner === authorizer
        ? { transferLegId: leg.transferLegId, side: "SenderSide", otherside: leg.receiver, amount: leg.amount, instrumentId: leg.instrumentId, meta: leg.meta }
        : { transferLegId: leg.transferLegId, side: "ReceiverSide", otherside: leg.sender, amount: leg.amount, instrumentId: leg.instrumentId, meta: leg.meta };
    return findCreates(tx, "CantonDex.Dex.MatchedTrade:TradeAllocationRequest").map((c) => {
      const args = c.createArgument as { authorizer: { owner: string }; settlement: unknown; transferLegs: Leg[] };
      return {
        cid: c.contractId,
        authorizerOwner: args.authorizer.owner,
        settlement: args.settlement,
        transferLegSides: args.transferLegs.map((l) => legToSide(args.authorizer.owner, l)),
      };
    });
  });
  const aliceReq = reqInfos.find((r) => r.authorizerOwner === cfg.alice)!;
  const bobReq = reqInfos.find((r) => r.authorizerOwner === cfg.bob)!;

  // Alice accepts and allocates her side (coverage-enforced by the factory).
  const aliceAllocCid = await step("alice: Accept + AllocationFactory_Allocate (coverage check)", async () => {
    const allocSpec = {
      settlement: aliceReq.settlement,
      admin: cfg.admin,
      transferLegSides: aliceReq.transferLegSides,
      nextIterationFunding: null,
      committed: false,
      authorizer: basicAccount(cfg.alice),
      meta: { values: {} },
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
    return findCreates(tx, "CantonDex.Registry.V2:Allocation")[0]!.contractId;
  });

  // Bob accepts and allocates his side (receipt; no holdings locked).
  const bobAllocCid = await step("bob: Accept + AllocationFactory_Allocate (receipt)", async () => {
    const allocSpec = {
      settlement: bobReq.settlement,
      admin: cfg.admin,
      transferLegSides: bobReq.transferLegSides,
      nextIterationFunding: null,
      committed: false,
      authorizer: basicAccount(cfg.bob),
      meta: { values: {} },
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
    return findCreates(tx, "CantonDex.Registry.V2:Allocation")[0]!.contractId;
  });

  // Venue + admin settle the batch.
  await step("MatchedTrade_Settle (V2 SettlementFactory_SettleBatch under the hood)", async () => {
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
                  allocations: [
                    { allocationCid: aliceAllocCid, extraTransferLegSides: [], nextIterationFunding: null },
                    { allocationCid: bobAllocCid, extraTransferLegSides: [], nextIterationFunding: null },
                  ],
                  factoryCid: registryCid,
                  extraArgs: EMPTY_EXTRA,
                },
              ],
            ],
            allocationRequests: [],
            dexPairCid: null,
          },
        },
      },
    ]);
    console.log(`  → settle tx offset ${tx.transaction.offset}`);
  });

  await step("post-state: bob has 10 BTC, supply intact", async () => {
    const a = await queryHoldings(cfg.alice, "BTC");
    const b = await queryHoldings(cfg.bob, "BTC");
    console.log(`  alice: ${a.length}`);
    console.log(`  bob:   ${b.length}`);
    b.forEach((h) =>
      console.log(`    bob holding: amount=${(h.payload as { amount: string }).amount}, cid=${h.contractId.slice(0, 18)}…`),
    );
    if (b.length === 0) throw new Error("bob should have a new BTC holding");
    const bAmt = parseFloat((b[0]!.payload as { amount: string }).amount);
    if (bAmt !== parseFloat(TRADE_AMOUNT)) throw new Error(`bob amount ${bAmt} != ${TRADE_AMOUNT}`);
  });

  console.log(`\nmatched-trade complete. run-id: ${RUN_ID}`);
}

main().catch((e) => {
  console.error("\nmatched-trade FAILED:", e);
  process.exit(1);
});
