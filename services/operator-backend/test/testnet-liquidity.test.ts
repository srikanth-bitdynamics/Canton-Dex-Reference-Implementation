// POST /v1/testnet/liquidity: the public, unauthenticated endpoint that drives
// a whole add or remove -- both operator steps and the LP step between them --
// for a party this deployment's faucet minted.
//
// Written against both wires, like testnet-swap.test.ts: the request is what a
// browser (or a hostile one) would actually send, and the assertions are made
// on what the OPERATOR submitted and what the PARTICIPANT received. The pool,
// the amounts, the funding holdings and the three settled allocations are all
// decided server-side, and the point of the endpoint is that none of them are
// the caller's to choose.
//
// Deliberately not exhaustive: the shared eligibility, quota and relay
// machinery is already pinned by testnet-swap.test.ts and testnet-submit.test.ts.
// What is pinned here is what is new -- the three-command allocation, the two
// funding sides of an add, the LP-position check on a remove, and the settle
// binding to the live request.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { testnetOnboardingFromEnv } from "../src/testnet-onboarding/index.js";
import { REGISTRY_HOLDING_TEMPLATE_ID } from "../src/testnet-onboarding/registry-mint.js";
import type {
  CreatedEventRef,
  LedgerEvent,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
} from "../src/ledger/index.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type {
  ChoiceContextRef,
  ContractId,
  DisclosedContract,
  FactoryRefs,
  Party,
} from "@canton-dex/registry-client";

const OPERATOR = "dex-operator::1220aa01";
const ADMIN = "dex-admin::1220aa02";
const LP_REGISTRAR = "dex-lp::1220aa03";
/** A party this deployment's faucet minted and this participant hosts. */
const HOSTED = "dex-tester-9f1c4d::1220bb01";
/** Another tester, whose holdings must never fund the first one's liquidity. */
const OTHER_TESTER = "dex-tester-5b2e77::1220bb02";

const LEDGER_URL = "http://participant:7575";
const UPDATE_ID = "1220update0001";
const POOL_CID = "00pool:0";
const REQUEST_CID = "00lp-request:0";
/** The pool admin's allocation factory: the base/quote legs are authored here. */
const DEPOSIT_FACTORY_CID = "00factory-admin:0";
/** The lpRegistrar's: the LP mint receipt and the LP burn are authored here. */
const LP_FACTORY_CID = "00factory-lp:0";
/** The three allocations the relayed transaction actually created, in order. */
const ALLOCATION_CIDS = ["00alloc-a:0", "00alloc-b:0", "00alloc-c:0"];

const BASE = "BTC";
const QUOTE = "dUSD";
const LP_INSTRUMENT = `${BASE}-${QUOTE}-LP`;

const ALLOCATION_FACTORY_IID =
  "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory";

/** What the operator's registry client discloses; the only blob allowed out. */
const ADMIN_DISCLOSURE: DisclosedContract[] = [
  {
    templateId: "cafe:CantonDex.Registry.V2:Registry",
    contractId: "00registry-admin:0",
    createdEventBlob: "admin-blob",
  },
];
const LP_DISCLOSURE: DisclosedContract[] = [
  {
    templateId: "cafe:CantonDex.Registry.V2:Registry",
    contractId: "00registry-lp:0",
    createdEventBlob: "lp-blob",
  },
];

/** The three specs the request choice builds in Daml for the LP to author. */
const ALLOCATION_SPECS = [
  { admin: ADMIN, leg: "base" },
  { admin: ADMIN, leg: "quote" },
  { admin: LP_REGISTRAR, leg: "lp" },
];
const SETTLEMENT = {
  executors: [OPERATOR],
  id: `pool-${POOL_CID}`,
  cid: null,
  meta: {},
};

/**
 * Two registries, one per admin: the deposit legs settle under the pool admin
 * and the LP leg under the lpRegistrar, so each carries its own factory and
 * disclosure and the endpoint has to route each spec to the right one.
 */
