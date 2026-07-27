// POST /v1/testnet/swap: the public, unauthenticated endpoint that drives a
// whole swap -- both operator steps and the trader step between them -- for a
// party this deployment's faucet minted.
//
// It is the only route that performs an operator-authority write for an
// anonymous caller, so the tests are written against both wires: the request is
// what a browser (or a hostile one) would actually send, and the assertions are
// made on what the OPERATOR submitted and what the PARTICIPANT received. That
// is where the pool, the amounts, the funding holdings and the settled
// allocation are decided, and the point of the endpoint is that none of them
// are the caller's to choose.
//
// The participant is stubbed the way testnet-submit.test.ts stubs it; the pool
// is served by a ledger stub, so the three-step orchestration is pinned without
// a Canton in the loop.

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
} from "@canton-dex/registry-client";

const OPERATOR = "dex-operator::1220aa01";
const ADMIN = "dex-admin::1220aa02";
const LP_REGISTRAR = "dex-lp::1220aa03";
/** A party this deployment's faucet minted and this participant hosts. */
const HOSTED = "dex-tester-9f1c4d::1220bb01";
/** Faucet-SHAPED, but allocated somewhere else. Must still be refused. */
const FOREIGN = "dex-tester-0000aa::1220cc99";
/** Another tester, whose holdings must never fund the first one's swap. */
const OTHER_TESTER = "dex-tester-5b2e77::1220bb02";

const LEDGER_URL = "http://participant:7575";
const UPDATE_ID = "1220update0001";
/** The allocation the relayed transaction actually created. */
const ALLOCATION_CID = "00alloc:0";
const POOL_CID = "00pool:0";
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

