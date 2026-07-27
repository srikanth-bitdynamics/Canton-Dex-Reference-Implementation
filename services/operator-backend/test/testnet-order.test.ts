// POST /v1/testnet/order and POST /v1/testnet/order/cancel: the public,
// unauthenticated endpoints that place and pull a resting order for a party
// this deployment's faucet minted.
//
// Placing one is the only testnet flow whose first step is a trader-authority
// CREATE, which the submit relay refuses by design -- so the assertions are
// made on what the OPERATOR submitted and what the PARTICIPANT received across
// all four steps. The trader on the funding request, the collateral holdings
// and the cancelled order are decided server-side, and the point of these two
// routes is that none of them are the caller's to choose.
//
// The participant is stubbed the way testnet-swap.test.ts stubs it; the order
// book and the pair listing are served by a ledger stub, so the orchestration
// is pinned without a Canton in the loop.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { testnetOnboardingFromEnv } from "../src/testnet-onboarding/index.js";
import { REGISTRY_HOLDING_TEMPLATE_ID } from "../src/testnet-onboarding/registry-mint.js";
import { DEX_PAIR_TEMPLATE_ID } from "../src/testnet-onboarding/order.js";
import type {
  LedgerEvent,
  LedgerSubmitter,
  SubmitReceipt,
  SubmitRequest,
  SubscriptionFilter,
} from "../src/ledger/index.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type {
  ChoiceContextRef,
  ContractId,
  DisclosedContract,
} from "@canton-dex/registry-client";

const OPERATOR = "dex-operator::1220aa01";
const ADMIN = "dex-admin::1220aa02";
const LP_REGISTRAR = "dex-lp::1220aa03";
/** A party this deployment's faucet minted and this participant hosts. */
const HOSTED = "dex-tester-9f1c4d::1220bb01";
/** Another tester: their holdings and their orders are not the first one's. */
const OTHER_TESTER = "dex-tester-5b2e77::1220bb02";

const LEDGER_URL = "http://participant:7575";
/** The relayed collateral transaction. */
const UPDATE_ID = "1220update0001";
const CANCEL_UPDATE_ID = "1220cancel0001";
const ALLOCATION_CID = "00alloc:0";
const FUNDING_REQUEST_CID = "00funding:0";
const ORDER_CID = "00order:0";
const ALLOCATION_REQUEST_CID = "00areq:0";
const FUNDED_ORDER_CID = "00order-funded:0";
/** The caller's own resting order, and one that is not theirs. */
const OWN_ORDER_CID = "00open-own:0";
const OTHER_ORDER_CID = "00open-other:0";

const FACTORY_CID = "00factory:0";
const BASE = "BTC";
const QUOTE = "dUSD";

const ALLOCATION_FACTORY_IID =
  "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory";

/** What the operator's registry client discloses; the only blob allowed out. */
const REGISTRY_DISCLOSURE: DisclosedContract[] = [
  {
    templateId: "cafe:CantonDex.Registry.V2:Registry",
    contractId: "00registry:0",
    createdEventBlob: "operator-blob",
  },
];

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
  override async getFactories() {
    return {
      allocationFactoryCid: FACTORY_CID as ContractId<"AllocationFactory">,
      settlementFactoryCid: "00settle:0" as ContractId<"SettlementFactory">,
      // Deliberately the same contract the choice context returns: the order
      // must dedupe, or the participant rejects the relayed submission.
      disclosure: REGISTRY_DISCLOSURE,
    };
  }
  override async getChoiceContext(): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: REGISTRY_DISCLOSURE };
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