class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
  override async getFactories(admin: Party): Promise<FactoryRefs> {
    const isLp = admin === LP_REGISTRAR;
    return {
      allocationFactoryCid: (isLp
        ? LP_FACTORY_CID
        : DEPOSIT_FACTORY_CID) as ContractId<"AllocationFactory">,
      settlementFactoryCid: (isLp
        ? "00settle-lp:0"
        : "00settle-admin:0") as ContractId<"SettlementFactory">,
      // Deliberately the same contract the choice context returns: the relayed
      // submission must dedupe, or the participant rejects it.
      disclosure: isLp ? LP_DISCLOSURE : ADMIN_DISCLOSURE,
    } as FactoryRefs;
  }
  override async getChoiceContext(admin: Party): Promise<ChoiceContextRef> {
    return {
      context: { values: {} },
      disclosure: admin === LP_REGISTRAR ? LP_DISCLOSURE : ADMIN_DISCLOSURE,
    };
  }
}

interface StubHolding {
  contractId: string;
  admin: string;
  owner: string;
  instrumentId: string;
  amount: string;
  locked?: boolean;
}

/**
 * The tester's own funds: enough BTC and dUSD to add, and an LP position to
 * redeem. The rest is never selectable -- locked, another registry's, or
 * someone else's.
 */
const DEFAULT_HOLDINGS: StubHolding[] = [
  { contractId: "00btc-a:0", admin: ADMIN, owner: HOSTED, instrumentId: BASE, amount: "6.0000000000" },
  { contractId: "00btc-b:0", admin: ADMIN, owner: HOSTED, instrumentId: BASE, amount: "5.0000000000" },
  { contractId: "00usd-a:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "2000.0000000000" },
  { contractId: "00lp-own:0", admin: LP_REGISTRAR, owner: HOSTED, instrumentId: LP_INSTRUMENT, amount: "20.0000000000" },
  { contractId: "00btc-locked:0", admin: ADMIN, owner: HOSTED, instrumentId: BASE, amount: "500.0000000000", locked: true },
  { contractId: "00lp-locked:0", admin: LP_REGISTRAR, owner: HOSTED, instrumentId: LP_INSTRUMENT, amount: "900.0000000000", locked: true },
  { contractId: "00lp-foreign:0", admin: LP_REGISTRAR, owner: OTHER_TESTER, instrumentId: LP_INSTRUMENT, amount: "900.0000000000" },
];

/**
 * Serves the pool + liquidity read models and records every operator
 * submission, so a test can pin exactly what the request and settle choices
 * were called with.
 */
class PoolLedger implements LedgerSubmitter {
  readonly submits: SubmitRequest[] = [];

  constructor(readonly holdings: StubHolding[] = DEFAULT_HOLDINGS) {}

  async submit<R>(req: SubmitRequest): Promise<R> {
    this.submits.push(req);
    if (
      req.command.kind === "exercise" &&
      (req.command.choice === "PoolLiquidityRules_RequestAddLiquidity" ||
        req.command.choice === "PoolLiquidityRules_RequestRemoveLiquidity")
    ) {
      // What the Daml choice returns: the request the LP authors against.
      return REQUEST_CID as R;
    }
    return "#result:0" as R;
  }

  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {
    // no streaming in this stub
  }

  /** Operator-discovery: what the committed allocation transaction created. */
  async treeCreatedEvents(): Promise<CreatedEventRef[]> {
    return ALLOCATION_CIDS.map((contractId) => ({
      contractId,
      templateId: "cafe:CantonDex.Registry.V2:Allocation",
    }));
  }

  async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    switch (filter.templateId) {
      case "CantonDex.Dex.Pool:Pool":
        return [{
          contractId: POOL_CID, poolId: `${BASE}/${QUOTE}`, operator: OPERATOR,
          lpRegistrar: LP_REGISTRAR, admin: ADMIN,
          baseInstrumentId: BASE, quoteInstrumentId: QUOTE,
          lpInstrumentId: { admin: LP_REGISTRAR, id: LP_INSTRUMENT },
          feeBps: 30,
        } as unknown as T];
      case "CantonDex.Dex.PoolState:PoolState":
        return [{
          contractId: "00state:0", poolId: `${BASE}/${QUOTE}`, operator: OPERATOR,
          lpRegistrar: LP_REGISTRAR, status: "PS_Active",
          reserves: {
            baseAmount: "1000.0000000000",
            quoteAmount: "100000.0000000000",
          },
          totalLpSupply: "10000.0000000000", publicReaders: [],
        } as unknown as T];
      case "CantonDex.Dex.PoolSlice:PoolSlice":
        return [
          {
            contractId: "00slice-base:0", poolId: `${BASE}/${QUOTE}`,
            operator: OPERATOR, side: "BaseSide",
            allocationCid: "00pool-alloc-base:0", amount: "1000.0000000000",
          },
          {
            contractId: "00slice-quote:0", poolId: `${BASE}/${QUOTE}`,
            operator: OPERATOR, side: "QuoteSide",
            allocationCid: "00pool-alloc-quote:0", amount: "100000.0000000000",
          },
        ] as unknown as T[];
      case "CantonDex.Dex.PoolRules:PoolRules":
        return [{ contractId: "00rules:0", operator: OPERATOR } as unknown as T];
      case "CantonDex.Dex.PoolLiquidityRules:PoolLiquidityRules":
        return [{
          contractId: "00lp-rules:0", operator: OPERATOR,
          lpRegistrar: LP_REGISTRAR,
        } as unknown as T];
      case "CantonDex.Dex.LiquidityAllocationRequest:LiquidityAllocationRequest":
        return [{
          contractId: REQUEST_CID, operator: OPERATOR, lp: HOSTED,
          settlement: SETTLEMENT, allocations: ALLOCATION_SPECS,
        } as unknown as T[][number]] as T[];
      case "CantonDex.Lp.Policy:LPTokenPolicy":
        return [{
          contractId: "00lp-policy:0", lpRegistrar: LP_REGISTRAR,
          operator: OPERATOR,
          lpInstrumentId: { admin: LP_REGISTRAR, id: LP_INSTRUMENT },
          totalSupply: "10000.0000000000", active: true,
        } as unknown as T];
      case REGISTRY_HOLDING_TEMPLATE_ID:
        return this.holdings as unknown as T[];
      default:
        return [];
    }
  }

  /** Operator submissions of one choice, in order. */
  choice(name: string): SubmitRequest[] {
    return this.submits.filter(
      (s) => s.command.kind === "exercise" && s.command.choice === name,
    );
  }

  /** The choice argument of the single submission of `name`. */
  argument(name: string): Record<string, unknown> {
    const [found, ...rest] = this.choice(name);
    assert.ok(found, `expected one ${name} submission`);
    assert.equal(rest.length, 0, `expected exactly one ${name} submission`);
    return (found.command as { argument: Record<string, unknown> }).argument;
  }
}

