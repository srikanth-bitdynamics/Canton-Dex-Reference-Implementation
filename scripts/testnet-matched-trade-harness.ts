// Live-testnet runner for the token-standard harness test.
//
// Mirrors `pr5333-tests/CantonDex/Tests/TokenStandardHarnessTests.daml`
// (testMatchedTradeViaTokenStandardRegistry) but submits each step to
// the real Canton participant via JSON Ledger API instead of running
// inside Daml Script. Exits 0 on full success, non-zero on any
// unexpected response or assertion failure.
//
// Why: validates that the same V2-allocation flow Splice uses to test
// TradingAppV2 also works on the live ledger for our DEX. The in-Daml-
// Script test proves API conformance; this runner proves the deployed
// DEX accepts and executes the same flow end-to-end on the testnet.
//
// Required env (same shape as services/operator-backend/src/testnet-server.ts):
//   CANTON_LEDGER_URL
//   CANTON_LEDGER_TOKEN
//   CANTON_SYNCHRONIZER
//   CANTON_DEX_PACKAGE_ID           e.g. 90f5e9123c...
//   CANTON_ALLOC_REQUEST_PACKAGE_ID e.g. 6912769c...   (splice-api-token-allocation-request-v2)
//   CANTON_ALLOC_INSTR_PACKAGE_ID   e.g. 24d26b2d...   (splice-api-token-allocation-instruction-v2)
//   CANTON_USER_ID                  defaults: ledger-api-user
//   CANTON_VENUE
//   CANTON_ADMIN
//   CANTON_ALICE
//   CANTON_BOB

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

const RUN_ID = `harness-${Date.now()}`;

interface CreatedEvent {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
}
interface ExercisedEvent {
  contractId: string;
  templateId: string;
  choice: string;
  exerciseResult: unknown;
}
type Event =
  | { CreatedEvent: CreatedEvent }
  | { ExercisedEvent: ExercisedEvent };

interface TxResponse {
  transaction: {
    updateId: string;
    offset: number;
    events: Event[];
  };
}

async function submit(
  actAs: string[],
  commandId: string,
  commands: unknown[],
): Promise<TxResponse> {
  const body = {
    commands: {
      commandId,
      userId: cfg.userId,
      actAs,
      synchronizerId: cfg.synchronizerId,
      commands,
    },
    transactionShape: TX_SHAPE,
  };
  const res = await fetch(
    `${cfg.baseUrl}/v2/commands/submit-and-wait-for-transaction`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`submit ${commandId} → HTTP ${res.status}: ${text}`);
  }
  return JSON.parse(text) as TxResponse;
}

function findCreates(tx: TxResponse, templateIdSuffix: string): CreatedEvent[] {
  return tx.transaction.events
    .filter((e): e is { CreatedEvent: CreatedEvent } => "CreatedEvent" in e)
    .map((e) => e.CreatedEvent)
    .filter((c) => c.templateId.endsWith(templateIdSuffix));
}

function findExercise(tx: TxResponse, choice: string): ExercisedEvent {
  const ex = tx.transaction.events
    .filter((e): e is { ExercisedEvent: ExercisedEvent } => "ExercisedEvent" in e)
    .map((e) => e.ExercisedEvent)
    .find((e) => e.choice === choice);
  if (!ex) throw new Error(`no ExercisedEvent for ${choice}`);
  return ex;
}

function tid(pkg: string, modEnt: string): string {
  return `${pkg}:${modEnt}`;
}

const EMPTY_EXTRA = {
  context: { values: {} },
  meta: { values: {} },
};

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

function basicAccount(party: string) {
  return { owner: party, provider: null, id: "" };
}