/** The tester's own funds: two dUSD pieces, neither covering 6.0 alone. */
const DEFAULT_HOLDINGS: StubHolding[] = [
  { contractId: "00own-a:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "4.0000000000" },
  { contractId: "00own-b:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "3.0000000000" },
  // Never selectable: locked, wrong instrument, or someone else's.
  { contractId: "00own-locked:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "500.0000000000", locked: true },
  { contractId: "00own-btc:0", admin: ADMIN, owner: HOSTED, instrumentId: BASE, amount: "500.0000000000" },
  { contractId: "00foreign:0", admin: ADMIN, owner: OTHER_TESTER, instrumentId: QUOTE, amount: "500.0000000000" },
];

interface StubOrder {
  contractId: string;
  trader: string;
}

/** The resting book: one order of the caller's, one of somebody else's. */
const DEFAULT_ORDERS: StubOrder[] = [
  { contractId: OWN_ORDER_CID, trader: HOSTED },
  { contractId: OTHER_ORDER_CID, trader: OTHER_TESTER },
];

/**
 * Serves the pair listing, the holdings and the book the order flow reads, and
 * records every operator submission so a test can pin exactly what each of the
 * four steps was called with.
 */
class OrderLedger implements LedgerSubmitter {
  readonly submits: SubmitRequest[] = [];

  constructor(
    readonly holdings: StubHolding[] = DEFAULT_HOLDINGS,
    readonly orders: StubOrder[] = DEFAULT_ORDERS,
  ) {}

  async submit<R>(req: SubmitRequest): Promise<R> {
    return (await this.submitWithUpdateId<R>(req)).result;
  }

  async submitWithUpdateId<R>(req: SubmitRequest): Promise<SubmitReceipt<R>> {
    this.submits.push(req);
    const cmd = req.command;
    if (cmd.kind === "create") {
      return { result: FUNDING_REQUEST_CID as R, updateId: "1220create0001" };
    }
    if (cmd.kind === "exercise") {
      switch (cmd.choice) {
        case "OrderFundingRequest_Bind":
          return {
            result: {
              orderCid: ORDER_CID,
              allocationRequestCid: ALLOCATION_REQUEST_CID,
            } as R,
            updateId: "1220bind0001",
          };
        case "Order_Fund":
          return {
            result: { orderCid: FUNDED_ORDER_CID } as R,
            updateId: "1220fund0001",
          };
        case "Order_Cancel":
          return { result: {} as R, updateId: CANCEL_UPDATE_ID };
      }
    }
    return { result: "#result:0" as R, updateId: null };
  }

  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {
    // no streaming in this stub
  }

  async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    switch (filter.templateId) {
      case DEX_PAIR_TEMPLATE_ID:
        return [{
          contractId: "00pair:0", operator: OPERATOR, admin: ADMIN,
          baseInstrumentId: BASE, quoteInstrumentId: QUOTE,
          tradingMode: "TM_Both", active: true,
        } as unknown as T];
      case "CantonDex.Dex.Order:Order":
        return this.orders.map((o) => ({
          ...o, operator: OPERATOR, admin: ADMIN,
          baseInstrumentId: BASE, quoteInstrumentId: QUOTE,
          side: "Bid", limitPrice: "2.0000000000",
          remainingQty: "3.0000000000", expiry: null, status: "OS_Funded",
          allocationCid: ALLOCATION_CID,
          settlementRef: { id: "DexOrder-testnet", cid: null },
        })) as unknown as T[];
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

  /** Create submissions, in order. */
  creates(): SubmitRequest[] {
    return this.submits.filter((s) => s.command.kind === "create");
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
          eventsById: {
            "0": {
              CreatedTreeEvent: {
                value: {
                  nodeId: 0,
                  contractId: ALLOCATION_CID,
                  templateId: "cafe:CantonDex.Registry.V2:Allocation",
                },
              },
            },
          },
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
  ledger: OrderLedger;
  submissions: () => Record<string, unknown>[];
}

/**
 * Start the HTTP shim with the given faucet env applied, then restore the
 * environment (the service reads env once, at construction).
 *
 * `participant: false` builds the service with no ledger URL/token at all,
 * which is the in-memory dev server: the faucet works, ordering does not.
 */
async function startServer(
  env: Record<string, string | undefined>,
  opts: ParticipantStubOptions & {
    participant?: boolean;
    holdings?: StubHolding[];
    orders?: StubOrder[];
  } = {},
): Promise<StartedServer> {
  const ledger = new OrderLedger(
    opts.holdings ?? DEFAULT_HOLDINGS,
    opts.orders ?? DEFAULT_ORDERS,
  );
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
    const registry = new StubRegistry();
    const backend = new OperatorBackend({
      ledger,
      registry,
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
        allocationFactoryCid: FACTORY_CID,
        settlementFactoryCid: "00settle:0",
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
        order: {
          service: backend.order,
          registry,
          operator: OPERATOR as never,
        },
        ...(opts.participant === false
          ? {}
          : {
              ledgerUrl: LEDGER_URL,
              ledgerToken: "ledger-token",
              userId: "ledger-api-user",
              synchronizerId: "global-domain::1220dd",
            }),
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

/** A well-formed bid for 3 BTC at 2 dUSD by the hosted tester: 6 dUSD locked. */
function orderBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    party: HOSTED,
    baseInstrumentId: BASE,
    quoteInstrumentId: QUOTE,
    side: "Bid",
    limitPrice: "2.0000000000",
    quantity: "3.0000000000",
    ...extra,
  };
}

async function withServer(
  env: Record<string, string | undefined>,
  opts: ParticipantStubOptions & {
    participant?: boolean;
    holdings?: StubHolding[];
    orders?: StubOrder[];
  },
  run: (s: StartedServer) => Promise<void>,
): Promise<void> {
  const server = await startServer(env, opts);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

/** The single relayed command, as the participant received it. */
function relayedAllocate(s: StartedServer): Record<string, unknown> {
  const submitted = s.submissions()[0];
  assert.ok(submitted, "expected one relayed submission");
  const commands = submitted.commands as Array<{
    ExerciseCommand: Record<string, unknown>;
  }>;
  assert.equal(commands.length, 1);
  return commands[0]!.ExerciseCommand;
}

describe("testnet order: env gate", () => {
  it("does not register either route when the flag is off", async () => {
    await withServer({ DEX_TESTNET_ONBOARDING: undefined }, {}, async (s) => {
      const placed = await postJson(s.url, "/v1/testnet/order", orderBody());
      assert.equal(placed.status, 404);
      assert.equal(placed.body.code, "not_found");

      const cancelled = await postJson(s.url, "/v1/testnet/order/cancel", {
        party: HOSTED,
        orderCid: OWN_ORDER_CID,
      });
      assert.equal(cancelled.status, 404);
      assert.deepEqual(s.ledger.submits, []);
    });
  });

  it("answers 501 when the deployment has no participant to order on", async () => {
    await withServer(ON, { participant: false }, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/order", orderBody());
      assert.equal(r.status, 501);
      assert.equal(r.body.code, "not_implemented");
      assert.deepEqual(s.ledger.submits, []);
    });
  });
});

describe("testnet order: party eligibility", () => {
  it("rejects the operator, admin and lpRegistrar parties before submitting", async () => {
    await withServer(ON, {}, async (s) => {
      for (const party of [OPERATOR, ADMIN, LP_REGISTRAR]) {
        const r = await postJson(s.url, "/v1/testnet/order", orderBody({ party }));
        assert.equal(r.status, 403, `expected 403 for ${party}`);
        assert.equal(r.body.code, "forbidden");
      }
      // The refusal lands before the operator writes anything for them.
      assert.deepEqual(s.ledger.submits, []);
      assert.deepEqual(s.submissions(), []);
    });
  });
});

describe("testnet order: request validation", () => {
  it("rejects a pair this deployment does not list", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/order",
        orderBody({ baseInstrumentId: "ETH" }),
      );
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), /does not list an active pair/);
      assert.deepEqual(s.ledger.creates(), []);
    });
  });

  it("reports a shortfall against the party's unlocked balance", async () => {
    // 4 + 3 unlocked dUSD; the locked 500 and the other tester's 500 are not
    // this party's to lock behind an order.
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/order",
        orderBody({ quantity: "50.0000000000" }),
      );
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "bad_request");
      assert.match(
        String(r.body.error),
        /insufficient unlocked dUSD balance: have 7\.0000000000, need 100\.0000000000/,
      );
      // Nothing was submitted for an order that could never have funded.
      assert.deepEqual(s.ledger.submits, []);
      assert.deepEqual(s.submissions(), []);
    });
  });
});