interface ParticipantCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

interface ParticipantStubOptions {
  /** Parties the participant reports as local. */
  hosted?: string[];
}

/** Stand-in participant: party lookup, submit-and-wait, transaction tree. */
function participantStub(opts: ParticipantStubOptions = {}): {
  fetchImpl: typeof fetch;
  submissions: () => Record<string, unknown>[];
} {
  const hosted = opts.hosted ?? [HOSTED];
  const calls: ParticipantCall[] = [];
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    });
    if (url.includes("/v2/parties/")) {
      const party = decodeURIComponent(url.split("/v2/parties/")[1] ?? "");
      return json({ partyDetails: [{ party, isLocal: hosted.includes(party) }] });
    }
    if (url.includes("/v2/commands/submit-and-wait")) {
      return json({ updateId: UPDATE_ID, completionOffset: 42 });
    }
    if (url.includes("/v2/updates/transaction-tree-by-id/")) {
      return json({
        transaction: {
          eventsById: Object.fromEntries(
            ALLOCATION_CIDS.map((contractId, nodeId) => [
              String(nodeId),
              {
                CreatedTreeEvent: {
                  value: {
                    nodeId,
                    contractId,
                    templateId: "cafe:CantonDex.Registry.V2:Allocation",
                  },
                },
              },
            ]),
          ),
        },
      });
    }
    return json({});
  }) as typeof fetch;

  return {
    fetchImpl,
    submissions: () =>
      calls
        .filter((c) => c.url.includes("/v2/commands/submit-and-wait"))
        .map((c) => c.body ?? {}),
  };
}

interface StartedServer {
  url: string;
  close: () => Promise<void>;
  ledger: PoolLedger;
  submissions: () => Record<string, unknown>[];
}

/**
 * Start the HTTP shim with the given faucet env applied, then restore the
 * environment (the service reads env once, at construction).
 */
