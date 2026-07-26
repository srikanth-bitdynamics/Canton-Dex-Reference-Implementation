// POST /v1/testnet/submit: the public, unauthenticated relay that lets a
// faucet-minted party submit its own trading commands.
//
// Everything here is a security property, so the tests are written against the
// wire in both directions: the request is what a browser would actually send
// (including the fields a hostile one would add), and the assertions are made
// on the envelope the PARTICIPANT would have received -- that is where actAs,
// the disclosure and the command id are decided, and the whole point of the
// endpoint is that none of them are the caller's to choose.
//
// The participant is stubbed the same way json-api-ledger.test.ts stubs it, so
// the route contract and its refusals are pinned without a Canton in the loop.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryLedger } from "../src/ledger/in-memory.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { testnetOnboardingFromEnv } from "../src/testnet-onboarding/index.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type {
  ChoiceContextRef,
  ContractId,
  DisclosedContract,
} from "@canton-dex/registry-client";

const OPERATOR = "dex-operator::1220aa01";
const LP_REGISTRAR = "dex-lp::1220aa03";
const ADMIN = "dex-admin::1220aa02";
/** A party this deployment's faucet minted and this participant hosts. */
const HOSTED = "dex-tester-9f1c4d::1220bb01";
/** Faucet-SHAPED, but allocated somewhere else. Must still be refused. */
const FOREIGN = "dex-tester-0000aa::1220cc99";
const LEDGER_URL = "http://participant:7575";
const UPDATE_ID = "1220update0001";
const ALLOCATION_CID = "00alloc:0";

const ALLOCATION_FACTORY_IID =
  "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory";
const HOLDING_TID = "cafe:CantonDex.Registry.V2:Holding";

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
      allocationFactoryCid: "00registry:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "00registry:0" as ContractId<"SettlementFactory">,
      // Deliberately the same contract the choice context returns: the handler
      // must dedupe, or the participant rejects the submission.
      disclosure: REGISTRY_DISCLOSURE,
    };
  }
  override async getChoiceContext(): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: REGISTRY_DISCLOSURE };
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
  /** Non-2xx status for submit-and-wait, to exercise the ledger-error path. */
  submitStatus?: number;
  submitResponse?: string;
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
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    });
    if (url.includes("/v2/parties/")) {
      const party = decodeURIComponent(url.split("/v2/parties/")[1] ?? "");
      return json({ partyDetails: [{ party, isLocal: hosted.includes(party) }] });
    }
    if (url.includes("/v2/commands/submit-and-wait")) {
      if (opts.submitStatus && opts.submitStatus !== 200) {
        return new Response(opts.submitResponse ?? "", {
          status: opts.submitStatus,
        });
      }
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
  calls: ParticipantCall[];
  submissions: () => Record<string, unknown>[];
}

/**
 * Start the HTTP shim with the given faucet env applied, then restore the
 * environment (the service reads env once, at construction).
 *
 * `participant: false` builds the service with no ledger URL/token at all,
 * which is the in-memory dev server: the faucet works, relaying does not.
 */
