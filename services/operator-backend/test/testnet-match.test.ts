// POST /v1/testnet/match: the public, unauthenticated trigger for the
// operator's atomic order matcher. It settles every crossing pair on the book
// under the operator's own authority, so the assertions are made on what the
// OPERATOR submitted -- the caller supplies only the listed pair and gets no say
// in the party, the order cids, or the clearing price/quantity.
//
// The order book and the pair listing are served by a ledger stub and the
// OrderMatchExecution_Execute choice is modelled inline, so the whole run is
// pinned without a Canton in the loop.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { testnetOnboardingFromEnv } from "../src/testnet-onboarding/index.js";
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
const BUYER = "dex-tester-9f1c4d::1220bb01";
const SELLER = "dex-tester-5b2e77::1220bb02";

const LEDGER_URL = "http://participant:7575";
const BASE = "BTC";
const QUOTE = "dUSD";
const FACTORY_CID = "00factory:0";

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
      disclosure: REGISTRY_DISCLOSURE,
    };
  }
  override async getChoiceContext(): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: REGISTRY_DISCLOSURE };
  }
}

interface StubOrder {
  contractId: string;
  trader: string;
  side: "Bid" | "Ask";
  limitPrice: string;
  remainingQty: string;
  allocationCid: string | null;
}

/** A book that crosses: a bid and an ask at the same price and quantity. */
const CROSSING_BOOK: StubOrder[] = [
  {
    contractId: "00bid:0",
    trader: BUYER,
    side: "Bid",
    limitPrice: "2.0000000000",
    remainingQty: "3.0000000000",
    allocationCid: "00bid-alloc:0",
  },
  {
    contractId: "00ask:0",
    trader: SELLER,
    side: "Ask",
    limitPrice: "2.0000000000",
    remainingQty: "3.0000000000",
    allocationCid: "00ask-alloc:0",
  },
];

/**
 * Serves the pair listing and the order book, and settles a match by modelling
 * OrderMatchExecution_Execute as a full fill (both sides close out, nothing
 * rolls forward). Records every submission so a test can pin what the operator
 * was called with.
 */
class MatchLedger implements LedgerSubmitter {
  readonly submits: SubmitRequest[] = [];

  constructor(readonly orders: StubOrder[] = CROSSING_BOOK) {}

  async submit<R>(req: SubmitRequest): Promise<R> {
    return (await this.submitWithUpdateId<R>(req)).result;
  }

  async submitWithUpdateId<R>(req: SubmitRequest): Promise<SubmitReceipt<R>> {
    this.submits.push(req);
    if (req.command.kind === "createAndExercise") {
      return {
        result: {
          buyerNextAllocationCid: null,
          sellerNextAllocationCid: null,
          buyRemainderCid: null,
          sellRemainderCid: null,
        } as R,
        updateId: "1220settle0001",
      };
    }
    return { result: {} as R, updateId: null };
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
          expiry: null, status: "OS_Funded",
          settlementRef: { id: "DexOrder-testnet", cid: null },
        })) as unknown as T[];
      default:
        return [];
    }
  }

  /** Operator submissions of one choice, in order. */
  choice(name: string): SubmitRequest[] {
    return this.submits.filter(
      (s) => s.command.kind === "createAndExercise" && s.command.choice === name,
    );
  }
}

interface StartedServer {
  url: string;
  close: () => Promise<void>;
  ledger: MatchLedger;
}

async function startServer(
  env: Record<string, string | undefined>,
  opts: { orders?: StubOrder[]; order?: boolean } = {},
): Promise<StartedServer> {
  const ledger = new MatchLedger(opts.orders ?? CROSSING_BOOK);

  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let starting: ReturnType<typeof startHttpServer>;
  try {
    const registry = new StubRegistry();
    const backend = new OperatorBackend({
      ledger,
      registry,
      operatorParty: OPERATOR as never,
    });
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
        ...(opts.order === false
          ? {}
          : {
              order: {
                service: backend.order,
                registry,
                operator: OPERATOR as never,
              },
            }),
        ledgerUrl: LEDGER_URL,
        ledgerToken: "ledger-token",
        userId: "ledger-api-user",
        synchronizerId: "global-domain::1220dd",
      }),
    });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const server = await starting;
  return { url: server.url, close: server.close, ledger };
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