/** The spec PoolRules_RequestSwap builds in Daml for the swapper to author. */
const ALLOCATION_SPEC = {
  admin: ADMIN,
  authorizer: { owner: HOSTED, provider: null, id: "" },
  transferLegSides: [],
  settlementDeadline: null,
  nextIterationFunding: null,
  committed: false,
  meta: {},
};
const SETTLEMENT = {
  executors: [OPERATOR],
  id: `pool-swap-${POOL_CID}`,
  cid: null,
  meta: {},
};

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
  override async getFactories() {
    return {
      allocationFactoryCid: FACTORY_CID as ContractId<"AllocationFactory">,
      settlementFactoryCid: "00settle:0" as ContractId<"SettlementFactory">,
      // Deliberately the same contract the choice context returns: the swap
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

/** The tester's own funds: two dUSD pieces, neither covering 10.0 alone. */
const DEFAULT_HOLDINGS: StubHolding[] = [
  { contractId: "00own-a:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "6.0000000000" },
  { contractId: "00own-b:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "5.0000000000" },
  // Never selectable: locked, wrong instrument, or someone else's.
  { contractId: "00own-locked:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "500.0000000000", locked: true },
  { contractId: "00own-btc:0", admin: ADMIN, owner: HOSTED, instrumentId: BASE, amount: "500.0000000000" },
  { contractId: "00foreign:0", admin: ADMIN, owner: OTHER_TESTER, instrumentId: QUOTE, amount: "500.0000000000" },
];

/**
 * Serves the pool read model the swap needs and records every operator
 * submission, so a test can pin exactly what PoolRules_RequestSwap and
 * PoolRules_Swap were called with.
 */
class PoolLedger implements LedgerSubmitter {
  readonly submits: SubmitRequest[] = [];

  constructor(readonly holdings: StubHolding[] = DEFAULT_HOLDINGS) {}

  async submit<R>(req: SubmitRequest): Promise<R> {
    this.submits.push(req);
    if (
      req.command.kind === "exercise" &&
      req.command.choice === "PoolRules_RequestSwap"
    ) {
      // What the Daml choice returns: the spec + settlement the wallet authors.
      return { settlement: SETTLEMENT, allocationSpec: ALLOCATION_SPEC } as R;
    }
    return "#result:0" as R;
  }

  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {
    // no streaming in this stub
  }

  /** Operator-discovery: what the committed allocation transaction created. */
  async treeCreatedEvents(): Promise<CreatedEventRef[]> {
    return [
      {
        contractId: ALLOCATION_CID,
        templateId: "cafe:CantonDex.Registry.V2:Allocation",
      },
    ];
  }

  async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    switch (filter.templateId) {
      case "CantonDex.Dex.Pool:Pool":
        return [{
          contractId: POOL_CID, poolId: `${BASE}/${QUOTE}`, operator: OPERATOR,
          lpRegistrar: LP_REGISTRAR, admin: ADMIN,
          baseInstrumentId: BASE, quoteInstrumentId: QUOTE,
          lpInstrumentId: { admin: LP_REGISTRAR, id: `${BASE}-${QUOTE}-LP` },
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
  /** Serve the relayed transaction's created events, or report none. */
  createdEvents?: boolean;
}

/** Stand-in participant: party lookup, submit-and-wait, transaction tree. */
function participantStub(opts: ParticipantStubOptions = {}): {
  fetchImpl: typeof fetch;
  calls: ParticipantCall[];
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
      if (opts.createdEvents === false) return json({ transaction: {} });
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
    calls,
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
  backend: OperatorBackend;
  submissions: () => Record<string, unknown>[];
}

/**
 * Start the HTTP shim with the given faucet env applied, then restore the
 * environment (the service reads env once, at construction).
 *
 * `participant: false` builds the service with no ledger URL/token at all,
 * which is the in-memory dev server: the faucet works, swapping does not.
 */
async function startServer(
  env: Record<string, string | undefined>,
  opts: ParticipantStubOptions & {
    participant?: boolean;
    holdings?: StubHolding[];
  } = {},
): Promise<StartedServer> {
  const ledger = new PoolLedger(opts.holdings ?? DEFAULT_HOLDINGS);
  const { fetchImpl, submissions } = participantStub(opts);
  // Reads no env of its own, so it can be built before the swap below.
  const backend = new OperatorBackend({
    ledger,
    registry: new StubRegistry(),
    operatorParty: OPERATOR as never,
  });

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
        pool: backend.pool,
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
  return { url: server.url, close: server.close, ledger, backend, submissions };
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

/** A well-formed swap of 10 dUSD for BTC by the hosted tester. */
function swapBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    party: HOSTED,
    poolCid: POOL_CID,
    inputInstrumentId: QUOTE,
    inputAmount: "10.0000000000",
    ...extra,
  };
}

async function withServer(
  env: Record<string, string | undefined>,
  opts: ParticipantStubOptions & {
    participant?: boolean;
    holdings?: StubHolding[];
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

describe("testnet swap: env gate", () => {
  it("does not register the route when the flag is off", async () => {
    await withServer({ DEX_TESTNET_ONBOARDING: undefined }, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/swap", swapBody());
      assert.equal(r.status, 404);
      assert.equal(r.body.code, "not_found");
      assert.deepEqual(s.ledger.choice("PoolRules_RequestSwap"), []);
    });
  });

  it("answers 501 when the deployment has no participant to settle on", async () => {
    await withServer(ON, { participant: false }, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/swap", swapBody());
      assert.equal(r.status, 501);
      assert.equal(r.body.code, "not_implemented");
      assert.deepEqual(s.ledger.choice("PoolRules_RequestSwap"), []);
    });
  });
});

describe("testnet swap: party eligibility", () => {
  it("rejects the operator's own party before submitting anything", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/swap",
        swapBody({ party: OPERATOR }),
      );
      assert.equal(r.status, 403);
      assert.equal(r.body.code, "forbidden");
      // The refusal lands before the operator writes anything for it.
      assert.deepEqual(s.ledger.choice("PoolRules_RequestSwap"), []);
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("rejects the admin and lpRegistrar parties", async () => {
    await withServer(ON, {}, async (s) => {
      for (const party of [ADMIN, LP_REGISTRAR]) {
        const r = await postJson(s.url, "/v1/testnet/swap", swapBody({ party }));
        assert.equal(r.status, 403, `expected 403 for ${party}`);
      }
      assert.deepEqual(s.ledger.choice("PoolRules_RequestSwap"), []);
    });
  });

  it("rejects a faucet-shaped party this participant does not host", async () => {
    await withServer(ON, { hosted: [HOSTED] }, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/swap",
        swapBody({ party: FOREIGN }),
      );
      assert.equal(r.status, 403);
      assert.match(String(r.body.error), /not hosted/);
      assert.deepEqual(s.ledger.choice("PoolRules_RequestSwap"), []);
    });
  });
});

describe("testnet swap: request validation", () => {
  it("rejects a pool this deployment does not serve", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/swap",
        swapBody({ poolCid: "00nosuchpool:0" }),
      );
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), /unknown or inactive pool/);
      assert.deepEqual(s.ledger.choice("PoolRules_RequestSwap"), []);
    });
  });

  it("rejects an instrument the pool does not trade", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/swap",
        swapBody({ inputInstrumentId: "EUR" }),
      );
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), /not one of the pool's two instruments/);
      assert.deepEqual(s.ledger.choice("PoolRules_RequestSwap"), []);
    });
  });

  it("rejects a non-positive or malformed amount", async () => {
    await withServer(ON, {}, async (s) => {
      for (const inputAmount of ["0.0", "-5.0", "lots"]) {
        const r = await postJson(
          s.url,
          "/v1/testnet/swap",
          swapBody({ inputAmount }),
        );
        assert.equal(r.status, 400, `expected 400 for ${inputAmount}`);
      }
      assert.deepEqual(s.ledger.choice("PoolRules_RequestSwap"), []);
    });
  });

  it("reports a shortfall against the party's unlocked balance", async () => {
    // 6 + 5 unlocked dUSD; the locked 500 and the other tester's 500 are not
    // this party's to spend.
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/swap",
        swapBody({ inputAmount: "50.0000000000" }),
      );
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "bad_request");
      assert.match(
        String(r.body.error),
        /insufficient unlocked dUSD balance: have 11\.0000000000, need 50\.0000000000/,
      );
      // Nothing was submitted on a swap that could never have funded.
      assert.deepEqual(s.ledger.choice("PoolRules_RequestSwap"), []);
      assert.deepEqual(s.submissions(), []);
    });
  });
});