async function startServer(
  env: Record<string, string | undefined>,
  opts: ParticipantStubOptions & { participant?: boolean } = {},
): Promise<StartedServer> {
  const ledger = new InMemoryLedger();
  const { fetchImpl, calls, submissions } = participantStub(opts);

  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const backend = new OperatorBackend({
      ledger,
      registry: new StubRegistry(),
      operatorParty: OPERATOR as never,
    });
    const port = 18500 + Math.floor(Math.random() * 1000);
    const server = startHttpServer({
      backend,
      port,
      host: "127.0.0.1",
      context: {
        operator: OPERATOR as never,
        lpRegistrar: LP_REGISTRAR as never,
        admin: ADMIN as never,
        allocationFactoryCid: "00registry:0",
        settlementFactoryCid: "00registry:0",
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
    return { url: server.url, close: server.close, calls, submissions };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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

/** One legitimate command: author an allocation under the registry factory. */
function allocateCommand(): unknown {
  return {
    ExerciseCommand: {
      templateId: ALLOCATION_FACTORY_IID,
      contractId: "00registry:0",
      choice: "AllocationFactory_Allocate",
      choiceArgument: { inputHoldingCids: ["00holding:0"], actors: [HOSTED] },
    },
  };
}

async function withServer(
  env: Record<string, string | undefined>,
  opts: ParticipantStubOptions & { participant?: boolean },
  run: (s: StartedServer) => Promise<void>,
): Promise<void> {
  const server = await startServer(env, opts);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

describe("testnet submit: env gate", () => {
  it("does not register the route when the flag is off", async () => {
    await withServer({ DEX_TESTNET_ONBOARDING: undefined }, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [allocateCommand()],
      });
      assert.equal(r.status, 404);
      assert.equal(r.body.code, "not_found");
    });
  });

  it("answers 501 when the deployment has no participant to relay to", async () => {
    await withServer(ON, { participant: false }, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [allocateCommand()],
      });
      assert.equal(r.status, 501);
      assert.equal(r.body.code, "not_implemented");
    });
  });
});

describe("testnet submit: party eligibility", () => {
  it("rejects the operator's own party", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: OPERATOR,
        commands: [allocateCommand()],
      });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, "forbidden");
      // The refusal must land before anything is submitted for it.
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("rejects the admin and lpRegistrar parties", async () => {
    await withServer(ON, {}, async (s) => {
      for (const party of [ADMIN, LP_REGISTRAR]) {
        const r = await postJson(s.url, "/v1/testnet/submit", {
          party,
          commands: [allocateCommand()],
        });
        assert.equal(r.status, 403, `expected 403 for ${party}`);
      }
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("rejects a well-formed party this participant does not host", async () => {
    // Carries the faucet's own prefix, so only the hosting check catches it.
    await withServer(ON, { hosted: [HOSTED] }, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: FOREIGN,
        commands: [allocateCommand()],
      });
      assert.equal(r.status, 403);
      assert.match(String(r.body.error), /not hosted/);
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("rejects a party that is not a canonical Canton party id", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: "dex-tester-nope",
        commands: [allocateCommand()],
      });
      assert.equal(r.status, 400);
      assert.deepEqual(s.submissions(), []);
    });
  });
});