async function startServer(
  env: Record<string, string | undefined>,
  opts: ParticipantStubOptions & { holdings?: StubHolding[] } = {},
): Promise<StartedServer> {
  const ledger = new PoolLedger(opts.holdings ?? DEFAULT_HOLDINGS);
  const { fetchImpl, submissions } = participantStub(opts);

  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Declared out here so the env restore below stays synchronous with the
  // call that read it; the listen is awaited after the swap is undone.
  let starting: ReturnType<typeof startHttpServer>;
  try {
    const backend = new OperatorBackend({
      ledger,
      registry: new StubRegistry(),
      operatorParty: OPERATOR as never,
    });
    // Port 0: the OS picks a free one and startHttpServer reports it back on
    // the handle, so parallel test files cannot land on the same port.
    starting = startHttpServer({
      backend,
      port: 0,
      host: "127.0.0.1",
      context: {
        operator: OPERATOR as never,
        lpRegistrar: LP_REGISTRAR as never,
        admin: ADMIN as never,
        allocationFactoryCid: DEPOSIT_FACTORY_CID,
        settlementFactoryCid: "00settle-admin:0",
        allocationFactoryExtraArgs: {
          context: { values: {} },
          meta: { values: {} },
        },
        allocationFactoryDisclosure: [],
        network: "canton:test",
      },
      testnetOnboarding: testnetOnboardingFromEnv({
        ledger,
        admin: ADMIN as never,
        pool: backend.pool,
        ledgerUrl: LEDGER_URL,
        ledgerToken: "ledger-token",
        userId: "ledger-api-user",
        synchronizerId: "global-domain::1220dd",
        fetchImpl,
      }),
    });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const server = await starting;
  return { url: server.url, close: server.close, ledger, submissions };
}

const ON = {
  DEX_TESTNET_ONBOARDING: "1",
  DEX_TESTNET_SUBMIT_DAILY_CAP: "50",
  DEX_TESTNET_SUBMIT_IP_DAILY_CAP: "50",
};

async function postJson(
  url: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

/** A well-formed add of 10 BTC + 1000 dUSD by the hosted tester. */
function addBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    party: HOSTED,
    poolCid: POOL_CID,
    action: "add",
    baseAmount: "10.0000000000",
    quoteAmount: "1000.0000000000",
    ...extra,
  };
}

/** A well-formed redemption of 5 LP tokens by the hosted tester. */
function removeBody(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    party: HOSTED,
    poolCid: POOL_CID,
    action: "remove",
    lpAmount: "5.0000000000",
    ...extra,
  };
}

async function withServer(
  env: Record<string, string | undefined>,
  opts: ParticipantStubOptions & { holdings?: StubHolding[] },
  run: (s: StartedServer) => Promise<void>,
): Promise<void> {
  const server = await startServer(env, opts);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

/** The relayed commands, as the participant received them. */
function relayedAllocations(
  s: StartedServer,
): Array<Record<string, unknown>> {
  const submitted = s.submissions()[0];
  assert.ok(submitted, "expected one relayed submission");
  const commands = submitted.commands as Array<{
    ExerciseCommand: Record<string, unknown>;
  }>;
  assert.equal(commands.length, 3);
  return commands.map((c) => c.ExerciseCommand);
}

describe("testnet liquidity: env gate", () => {
  it("does not register the route when the flag is off", async () => {
    await withServer({ DEX_TESTNET_ONBOARDING: undefined }, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/liquidity", addBody());
      assert.equal(r.status, 404);
      assert.equal(r.body.code, "not_found");
      assert.deepEqual(
        s.ledger.choice("PoolLiquidityRules_RequestAddLiquidity"),
        [],
      );
    });
  });
});

describe("testnet liquidity: party eligibility", () => {
  it("rejects the operator's own party before submitting anything", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/liquidity",
        addBody({ party: OPERATOR }),
      );
      assert.equal(r.status, 403);
      assert.equal(r.body.code, "forbidden");
      // The refusal lands before the operator writes anything for it.
      assert.deepEqual(
        s.ledger.choice("PoolLiquidityRules_RequestAddLiquidity"),
        [],
      );
      assert.deepEqual(s.submissions(), []);
    });
  });
});