async function withServer(
  env: Record<string, string | undefined>,
  opts: { orders?: StubOrder[]; order?: boolean },
  run: (s: StartedServer) => Promise<void>,
): Promise<void> {
  const server = await startServer(env, opts);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

describe("testnet match: env gate", () => {
  it("does not register the route when the flag is off", async () => {
    await withServer({ DEX_TESTNET_ONBOARDING: undefined }, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/match", {
        base: BASE,
        quote: QUOTE,
      });
      assert.equal(r.status, 404);
      assert.equal(r.body.code, "not_found");
    });
  });
});

describe("testnet match: request validation", () => {
  it("rejects a body missing base or quote", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/match", { base: BASE });
      assert.equal(r.status, 400);
    });
  });

  it("rejects a pair this deployment does not list", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/match", {
        base: "ETH",
        quote: QUOTE,
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "bad_request");
      // The unlisted pair never reached the matcher.
      assert.equal(s.ledger.choice("OrderMatchExecution_Execute").length, 0);
    });
  });
});

describe("testnet match: happy path", () => {
  it("settles the crossing pair and returns the runMatching projection", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/match", {
        base: BASE,
        quote: QUOTE,
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.settled, 1);
      assert.equal(r.body.failed, 0);
      const matches = r.body.matches as Array<Record<string, unknown>>;
      assert.equal(matches.length, 1);
      assert.equal(matches[0]!.buyCid, "00bid:0");
      assert.equal(matches[0]!.sellCid, "00ask:0");
      assert.equal(matches[0]!.quantity, "3.0000000000");

      // The matcher ran under the OPERATOR's authority, on the operator's own
      // admin -- nothing from the caller's body.
      const [execute] = s.ledger.choice("OrderMatchExecution_Execute");
      assert.ok(execute, "expected one OrderMatchExecution_Execute submission");
      assert.deepEqual(execute!.actAs, [OPERATOR]);
      const arg = (execute!.command as { argument: Record<string, unknown> })
        .argument;
      assert.equal(arg.operator, OPERATOR);
    });
  });

  it("clears an empty/non-crossing book as a clean 200 with nothing settled", async () => {
    // A single resting order does not cross: the projection is empty.
    await withServer(
      ON,
      { orders: [CROSSING_BOOK[0]!] },
      async (s) => {
        const r = await postJson(s.url, "/v1/testnet/match", {
          base: BASE,
          quote: QUOTE,
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.settled, 0);
        assert.equal(r.body.failed, 0);
        assert.deepEqual(r.body.matches, []);
        assert.equal(s.ledger.choice("OrderMatchExecution_Execute").length, 0);
      },
    );
  });
});

describe("testnet match: rate limit", () => {
  it("returns 429 once the per-client daily cap is spent", async () => {
    await withServer(
      {
        DEX_TESTNET_ONBOARDING: "1",
        DEX_TESTNET_SUBMIT_DAILY_CAP: "50",
        DEX_TESTNET_SUBMIT_IP_DAILY_CAP: "1",
      },
      {},
      async (s) => {
        assert.equal(
          (await postJson(s.url, "/v1/testnet/match", { base: BASE, quote: QUOTE }))
            .status,
          200,
        );
        const r = await postJson(s.url, "/v1/testnet/match", {
          base: BASE,
          quote: QUOTE,
        });
        assert.equal(r.status, 429);
        assert.equal(r.body.code, "too_many_requests");
      },
    );
  });
});

describe("testnet match: unavailable", () => {
  it("answers 501 when the deployment has no order service", async () => {
    await withServer(ON, { order: false }, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/match", {
        base: BASE,
        quote: QUOTE,
      });
      assert.equal(r.status, 501);
    });
  });
});