describe("testnet submit: command allowlist", () => {
  it("rejects a choice that is not on the allowlist, naming it", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [
          {
            ExerciseCommand: {
              templateId: "cafe:CantonDex.Registry.V2:Registry",
              contractId: "00registry:0",
              choice: "Registry_Mint",
              choiceArgument: { amount: "1000000.0" },
            },
          },
        ],
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "bad_request");
      assert.match(String(r.body.error), /Registry_Mint/);
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("rejects an allowlisted choice on a template it does not belong to", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [
          {
            ExerciseCommand: {
              templateId: "cafe:CantonDex.Dex.Pool:Pool",
              contractId: "00pool:0",
              choice: "AllocationFactory_Allocate",
              choiceArgument: {},
            },
          },
        ],
      });
      assert.equal(r.status, 400);
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("rejects a CreateCommand outright", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [
          {
            CreateCommand: {
              templateId: "cafe:CantonDex.Registry.V2:Holding",
              createArguments: {
                owner: HOSTED,
                admin: ADMIN,
                instrumentId: "dUSD",
                amount: "1000000.0",
              },
            },
          },
        ],
      });
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), /CreateCommand/);
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("rejects a command smuggling a second kind alongside the exercise", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [
          {
            ...(allocateCommand() as Record<string, unknown>),
            CreateCommand: {
              templateId: "cafe:CantonDex.Registry.V2:Holding",
              createArguments: {},
            },
          },
        ],
      });
      assert.equal(r.status, 400);
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("caps the number of commands in one submission", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: Array.from({ length: 9 }, allocateCommand),
      });
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), /at most 8 commands/);
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("rejects an empty or non-array commands field", async () => {
    await withServer(ON, {}, async (s) => {
      assert.equal(
        (await postJson(s.url, "/v1/testnet/submit", { party: HOSTED, commands: [] }))
          .status,
        400,
      );
      assert.equal(
        (
          await postJson(s.url, "/v1/testnet/submit", {
            party: HOSTED,
            commands: "AllocationFactory_Allocate",
          })
        ).status,
        400,
      );
      assert.deepEqual(s.submissions(), []);
    });
  });

  // Holding_Split/Merge are `controller admin, owner`. This endpoint acts as the
  // tester alone, so allowing them would only produce a confusing on-ledger
  // DAML_AUTHORIZATION_ERROR. Partial amounts fund by locking whole holdings
  // and letting the registry return change, so nothing needs them.
  it("refuses holding split/merge, which could never carry admin authority", async () => {
    await withServer(ON, {}, async (s) => {
      for (const choice of ["Holding_Split", "Holding_Merge"]) {
        const r = await postJson(s.url, "/v1/testnet/submit", {
          party: HOSTED,
          commands: [
            {
              ExerciseCommand: {
                templateId: HOLDING_TID,
                contractId: "00holding:0",
                choice,
                choiceArgument: {},
              },
            },
          ],
        });
        assert.equal(r.status, 400, `${choice} must be refused`);
      }
      assert.deepEqual(s.submissions(), []);
    });
  });

  it("accepts the trader choices the DvP flow needs", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [
          {
            ExerciseCommand: {
              templateId:
                "#splice-api-token-allocation-request-v2:Splice.Api.Token.AllocationRequestV2:AllocationRequest",
              contractId: "00request:0",
              choice: "AllocationRequest_Accept",
              choiceArgument: { actors: [HOSTED] },
            },
          },
          {
            ExerciseCommand: {
              templateId:
                "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory",
              contractId: "00factory:0",
              choice: "AllocationFactory_Allocate",
              choiceArgument: { actors: [HOSTED] },
            },
          },
        ],
      });
      assert.equal(r.status, 200);
      const submitted = s.submissions()[0]!;
      assert.deepEqual(
        (submitted.commands as Array<{ ExerciseCommand: { choice: string } }>).map(
          (c) => c.ExerciseCommand.choice,
        ),
        ["AllocationRequest_Accept", "AllocationFactory_Allocate"],
      );
    });
  });
});

describe("testnet submit: the envelope is the server's", () => {
  it("ignores caller-supplied actAs, readAs, userId, commandId and disclosure", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [allocateCommand()],
        // Everything a hostile caller would try to bring along.
        actAs: [OPERATOR, ADMIN],
        readAs: [ADMIN],
        userId: "participant_admin",
        applicationId: "participant_admin",
        commandId: "replay-me",
        disclosedContracts: [
          {
            templateId: "cafe:CantonDex.Registry.V2:Registry",
            contractId: "00attacker:0",
            createdEventBlob: "attacker-blob",
          },
        ],
        synchronizerId: "attacker-domain::1220ff",
      });
      assert.equal(r.status, 200);

      const submitted = s.submissions()[0]!;
      // The one assertion this endpoint exists to satisfy.
      assert.deepEqual(submitted.actAs, [HOSTED]);
      assert.deepEqual(submitted.readAs, []);
      assert.equal(submitted.userId, "ledger-api-user");
      assert.equal(submitted.applicationId, "ledger-api-user");
      assert.match(String(submitted.commandId), /^testnet-submit-/);
      assert.equal(submitted.synchronizerId, "global-domain::1220dd");
      // The disclosure is the operator's, deduped across the two registry
      // calls, and carries nothing the caller supplied.
      assert.deepEqual(submitted.disclosedContracts, REGISTRY_DISCLOSURE);
    });
  });

  it("forwards only the validated fields of a command", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [
          {
            ExerciseCommand: {
              templateId: ALLOCATION_FACTORY_IID,
              contractId: "00registry:0",
              choice: "AllocationFactory_Allocate",
              choiceArgument: { actors: [HOSTED] },
              disclosedContracts: [{ contractId: "00attacker:0" }],
            },
          },
        ],
      });
      assert.equal(r.status, 200);
      const cmd = (
        s.submissions()[0]!.commands as Array<{
          ExerciseCommand: Record<string, unknown>;
        }>
      )[0]!.ExerciseCommand;
      assert.deepEqual(Object.keys(cmd).sort(), [
        "choice",
        "choiceArgument",
        "contractId",
        "templateId",
      ]);
    });
  });
});