describe("testnet swap: the funding is the server's", () => {
  it("ignores holding cids supplied in the body and locks the party's own", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/swap",
        swapBody({
          // Everything a hostile caller would try to bring along.
          inputHoldingCids: ["00foreign:0"],
          holdingCids: ["00foreign:0"],
          actAs: [OPERATOR, ADMIN],
          swapperAccount: { owner: OPERATOR, provider: null, id: "" },
        }),
      );
      assert.equal(r.status, 200);

      const allocate = relayedAllocate(s);
      const arg = allocate.choiceArgument as Record<string, unknown>;
      // Two unlocked pieces of the tester's own dUSD, because neither covers
      // 10.0 alone. Never the other tester's, the locked one, or the BTC one.
      assert.deepEqual(arg.inputHoldingCids, ["00own-a:0", "00own-b:0"]);
      assert.deepEqual(arg.actors, [HOSTED]);
      // ... and the relay still fixed the authority to the one eligible party.
      assert.deepEqual(s.submissions()[0]!.actAs, [HOSTED]);
      assert.deepEqual(s.submissions()[0]!.readAs, []);
      // The operator steps run for the same party, not the one in the body.
      assert.equal(s.ledger.argument("PoolRules_RequestSwap").swapper, HOSTED);
      assert.deepEqual(s.ledger.argument("PoolRules_Swap").swapperAccount, {
        owner: HOSTED,
        provider: null,
        id: "",
      });
    });
  });

  it("locks a single covering holding when one is enough", async () => {
    await withServer(
      ON,
      {
        holdings: [
          { contractId: "00big:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "900.0000000000" },
          { contractId: "00small:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "40.0000000000" },
        ],
      },
      async (s) => {
        const r = await postJson(s.url, "/v1/testnet/swap", swapBody());
        assert.equal(r.status, 200);
        // The smallest single piece that covers 10.0 — least surplus locked,
        // and no split (which this path has no admin authority for).
        const arg = relayedAllocate(s).choiceArgument as Record<string, unknown>;
        assert.deepEqual(arg.inputHoldingCids, ["00small:0"]);
      },
    );
  });

  it("relays the operator's disclosure, deduped, and nothing of the caller's", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/swap",
        swapBody({
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
      assert.deepEqual(
        s.submissions()[0]!.disclosedContracts,
        REGISTRY_DISCLOSURE,
      );
    });
  });
});