describe("testnet liquidity: the funding is the server's", () => {
  it("reports a shortfall on the deposit side and submits nothing", async () => {
    // 6 + 5 unlocked BTC; the locked 500 is not this party's to spend.
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/liquidity",
        addBody({ baseAmount: "50.0000000000" }),
      );
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "bad_request");
      assert.match(
        String(r.body.error),
        /insufficient unlocked BTC balance: have 11\.0000000000, need 50\.0000000000/,
      );
      assert.deepEqual(
        s.ledger.choice("PoolLiquidityRules_RequestAddLiquidity"),
        [],
      );
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("refuses to redeem more LP than the party holds", async () => {
    // 20 unlocked LP tokens; the locked 900 and the other tester's 900 are not
    // this party's position.
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/liquidity",
        removeBody({ lpAmount: "100.0000000000" }),
      );
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "bad_request");
      assert.match(
        String(r.body.error),
        new RegExp(
          `insufficient unlocked ${LP_INSTRUMENT} balance: have 20\\.0000000000, need 100\\.0000000000`,
        ),
      );
      assert.deepEqual(
        s.ledger.choice("PoolLiquidityRules_RequestRemoveLiquidity"),
        [],
      );
      assert.deepEqual(s.submissions(), []);
    });
  });
});

describe("testnet liquidity: happy path", () => {
  it("adds: three allocations through the relay, then settles the live request", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/liquidity",
        addBody({
          // Everything a hostile caller would try to bring along.
          inputHoldingCids: ["00lp-foreign:0"],
          requestCid: "00attacker-request:0",
          lpBaseDepositCid: "00attacker-alloc:0",
          actAs: [OPERATOR, LP_REGISTRAR],
          disclosedContracts: [
            {
              templateId: "cafe:CantonDex.Registry.V2:Registry",
              contractId: "00attacker:0",
              createdEventBlob: "attacker-blob",
            },
          ],
        }),
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.updateId, UPDATE_ID);
      assert.equal(r.body.baseAmount, "10.0000000000");
      assert.equal(r.body.quoteAmount, "1000.0000000000");
      // 10 BTC / 1000 dUSD against reserves of 1000 / 100000 at a supply of
      // 10000: a pro-rata 100 LP.
      assert.equal(r.body.lpAmount, "100.0000000000");

      // The three LP-authority commands, routed to the right factory each: the
      // two deposits under the pool admin's, the LP mint under the registrar's.
      const [base, quote, mint] = relayedAllocations(s);
      for (const cmd of [base, quote, mint]) {
        assert.equal(cmd!.templateId, ALLOCATION_FACTORY_IID);
        assert.equal(cmd!.choice, "AllocationFactory_Allocate");
      }
      assert.equal(base!.contractId, DEPOSIT_FACTORY_CID);
      assert.equal(quote!.contractId, DEPOSIT_FACTORY_CID);
      assert.equal(mint!.contractId, LP_FACTORY_CID);

      const baseArg = base!.choiceArgument as Record<string, unknown>;
      const quoteArg = quote!.choiceArgument as Record<string, unknown>;
      const mintArg = mint!.choiceArgument as Record<string, unknown>;
      // Two unlocked BTC pieces, because neither covers 10 alone; one dUSD
      // piece. Never the locked ones and never the other tester's.
      assert.deepEqual(baseArg.inputHoldingCids, ["00btc-a:0", "00btc-b:0"]);
      assert.deepEqual(quoteArg.inputHoldingCids, ["00usd-a:0"]);
      // The LP mint receipt has the party as RECEIVER: nothing to lock.
      assert.deepEqual(mintArg.inputHoldingCids, []);
      assert.deepEqual(baseArg.actors, [HOSTED]);
      // The specs are the ones the request built, in the request's own order.
      assert.deepEqual(
        [baseArg.allocation, quoteArg.allocation, mintArg.allocation],
        ALLOCATION_SPECS,
      );

      // The relay fixed the authority, and disclosed the operator's own
      // contracts from both registries -- nothing of the caller's.
      const submitted = s.submissions()[0]!;
      assert.deepEqual(submitted.actAs, [HOSTED]);
      assert.deepEqual(submitted.readAs, []);
      assert.deepEqual(submitted.disclosedContracts, [
        ...ADMIN_DISCLOSURE,
        ...LP_DISCLOSURE,
      ]);

      // The operator steps run for the same party and bind to the live request
      // and the allocations the relay produced, never ones from the body.
      const request = s.ledger.argument(
        "PoolLiquidityRules_RequestAddLiquidity",
      );
      assert.equal(request.recipient, HOSTED);
      const settle = s.ledger.argument("PoolLiquidityRules_SettleAddLiquidity");
      assert.equal(settle.requestCid, REQUEST_CID);
      assert.equal(settle.recipient, HOSTED);
      assert.equal(settle.lpBaseDepositCid, ALLOCATION_CIDS[0]);
      assert.equal(settle.lpQuoteDepositCid, ALLOCATION_CIDS[1]);
      assert.equal(settle.lpReceiptCid, ALLOCATION_CIDS[2]);
      // Absent any caller slippage input, the floor is the operator's own quote.
      assert.equal(settle.minLpTokens, "100.0000000000");
      assert.equal(settle.knownTotalLpSupply, "10000.0000000000");
      assert.ok(!JSON.stringify(settle).includes("00attacker"));
    });
  });

  it("removes: burns the party's own LP and settles at the quoted payout", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/liquidity", removeBody());
      assert.equal(r.status, 200);
      assert.equal(r.body.updateId, UPDATE_ID);
      assert.equal(r.body.lpAmount, "5.0000000000");
      // 5 of 10000 LP against reserves of 1000 / 100000.
      assert.equal(r.body.baseAmount, "0.5000000000");
      assert.equal(r.body.quoteAmount, "50.0000000000");

      // Mirror image of the add: the two payout receipts lock nothing, the burn
      // is funded from the party's own LP holding under the registrar.
      const [baseOut, quoteOut, burn] = relayedAllocations(s);
      assert.equal(baseOut!.contractId, DEPOSIT_FACTORY_CID);
      assert.equal(quoteOut!.contractId, DEPOSIT_FACTORY_CID);
      assert.equal(burn!.contractId, LP_FACTORY_CID);
      assert.deepEqual(
        (baseOut!.choiceArgument as Record<string, unknown>).inputHoldingCids,
        [],
      );
      assert.deepEqual(
        (quoteOut!.choiceArgument as Record<string, unknown>).inputHoldingCids,
        [],
      );
      assert.deepEqual(
        (burn!.choiceArgument as Record<string, unknown>).inputHoldingCids,
        ["00lp-own:0"],
      );

      const settle = s.ledger.argument(
        "PoolLiquidityRules_SettleRemoveLiquidity",
      );
      assert.equal(settle.requestCid, REQUEST_CID);
      assert.equal(settle.holder, HOSTED);
      assert.equal(settle.lpTokensToRedeem, "5.0000000000");
      assert.equal(settle.holderBaseReceiptCid, ALLOCATION_CIDS[0]);
      assert.equal(settle.holderQuoteReceiptCid, ALLOCATION_CIDS[1]);
      assert.equal(settle.holderBurnSenderCid, ALLOCATION_CIDS[2]);
      // The payout floors are the operator's own redemption plan.
      assert.equal(settle.minBaseOut, "0.5000000000");
      assert.equal(settle.minQuoteOut, "50.0000000000");
    });
  });
});

describe("testnet liquidity: rate limit", () => {
  it("returns 429 once the per-client daily cap is spent", async () => {
    // A liquidity change charges the submission budget twice: once for the
    // operator work and once for the relayed allocations.
    await withServer(
      {
        DEX_TESTNET_ONBOARDING: "1",
        DEX_TESTNET_SUBMIT_DAILY_CAP: "50",
        DEX_TESTNET_SUBMIT_IP_DAILY_CAP: "2",
      },
      {},
      async (s) => {
        assert.equal(
          (await postJson(s.url, "/v1/testnet/liquidity", addBody())).status,
          200,
        );
        const r = await postJson(s.url, "/v1/testnet/liquidity", addBody());
        assert.equal(r.status, 429);
        assert.equal(r.body.code, "too_many_requests");
        assert.equal(
          (r.body.details as { scope?: string } | undefined)?.scope,
          "ip",
        );
        // The throttled request never reached the ledger.
        assert.equal(
          s.ledger.choice("PoolLiquidityRules_RequestAddLiquidity").length,
          1,
        );
      },
    );
  });
});