describe("testnet submit: rate limit", () => {
  it("returns 429 once the per-client daily cap is spent", async () => {
    await withServer(
      {
        DEX_TESTNET_ONBOARDING: "1",
        DEX_TESTNET_SUBMIT_DAILY_CAP: "50",
        DEX_TESTNET_SUBMIT_IP_DAILY_CAP: "1",
      },
      {},
      async (s) => {
        const body = { party: HOSTED, commands: [allocateCommand()] };
        assert.equal((await postJson(s.url, "/v1/testnet/submit", body)).status, 200);
        const r = await postJson(s.url, "/v1/testnet/submit", body);
        assert.equal(r.status, 429);
        assert.equal(r.body.code, "too_many_requests");
        assert.equal(
          (r.body.details as { scope?: string } | undefined)?.scope,
          "ip",
        );
        // The throttled request never reached the participant.
        assert.equal(s.submissions().length, 1);
      },
    );
  });

  it("returns 429 once the global daily cap is spent", async () => {
    await withServer(
      {
        DEX_TESTNET_ONBOARDING: "1",
        DEX_TESTNET_SUBMIT_DAILY_CAP: "1",
        DEX_TESTNET_SUBMIT_IP_DAILY_CAP: "50",
      },
      {},
      async (s) => {
        const body = { party: HOSTED, commands: [allocateCommand()] };
        assert.equal((await postJson(s.url, "/v1/testnet/submit", body)).status, 200);
        const r = await postJson(s.url, "/v1/testnet/submit", body);
        assert.equal(r.status, 429);
        assert.equal(
          (r.body.details as { scope?: string } | undefined)?.scope,
          "global",
        );
      },
    );
  });
});

describe("testnet submit: happy path", () => {
  it("returns the updateId and the transaction's created events", async () => {
    await withServer(ON, {}, async (s) => {
      const r = await postJson(s.url, "/v1/testnet/submit", {
        party: HOSTED,
        commands: [allocateCommand()],
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.updateId, UPDATE_ID);
      assert.deepEqual(r.body.createdEvents, [
        {
          contractId: ALLOCATION_CID,
          templateId: "cafe:CantonDex.Registry.V2:Allocation",
        },
      ]);
      // The tree is read as the tester's party and nobody else's.
      const tree = s.calls.find((c) =>
        c.url.includes("/v2/updates/transaction-tree-by-id/"),
      );
      assert.ok(tree, "expected the transaction tree to be fetched");
      assert.equal(
        new URL(tree.url).searchParams.getAll("parties").join(","),
        HOSTED,
      );
    });
  });
});

describe("testnet submit: ledger failures", () => {
  it("summarizes a participant rejection instead of echoing the payload", async () => {
    await withServer(
      ON,
      {
        submitStatus: 400,
        submitResponse: JSON.stringify({
          cause:
            "CONTRACT_NOT_FOUND(11,abcd): Contract could not be found with id 00holding:0",
        }),
      },
      async (s) => {
        const r = await postJson(s.url, "/v1/testnet/submit", {
          party: HOSTED,
          commands: [allocateCommand()],
        });
        assert.equal(r.status, 502);
        assert.equal(r.body.code, "ledger_rejected");
        assert.deepEqual(r.body.details, {
          ledgerStatus: 400,
          ledgerErrorCode: "CONTRACT_NOT_FOUND",
        });
        // Nothing of the caller's submission is quoted back.
        const wire = JSON.stringify(r.body);
        assert.ok(!wire.includes("ledger-token"));
        assert.ok(!wire.includes("00holding:0"));
        assert.ok(!wire.includes("AllocationFactory_Allocate"));
      },
    );
  });
});