describe("testnet swap: the settle binds to the relayed allocation", () => {
  it("settles the allocation the relay created, not one named in the body", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/swap",
        swapBody({
          swapperAllocationCid: "00attacker-alloc:0",
          updateId: "1220attacker",
        }),
      );
      assert.equal(r.status, 200);
      assert.equal(r.body.allocationCid, ALLOCATION_CID);

      const settle = s.ledger.argument("PoolRules_Swap");
      assert.equal(settle.swapperAllocationCid, ALLOCATION_CID);
      // The command carries the allocation itself, so no updateId discovery.
      const wire = JSON.stringify(settle);
      assert.ok(!wire.includes("00attacker-alloc:0"));
      assert.ok(!wire.includes("1220attacker"));
    });
  });

  it("falls back to updateId discovery when the relay reports no created events", async () => {
    await withServer(ON, { createdEvents: false }, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/swap", swapBody());
      assert.equal(r.status, 200);
      assert.equal(r.body.allocationCid, null);
      assert.equal(r.body.updateId, UPDATE_ID);

      // The settle is bound by updateId instead, and pool.swap recovers the cid
      // from the transaction tree -- so what reaches the choice is still the
      // allocation the relay created.
      const settle = s.ledger.argument("PoolRules_Swap");
      assert.equal(settle.swapperAllocationCid, ALLOCATION_CID);
    });
  });
});

describe("testnet swap: happy path", () => {
  it("returns the updateId and the amounts, and settles at the quoted floor", async () => {
    await withServer(ON, {}, async (s) => {
      const pools = await s.backend.pool.listActive();
      const expected = s.backend.pool.computeQuote(
        pools[0]!,
        QUOTE,
        "10.0000000000",
      );

      const r = await postJson(s.url, "/v1/testnet/swap", swapBody());
      assert.equal(r.status, 200);
      assert.equal(r.body.updateId, UPDATE_ID);
      assert.equal(r.body.inputAmount, "10.0000000000");
      assert.equal(r.body.outputAmount, expected);
      assert.equal(r.body.allocationCid, ALLOCATION_CID);

      // Absent minOutputAmount means the operator's own quote is the floor, so
      // the swap cannot settle worse than what the caller was told.
      const settle = s.ledger.argument("PoolRules_Swap");
      assert.equal(settle.minOutputAmount, expected);
      assert.equal(settle.inputAmount, "10.0000000000");
      assert.equal(settle.inputInstrumentId, QUOTE);
      assert.equal(settle.poolCid, POOL_CID);

      // The relayed command is the trader step of the flow, on the factory the
      // request named, carrying the spec the request built.
      const allocate = relayedAllocate(s);
      assert.equal(allocate.templateId, ALLOCATION_FACTORY_IID);
      assert.equal(allocate.contractId, FACTORY_CID);
      assert.equal(allocate.choice, "AllocationFactory_Allocate");
      const arg = allocate.choiceArgument as Record<string, unknown>;
      assert.deepEqual(arg.allocation, ALLOCATION_SPEC);
      assert.deepEqual(arg.settlement, SETTLEMENT);
    });
  });

  it("honours a caller-supplied slippage floor", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(
        s.url,
        "/v1/testnet/swap",
        swapBody({ minOutputAmount: "0.0500000000" }),
      );
      assert.equal(r.status, 200);
      assert.equal(
        s.ledger.argument("PoolRules_Swap").minOutputAmount,
        "0.0500000000",
      );
    });
  });
});

describe("testnet swap: rate limit", () => {
  it("returns 429 once the per-client daily cap is spent", async () => {
    // A swap charges the submission budget twice: once for the operator work
    // and once for the relayed allocation.
    await withServer(
      {
        DEX_TESTNET_ONBOARDING: "1",
        DEX_TESTNET_SUBMIT_DAILY_CAP: "50",
        DEX_TESTNET_SUBMIT_IP_DAILY_CAP: "2",
      },
      {},
      async (s) => {
        assert.equal(
          (await postJson(s.url, "/v1/testnet/swap", swapBody())).status,
          200,
        );
        const r = await postJson(s.url, "/v1/testnet/swap", swapBody());
        assert.equal(r.status, 429);
        assert.equal(r.body.code, "too_many_requests");
        assert.equal(
          (r.body.details as { scope?: string } | undefined)?.scope,
          "ip",
        );
        // The throttled request never reached the ledger.
        assert.equal(s.ledger.choice("PoolRules_RequestSwap").length, 1);
      },
    );
  });
});