describe("testnet order: happy path", () => {
  it("runs all four steps and returns the funded order", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/order",
        orderBody({
          // Everything a hostile caller would try to bring along.
          trader: OPERATOR,
          operator: OTHER_TESTER,
          admin: OTHER_TESTER,
          inputHoldingCids: ["00foreign:0"],
          settlementRef: "attacker-ref",
          actAs: [OPERATOR, ADMIN],
        }),
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.updateId, UPDATE_ID);
      assert.equal(r.body.orderCid, FUNDED_ORDER_CID);
      assert.equal(r.body.status, "Funded");

      // 1. The trader's intent, submitted as the one eligible party and built
      // from the server's own operator/admin, not the body's.
      const [create, ...moreCreates] = s.ledger.creates();
      assert.ok(create, "expected one OrderFundingRequest create");
      assert.equal(moreCreates.length, 0);
      assert.deepEqual(create.actAs, [HOSTED]);
      const args = (create.command as { argument: Record<string, unknown> })
        .argument;
      assert.equal(args.trader, HOSTED);
      assert.equal(args.operator, OPERATOR);
      assert.equal(args.admin, ADMIN);
      assert.equal(args.side, "Bid");
      assert.equal(args.limitPrice, "2.0000000000");
      assert.equal(args.quantity, "3.0000000000");
      assert.equal(args.expiry, null);

      // 2. The operator binds the request the create returned, under a
      // settlement reference the caller did not choose.
      const bind = s.ledger.choice("OrderFundingRequest_Bind")[0]!;
      assert.equal(
        (bind.command as { contractId: string }).contractId,
        FUNDING_REQUEST_CID,
      );
      const settlementRef = s.ledger.argument("OrderFundingRequest_Bind")
        .settlementRef as string;
      assert.match(settlementRef, /^testnet-/);
      assert.deepEqual(bind.actAs, [OPERATOR]);

      // 3. The trader locks collateral through the relay: two unlocked pieces
      // of their own dUSD, because neither covers 6.0 alone. Never the other
      // tester's, the locked one, or the BTC one.
      const allocate = relayedAllocate(s);
      assert.equal(allocate.templateId, ALLOCATION_FACTORY_IID);
      assert.equal(allocate.contractId, FACTORY_CID);
      assert.equal(allocate.choice, "AllocationFactory_Allocate");
      const arg = allocate.choiceArgument as Record<string, unknown>;
      assert.deepEqual(arg.inputHoldingCids, ["00own-a:0", "00own-b:0"]);
      assert.deepEqual(arg.actors, [HOSTED]);
      assert.deepEqual(arg.settlement, {
        executors: [OPERATOR],
        id: `DexOrder-${settlementRef}`,
        cid: null,
        meta: { values: {} },
      });
      assert.deepEqual(arg.allocation, {
        admin: ADMIN,
        authorizer: { owner: HOSTED, provider: null, id: "" },
        transferLegSides: [],
        settlementDeadline: null,
        // 3 BTC at 2 dUSD: the collateral the bind will ask for.
        nextIterationFunding: { [QUOTE]: "6.0000000000" },
        committed: true,
        meta: { values: {} },
      });
      // ... and the relay still fixed the authority and the disclosure.
      assert.deepEqual(s.submissions()[0]!.actAs, [HOSTED]);
      assert.deepEqual(s.submissions()[0]!.readAs, []);
      assert.deepEqual(
        s.submissions()[0]!.disclosedContracts,
        REGISTRY_DISCLOSURE,
      );

      // 4. The fund binds the allocation the relay created, plus the bind's
      // own request cid so it cannot linger.
      const fund = s.ledger.argument("Order_Fund");
      assert.equal(fund.allocationCid, ALLOCATION_CID);
      assert.equal(fund.allocationRequestCid, ALLOCATION_REQUEST_CID);
      assert.equal(
        (s.ledger.choice("Order_Fund")[0]!.command as { contractId: string })
          .contractId,
        ORDER_CID,
      );
    });
  });
});