async function main() {
  console.log(`run id: ${RUN_ID}`);
  console.log(`ledger: ${cfg.baseUrl}`);
  console.log(`venue:  ${cfg.venue}`);
  console.log(`admin:  ${cfg.admin}`);
  console.log(`alice:  ${cfg.alice}`);
  console.log(`bob:    ${cfg.bob}`);

  // Step 1: Bring up the DexRegistry — two factory contracts.
  const allocFactoryCid = (await step("create MockAllocationFactory", async () => {
    const tx = await submit(
      [cfg.admin],
      `${RUN_ID}-alloc-factory`,
      [
        {
          CreateCommand: {
            templateId: tid(cfg.pkgDex, "CantonDex.Testing.MockRegistry:MockAllocationFactory"),
            createArguments: {
              admin: cfg.admin,
              users: [cfg.venue, cfg.alice, cfg.bob],
            },
          },
        },
      ],
    );
    return findCreates(tx, "CantonDex.Testing.MockRegistry:MockAllocationFactory")[0]!.contractId;
  })) as string;

  const settleFactoryCid = (await step("create MockSettlementFactory", async () => {
    const tx = await submit(
      [cfg.admin],
      `${RUN_ID}-settle-factory`,
      [
        {
          CreateCommand: {
            templateId: tid(cfg.pkgDex, "CantonDex.Testing.MockRegistry:MockSettlementFactory"),
            createArguments: {
              admin: cfg.admin,
              users: [cfg.venue, cfg.alice, cfg.bob],
            },
          },
        },
      ],
    );
    return findCreates(tx, "CantonDex.Testing.MockRegistry:MockSettlementFactory")[0]!.contractId;
  })) as string;

  // Step 2: Create MatchedTrade (alice → bob, 10 BTC).
  const leg = {
    transferLegId: "leg-1",
    sender: basicAccount(cfg.alice),
    receiver: basicAccount(cfg.bob),
    amount: "10.0",
    instrumentId: "BTC",
    meta: { values: {} },
  };
  const tradeCreateArgs = {
    venue: cfg.venue,
    admin: cfg.admin,
    transferLegs: [leg],
    settlementDeadline: null,
    policyReceipt: null,
  };

  const tradeCid = (await step("create MatchedTrade", async () => {
    const tx = await submit([cfg.venue], `${RUN_ID}-trade`, [
      {
        CreateCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Dex.MatchedTrade:MatchedTrade"),
          createArguments: tradeCreateArgs,
        },
      },
    ]);
    return findCreates(tx, "CantonDex.Dex.MatchedTrade:MatchedTrade")[0]!.contractId;
  })) as string;

  // Step 3: venue exercises MatchedTrade_RequestAllocations.
  const reqCids = (await step("MatchedTrade_RequestAllocations", async () => {
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
    // The choice's result is [ContractId TradeAllocationRequest]; the
    // CIDs also show up as CreatedEvents in this transaction.
    const created = findCreates(tx, "CantonDex.Dex.MatchedTrade:TradeAllocationRequest");
    console.log(`  → ${created.length} TradeAllocationRequest(s) created`);
    return created.map((c) => ({
      cid: c.contractId,
      authorizerOwner: ((c.createArgument as { authorizer: { owner: string } }).authorizer)
        .owner,
      settlement: (c.createArgument as { settlement: unknown }).settlement,
      transferLegs: (c.createArgument as { transferLegs: unknown[] }).transferLegs,
    }));
  })) as { cid: string; authorizerOwner: string; settlement: unknown; transferLegs: unknown[] }[];

  if (reqCids.length !== 2) {
    throw new Error(`expected 2 allocation requests, got ${reqCids.length}`);
  }
  const aliceReq = reqCids.find((r) => r.authorizerOwner === cfg.alice);
  const bobReq = reqCids.find((r) => r.authorizerOwner === cfg.bob);
  if (!aliceReq || !bobReq) {
    throw new Error(
      `request authorizers mismatch: ${reqCids.map((r) => r.authorizerOwner).join(", ")}`,
    );
  }

  // Step 4 & 5: trader Accept + AllocationFactory_Allocate composed in
  // the same submission (mirrors the upstream `WalletClientV2.acceptAllocationRequestV2`).
  const acceptAndAllocate = async (
    trader: string,
    req: typeof aliceReq,
  ): Promise<string> => {
    const allocSpec = {
      settlement: req.settlement,
      admin: cfg.admin,
      transferLegs: req.transferLegs,
      nextIterationFunding: null,
      committed: false,
      authorizer: basicAccount(trader),
    };
    // Canton 3 JSON API does not use a separate `ExerciseByInterfaceCommand`
    // tag — interface choices exercise via the same `ExerciseCommand`
    // envelope, with the interface id passed in `templateId`. The
    // participant resolves the choice against the interface.
    const tx = await submit(
      [trader],
      `${RUN_ID}-accept-${trader.split("::")[0]}`,
      [
        {
          ExerciseCommand: {
            templateId: tid(cfg.pkgAllocReq, "Splice.Api.Token.AllocationRequestV2:AllocationRequest"),
            contractId: req.cid,
            choice: "AllocationRequest_Accept",
            choiceArgument: { actors: [trader], extraArgs: EMPTY_EXTRA },
          },
        },
        {
          ExerciseCommand: {
            templateId: tid(cfg.pkgAllocInstr, "Splice.Api.Token.AllocationInstructionV2:AllocationFactory"),
            contractId: allocFactoryCid,
            choice: "AllocationFactory_Allocate",
            choiceArgument: {
              allocation: allocSpec,
              requestedAt: "1970-01-01T00:00:00Z",
              inputHoldingCids: [],
              extraArgs: EMPTY_EXTRA,
              actors: [trader],
            },
          },
        },
      ],
    );
    const created = findCreates(tx, "CantonDex.Testing.MockRegistry:MockAllocation");
    if (created.length !== 1) {
      throw new Error(`expected 1 MockAllocation created for ${trader}, got ${created.length}`);
    }
    return created[0]!.contractId;
  };

  const aliceAllocCid = (await step("alice: Accept + AllocationFactory_Allocate", () =>
    acceptAndAllocate(cfg.alice, aliceReq),
  )) as string;
  const bobAllocCid = (await step("bob: Accept + AllocationFactory_Allocate", () =>
    acceptAndAllocate(cfg.bob, bobReq),
  )) as string;

  // Step 6: venue settles via MatchedTrade_Settle.
  await step("MatchedTrade_Settle (batch with 2 allocations)", async () => {
    const tx = await submit([cfg.venue], `${RUN_ID}-settle`, [
      {
        ExerciseCommand: {
          templateId: tid(cfg.pkgDex, "CantonDex.Dex.MatchedTrade:MatchedTrade"),
          contractId: tradeCid,
          choice: "MatchedTrade_Settle",
          choiceArgument: {
            // `SettlementBatchV2` (in CantonDex.Dex.MatchedTrade) is a
            // single-constructor record — not a Daml sum-type. So its
            // JSON form is the flat record, no `{tag, value}` or
            // `{TagName: {...}}` wrapper.
            batchesByAdmin: [
              [
                cfg.admin,
                {
                  allocationCids: [aliceAllocCid, bobAllocCid],
                  factoryCid: settleFactoryCid,
                  extraArgs: EMPTY_EXTRA,
                },
              ],
            ],
            // Trader Accepts already archived the requests; pass [] to
            // avoid double-archive (same posture as the in-script test).
            allocationRequests: [],
          },
        },
      },
    ]);
    // ACS_DELTA shape returns only Created + Archived events; the
    // ExercisedEvent on a choice that returns a record isn't surfaced
    // here. The participant accepted the submit (HTTP 200), so the
    // settle ran. Verify by post-state in step 7.
    console.log(`  → settle tx offset ${tx.transaction.offset}`);
    return tx;
  });

  // Step 7: verify post-state. MatchedTrade should be archived; the
  // two MockAllocation contracts should have been archived (settled);
  // a new MockAllocation may be present per allocation for the
  // next-iteration carry-forward (mock semantics).
  await step("verify MatchedTrade is archived", async () => {
    const tx = await fetch(
      `${cfg.baseUrl}/v2/state/active-contracts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          verbose: false,
          activeAtOffset: await (async () => {
            const r = await fetch(`${cfg.baseUrl}/v2/state/ledger-end`, {
              headers: { Authorization: `Bearer ${cfg.token}` },
            });
            return ((await r.json()) as { offset: number }).offset;
          })(),
          filter: {
            filtersByParty: {
              [cfg.venue]: {
                cumulative: [
                  {
                    identifierFilter: {
                      TemplateFilter: {
                        value: {
                          templateId: tid(
                            cfg.pkgDex,
                            "CantonDex.Dex.MatchedTrade:MatchedTrade",
                          ),
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
      },
    );
    const acs = (await tx.json()) as { contractEntry?: unknown }[];
    const stillActive = acs
      .map((e) => (e as { contractEntry?: { JsActiveContract?: { createdEvent?: { contractId: string } } } }).contractEntry?.JsActiveContract?.createdEvent?.contractId)
      .filter((c): c is string => c === tradeCid);
    if (stillActive.length > 0) {
      throw new Error(`MatchedTrade ${tradeCid} is still active after settle`);
    }
    console.log(`  → MatchedTrade ${tradeCid.slice(0, 16)}… archived ✓`);
  });

  console.log("\n✅ all steps passed — testnet matched-trade harness OK");
  console.log("artifacts on testnet (run-id =", RUN_ID, "):");
  console.log("  allocFactoryCid: ", allocFactoryCid);
  console.log("  settleFactoryCid:", settleFactoryCid);
  console.log("  tradeCid:        ", tradeCid, "(archived)");
}

main().catch((e) => {
  console.error("\n❌ testnet harness FAILED:", e);
  process.exit(1);
});