describe("testnet order: cancel", () => {
  it("refuses to cancel an order placed by another party", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/order/cancel", {
        party: HOSTED,
        orderCid: OTHER_ORDER_CID,
      });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, "forbidden");
      assert.match(String(r.body.error), /placed by another party/);
      // The order was resolved server-side, and nothing was cancelled.
      assert.deepEqual(s.ledger.choice("Order_Cancel"), []);
    });
  });

  it("refuses an order this deployment does not have open", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/order/cancel", {
        party: HOSTED,
        orderCid: "00nosuchorder:0",
      });
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), /unknown or inactive order/);
      assert.deepEqual(s.ledger.choice("Order_Cancel"), []);
    });
  });

  it("cancels the caller's own order and returns the updateId", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/order/cancel", {
        party: HOSTED,
        orderCid: OWN_ORDER_CID,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.updateId, CANCEL_UPDATE_ID);

      const cancel = s.ledger.choice("Order_Cancel")[0]!;
      assert.equal(
        (cancel.command as { contractId: string }).contractId,
        OWN_ORDER_CID,
      );
      // Order_Cancel is the operator's choice; the tester never acts here.
      assert.deepEqual(cancel.actAs, [OPERATOR]);
    });
  });
});

describe("testnet order: rate limit", () => {
  it("returns 429 once the per-client daily cap is spent", async () => {
    // Placing an order charges the submission budget twice: once for the
    // operator work and once for the relayed collateral allocation.
    await withServer(
      {
        DEX_TESTNET_ONBOARDING: "1",
        DEX_TESTNET_SUBMIT_DAILY_CAP: "50",
        DEX_TESTNET_SUBMIT_IP_DAILY_CAP: "2",
      },
      {},
      async (s) => {
        assert.equal(
          (await postJson(s.url, "/v1/testnet/order", orderBody())).status,
          200,
        );
        const r = await postJson(s.url, "/v1/testnet/order", orderBody());
        assert.equal(r.status, 429);
        assert.equal(r.body.code, "too_many_requests");
        assert.equal(
          (r.body.details as { scope?: string } | undefined)?.scope,
          "ip",
        );
        // The throttled request never reached the ledger.
        assert.equal(s.ledger.creates().length, 1);
      },
    );
  });
});
