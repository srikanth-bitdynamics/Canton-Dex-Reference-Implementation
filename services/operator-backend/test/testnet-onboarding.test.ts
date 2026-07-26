// Testnet-only hosted-party onboarding: the env gate, the shape of a
// successful allocation, the airdrop's mint path, the caps, and the hosting
// lookup.
//
// The flow is exercised end-to-end over the HTTP shim against an
// InMemoryLedger, which is what the in-memory provisioner exists for: no
// participant is needed to prove the route contract or the security
// properties (server-generated party id, throttling).
//
// The ledger here registers the Registry.V2 issuance handlers, so the airdrop
// runs the same Registry_Mint path it runs on a participant -- including the
// InstrumentConfig cid rotation that a cached cid would break.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { InMemoryLedger } from "../src/ledger/in-memory.js";
import type { SubmitRequest } from "../src/ledger/index.js";
import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import {
  JsonApiPartyProvisioner,
  parseAirdropSpec,
  testnetOnboardingFromEnv,
} from "../src/testnet-onboarding/index.js";
import {
  registerRegistryV2Handlers,
  seedRegistryV2,
} from "../src/testnet-onboarding/in-memory-registry.js";
import {
  INSTRUMENT_CONFIG_TEMPLATE_ID,
  REGISTRY_HOLDING_TEMPLATE_ID,
} from "../src/testnet-onboarding/registry-mint.js";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef, ContractId } from "@canton-dex/registry-client";

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
  override async getFactories() {
    return {
      allocationFactoryCid: "#alloc:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "#settle:0" as ContractId<"SettlementFactory">,
      disclosure: [] as never[],
    };
  }
  override async getChoiceContext(): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: [] };
  }
}

const ADMIN = "ad";
const OPERATOR = "op";
const LEGACY_HOLDING_TEMPLATE_ID = "CantonDex.Instrument.Holding:Holding";

/** Keeps every submitted command so tests can pin actAs and the choice used. */
class RecordingLedger extends InMemoryLedger {
  readonly submits: SubmitRequest[] = [];

  override async submit<R>(req: SubmitRequest): Promise<R> {
    this.submits.push(req);
    return super.submit<R>(req);
  }
}

interface StartedServer {
  url: string;
  close: () => Promise<void>;
  ledger: RecordingLedger;
}

/**
 * Start the HTTP shim with the onboarding env applied, then restore the
 * environment. The service reads env once at construction, so each server gets
 * exactly the caps its test asked for.
 *
 * `bootstrap: false` starts a ledger with no Registry.V2 at all, and
 * `instruments` controls which ones were registered -- both stand in for an
 * operator who has not run scripts/bootstrap-registry.ts.
 */
async function startServer(
  env: Record<string, string | undefined>,
  opts: { bootstrap?: boolean; instruments?: string[] } = {},
): Promise<StartedServer> {
  const ledger = new RecordingLedger();
  // Same registration the dev server makes: the airdrop goes through
  // Registry_Mint, so without these the mint has no handler at all.
  registerRegistryV2Handlers(ledger, { admin: ADMIN, observers: [OPERATOR] });
  // The legacy holding template keeps a create handler with real observers on
  // purpose: it is what lets the regression test below SEE a holding created
  // under the wrong template rather than have it silently invisible to query.
  ledger.registerCreateHandler(LEGACY_HOLDING_TEMPLATE_ID, (payload) => ({
    observers: [ADMIN, OPERATOR, (payload as { owner: string }).owner],
  }));
  // Local stand-in for the registry bootstrap. Seeded before the env is
  // touched: none of it reads the faucet's env vars.
  if (opts.bootstrap !== false) {
    await seedRegistryV2(ledger, {
      admin: ADMIN,
      users: [OPERATOR],
      instruments: opts.instruments ?? ["dUSD"],
    });
  }

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
    const port = 17180 + Math.floor(Math.random() * 1000);
    const server = startHttpServer({
      backend,
      port,
      host: "127.0.0.1",
      context: {
        operator: OPERATOR as never,
        lpRegistrar: "lp" as never,
        admin: ADMIN as never,
        allocationFactoryCid: "#alloc:0",
        settlementFactoryCid: "#settle:0",
        allocationFactoryExtraArgs: { context: { values: {} }, meta: { values: {} } },
        allocationFactoryDisclosure: [],
        network: "canton:test",
      },
      testnetOnboarding: testnetOnboardingFromEnv({
        ledger,
        admin: ADMIN as never,
      }),
    });
    return { url: server.url, close: server.close, ledger };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function getJson(
  url: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function postJson(
  url: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

interface PartyResponse {
  partyId: string;
  airdrops: Array<{ instrumentId: string; amount: string }>;
}

describe("testnet onboarding: env gate", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    ({ url, close } = await startServer({ DEX_TESTNET_ONBOARDING: undefined }));
  });
  after(async () => {
    await close();
  });

  it("does not register POST /v1/testnet/party when the flag is off", async () => {
    const r = await postJson(url, "/v1/testnet/party", {});
    assert.equal(r.status, 404);
    assert.equal((r.body as { code?: string }).code, "not_found");
  });

  it("does not register GET /v1/testnet/hosting when the flag is off", async () => {
    const r = await getJson(url, "/v1/testnet/hosting?party=whoever");
    assert.equal(r.status, 404);
  });

  it("stays off for any value other than 1", async () => {
    const other = await startServer({ DEX_TESTNET_ONBOARDING: "true" });
    try {
      assert.equal((await postJson(other.url, "/v1/testnet/party", {})).status, 404);
    } finally {
      await other.close();
    }
  });
});

describe("testnet onboarding: allocation", () => {
  let url: string;
  let close: () => Promise<void>;
  let ledger: RecordingLedger;

  before(async () => {
    ({ url, close, ledger } = await startServer({
      DEX_TESTNET_ONBOARDING: "1",
      DEX_TESTNET_PARTY_DAILY_CAP: "50",
      DEX_TESTNET_PARTY_IP_DAILY_CAP: "50",
      DEX_TESTNET_AIRDROP: undefined,
    }));
  });
  after(async () => {
    await close();
  });

  it("returns 201 with a server-generated partyId and the configured airdrops", async () => {
    const r = await postJson(url, "/v1/testnet/party", {});
    assert.equal(r.status, 201);
    const body = r.body as PartyResponse;
    assert.match(body.partyId, /^dex-tester-[0-9a-f-]{36}::[0-9a-f]+$/);
    assert.deepEqual(body.airdrops, [
      { instrumentId: "dUSD", amount: "10000.0000000000" },
    ]);
  });

  it("allocates a distinct party per call", async () => {
    const a = (await postJson(url, "/v1/testnet/party", {})).body as PartyResponse;
    const b = (await postJson(url, "/v1/testnet/party", {})).body as PartyResponse;
    assert.notEqual(a.partyId, b.partyId);
  });

  it("credits the airdrop to the new party", async () => {
    const created = (await postJson(url, "/v1/testnet/party", {}))
      .body as PartyResponse;
    const r = await getJson(
      url,
      `/v1/holdings?owner=${encodeURIComponent(created.partyId)}`,
    );
    assert.equal(r.status, 200);
    const holdings = r.body as Array<{
      owner: string;
      instrumentId: string;
      amount: string;
    }>;
    assert.equal(holdings.length, 1);
    assert.equal(holdings[0]!.owner, created.partyId);
    assert.equal(holdings[0]!.instrumentId, "dUSD");
    assert.equal(holdings[0]!.amount, "10000.0000000000");
  });

  it("mints the airdrop under the Registry.V2 holding template", async () => {
    const created = (await postJson(url, "/v1/testnet/party", {}))
      .body as PartyResponse;

    const v2 = await ledger.query<{
      owner: string;
      instrumentId: string;
      amount: string;
      locked: boolean;
    }>({
      templateId: REGISTRY_HOLDING_TEMPLATE_ID,
      observingParty: ADMIN as never,
    });
    const minted = v2.filter((h) => h.owner === created.partyId);
    assert.equal(minted.length, 1);
    assert.equal(minted[0]!.instrumentId, "dUSD");
    assert.equal(minted[0]!.amount, "10000.0000000000");
    assert.equal(minted[0]!.locked, false);

    // The regression. `CantonDex.Instrument.Holding:Holding` has no
    // V2.Holding interface instance, so a holding minted there shows a balance
    // in the dApp (GET /v1/holdings merges both templates) while every swap
    // and allocation against it fails at fetch time. The previous test above
    // passes either way -- this is the one that catches it.
    const legacy = await ledger.query<{ owner: string }>({
      templateId: LEGACY_HOLDING_TEMPLATE_ID,
      observingParty: ADMIN as never,
    });
    assert.deepEqual(
      legacy.filter((h) => h.owner === created.partyId),
      [],
    );
  });

  it("submits the mint as the admin and the new party together", async () => {
    const from = ledger.submits.length;
    const created = (await postJson(url, "/v1/testnet/party", {}))
      .body as PartyResponse;

    const mints = ledger.submits
      .slice(from)
      .filter(
        (s) =>
          s.command.kind === "exercise" && s.command.choice === "Registry_Mint",
      );
    assert.equal(mints.length, 1);
    // Registry_Mint is `controller admin, owner`: with the admin alone the
    // participant rejects the submission before Daml is reached.
    assert.deepEqual(mints[0]!.actAs, [ADMIN, created.partyId]);
  });

  it("re-resolves the InstrumentConfig cid, which rotates on every mint", async () => {
    const dusdConfig = async (): Promise<{
      contractId: string;
      circulatingSupply: string;
    }> => {
      const configs = await ledger.query<{
        contractId: string;
        instrumentId: string;
        circulatingSupply: string;
      }>({
        templateId: INSTRUMENT_CONFIG_TEMPLATE_ID,
        observingParty: ADMIN as never,
      });
      const dusd = configs.filter((c) => c.instrumentId === "dUSD");
      assert.equal(dusd.length, 1, "exactly one active config per instrument");
      return dusd[0]!;
    };

    const start = await dusdConfig();
    assert.equal((await postJson(url, "/v1/testnet/party", {})).status, 201);
    const afterFirst = await dusdConfig();
    // The second call is the one that used to be impossible with a cached
    // cid: Registry_Mint exercises the consuming InstrumentConfig_BumpSupply,
    // so the cid the first mint used is already archived.
    assert.equal((await postJson(url, "/v1/testnet/party", {})).status, 201);
    const afterSecond = await dusdConfig();

    assert.notEqual(afterFirst.contractId, start.contractId);
    assert.notEqual(afterSecond.contractId, afterFirst.contractId);
    assert.equal(
      Number(afterSecond.circulatingSupply) - Number(start.circulatingSupply),
      20000,
    );
  });

  it("accepts a display label without letting it reach the party id", async () => {
    const r = await postJson(url, "/v1/testnet/party", { label: "Ada's laptop" });
    assert.equal(r.status, 201);
    const body = r.body as PartyResponse;
    assert.ok(body.partyId.startsWith("dex-tester-"));
    assert.ok(!body.partyId.includes("Ada"));
  });

  it("ignores a caller-supplied party id or hint", async () => {
    // The dangerous case: if any of these reached the allocator, the caller
    // would be granted CanActAs on a party of their choosing.
    const r = await postJson(url, "/v1/testnet/party", {
      partyId: "op",
      party: "op",
      partyIdHint: "op",
      hint: "op",
      label: "op",
    });
    assert.equal(r.status, 201);
    const body = r.body as PartyResponse;
    assert.match(body.partyId, /^dex-tester-[0-9a-f-]{36}::[0-9a-f]+$/);
    assert.notEqual(body.partyId, "op");
    assert.equal(await hostedHere(url, "op"), false);
  });

  it("rejects a non-object body", async () => {
    const r = await postJson(url, "/v1/testnet/party", ["not", "an", "object"]);
    assert.equal(r.status, 400);
  });
});

describe("testnet onboarding: bootstrap prerequisites", () => {
  it("fails loudly, and registers nothing, for an unregistered instrument", async () => {
    const { url, close, ledger } = await startServer({
      DEX_TESTNET_ONBOARDING: "1",
      DEX_TESTNET_AIRDROP: "NOPE:1",
    });
    try {
      const r = await postJson(url, "/v1/testnet/party", {});
      assert.equal(r.status, 503);
      const body = r.body as {
        code?: string;
        error?: string;
        details?: { instrumentId?: string };
      };
      assert.equal(body.code, "service_unavailable");
      assert.equal(body.details?.instrumentId, "NOPE");
      // The message has to be actionable: which instrument, and what to run.
      assert.match(String(body.error), /NOPE/);
      assert.match(String(body.error), /bootstrap-registry/);

      // Silently registering an instrument from a public endpoint is exactly
      // what this failure exists to prevent.
      const configs = await ledger.query<{ instrumentId: string }>({
        templateId: INSTRUMENT_CONFIG_TEMPLATE_ID,
        observingParty: ADMIN as never,
      });
      assert.deepEqual(
        configs.filter((c) => c.instrumentId === "NOPE"),
        [],
      );
    } finally {
      await close();
    }
  });

  it("fails loudly when the registry itself was never created", async () => {
    const { url, close } = await startServer(
      { DEX_TESTNET_ONBOARDING: "1" },
      { bootstrap: false },
    );
    try {
      const r = await postJson(url, "/v1/testnet/party", {});
      assert.equal(r.status, 503);
      const body = r.body as { code?: string; error?: string };
      assert.equal(body.code, "service_unavailable");
      assert.match(String(body.error), /Registry\.V2/);
      assert.match(String(body.error), /bootstrap-registry/);
    } finally {
      await close();
    }
  });
});

describe("testnet onboarding: caps", () => {
  it("returns 429 once the global daily cap is spent", async () => {
    const { url, close } = await startServer({
      DEX_TESTNET_ONBOARDING: "1",
      DEX_TESTNET_PARTY_DAILY_CAP: "2",
      DEX_TESTNET_PARTY_IP_DAILY_CAP: "99",
    });
    try {
      assert.equal((await postJson(url, "/v1/testnet/party", {})).status, 201);
      assert.equal((await postJson(url, "/v1/testnet/party", {})).status, 201);
      const r = await postJson(url, "/v1/testnet/party", {});
      assert.equal(r.status, 429);
      assert.equal((r.body as { code?: string }).code, "too_many_requests");
      assert.equal(
        (r.body as { details?: { scope?: string } }).details?.scope,
        "global",
      );
    } finally {
      await close();
    }
  });

  it("returns 429 once one client has spent its per-IP quota", async () => {
    const { url, close } = await startServer({
      DEX_TESTNET_ONBOARDING: "1",
      DEX_TESTNET_PARTY_DAILY_CAP: "99",
      DEX_TESTNET_PARTY_IP_DAILY_CAP: "1",
    });
    try {
      assert.equal((await postJson(url, "/v1/testnet/party", {})).status, 201);
      const r = await postJson(url, "/v1/testnet/party", {});
      assert.equal(r.status, 429);
      assert.equal(
        (r.body as { details?: { scope?: string } }).details?.scope,
        "ip",
      );
    } finally {
      await close();
    }
  });

  it("does not spend a party allocation on a throttled request", async () => {
    const { url, close } = await startServer({
      DEX_TESTNET_ONBOARDING: "1",
      DEX_TESTNET_PARTY_DAILY_CAP: "1",
      DEX_TESTNET_PARTY_IP_DAILY_CAP: "99",
    });
    try {
      const first = (await postJson(url, "/v1/testnet/party", {}))
        .body as PartyResponse;
      assert.equal((await postJson(url, "/v1/testnet/party", {})).status, 429);
      // The rejected call must not have created a second hosted party.
      assert.equal(await hostedHere(url, first.partyId), true);
    } finally {
      await close();
    }
  });
});

describe("testnet onboarding: hosting lookup", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    ({ url, close } = await startServer({
      DEX_TESTNET_ONBOARDING: "1",
      DEX_TESTNET_PARTY_DAILY_CAP: "50",
      DEX_TESTNET_PARTY_IP_DAILY_CAP: "50",
    }));
  });
  after(async () => {
    await close();
  });

  it("reports a just-created party as hosted here", async () => {
    const created = (await postJson(url, "/v1/testnet/party", {}))
      .body as PartyResponse;
    assert.equal(await hostedHere(url, created.partyId), true);
  });

  it("reports an unknown party as not hosted here", async () => {
    assert.equal(
      await hostedHere(url, "someone-elses::1220deadbeefdeadbeef"),
      false,
    );
  });

  it("requires ?party=", async () => {
    const r = await getJson(url, "/v1/testnet/hosting");
    assert.equal(r.status, 400);
  });
});

async function hostedHere(url: string, party: string): Promise<boolean> {
  const r = await getJson(
    url,
    `/v1/testnet/hosting?party=${encodeURIComponent(party)}`,
  );
  assert.equal(r.status, 200);
  return (r.body as { hostedHere: boolean }).hostedHere;
}

// The participant path, with the transport stubbed (same approach as
// json-api-ledger.test.ts) so the admin calls and — above all — the rights
// payloads are pinned without a Canton participant.
describe("participant party provisioning", () => {
  const ALLOCATED = "dex-tester-abc::1220feed";
  const OPERATOR_USER = "ledger-api-user";

  function recordingProvisioner(operatorUserId?: string): {
    provisioner: JsonApiPartyProvisioner;
    calls: Array<{ url: string; method: string; body: unknown }>;
  } {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const payload = url.includes("/v2/parties")
        ? { partyDetails: { party: ALLOCATED, isLocal: true } }
        : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return {
      provisioner: new JsonApiPartyProvisioner({
        baseUrl: "http://participant:7575/",
        token: "tok",
        operatorUserId,
        fetchImpl,
      }),
      calls,
    };
  }

  it("allocates, creates a user, and grants rights on that party only", async () => {
    const { provisioner, calls } = recordingProvisioner();
    const party = await provisioner.provision("dex-tester-abc");
    assert.equal(party, ALLOCATED);

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "POST http://participant:7575/v2/parties",
        "POST http://participant:7575/v2/users",
        "POST http://participant:7575/v2/users/dex-tester-abc/rights",
      ],
    );

    assert.equal(
      (calls[0]!.body as { partyIdHint: string }).partyIdHint,
      "dex-tester-abc",
    );
    assert.equal(
      (calls[1]!.body as { user: { primaryParty: string } }).user.primaryParty,
      ALLOCATED,
    );

    // The security-critical assertion: exactly CanActAs + CanReadAs, both on
    // the party just allocated, and nothing else (no ParticipantAdmin, no
    // rights over the operator/admin parties).
    assert.deepEqual((calls[2]!.body as { rights: unknown[] }).rights, [
      { kind: { CanActAs: { value: { party: ALLOCATED } } } },
      { kind: { CanReadAs: { value: { party: ALLOCATED } } } },
    ]);
  });

  it("grants the operator's user CanActAs on the new party and nothing else", async () => {
    const { provisioner, calls } = recordingProvisioner(OPERATOR_USER);
    await provisioner.provision("dex-tester-abc");

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        "POST http://participant:7575/v2/parties",
        "POST http://participant:7575/v2/users",
        "POST http://participant:7575/v2/users/dex-tester-abc/rights",
        `POST http://participant:7575/v2/users/${OPERATOR_USER}/rights`,
      ],
    );

    // The airdrop mint is `actAs: [admin, party]`, so the backend's own user
    // needs CanActAs on the tester's party. The security-critical half: it is
    // CanActAs on the party this call just allocated, alone -- no read right,
    // and never a right over a party the faucet did not create.
    assert.deepEqual((calls[3]!.body as { rights: unknown[] }).rights, [
      { kind: { CanActAs: { value: { party: ALLOCATED } } } },
    ]);
    assert.equal((calls[3]!.body as { userId: string }).userId, OPERATOR_USER);
  });

  it("skips the operator grant when no operator user is configured", async () => {
    const { provisioner, calls } = recordingProvisioner();
    await provisioner.provision("dex-tester-abc");
    assert.equal(calls.length, 3);
  });

  it("reports hosting from the participant's isLocal flag", async () => {
    const details = (isLocal: boolean) =>
      (async () =>
        new Response(
          JSON.stringify({ partyDetails: [{ party: ALLOCATED, isLocal }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

    const local = new JsonApiPartyProvisioner({
      baseUrl: "http://participant:7575",
      token: "tok",
      fetchImpl: details(true),
    });
    assert.equal(await local.isHostedHere(ALLOCATED), true);

    const remote = new JsonApiPartyProvisioner({
      baseUrl: "http://participant:7575",
      token: "tok",
      fetchImpl: details(false),
    });
    assert.equal(await remote.isHostedHere(ALLOCATED), false);
  });

  it("treats an unknown party as not hosted here", async () => {
    const provisioner = new JsonApiPartyProvisioner({
      baseUrl: "http://participant:7575",
      token: "tok",
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    assert.equal(await provisioner.isHostedHere("nobody::1220ff"), false);
  });
});

describe("airdrop spec parsing", () => {
  it("defaults to dUSD:10000 at Daml decimal scale", () => {
    assert.deepEqual(parseAirdropSpec(undefined), [
      { instrumentId: "dUSD", amount: "10000.0000000000" },
    ]);
    assert.deepEqual(parseAirdropSpec("  "), [
      { instrumentId: "dUSD", amount: "10000.0000000000" },
    ]);
  });

  it("parses a comma-separated list", () => {
    assert.deepEqual(parseAirdropSpec("dUSD:1000, BTC:0.5"), [
      { instrumentId: "dUSD", amount: "1000.0000000000" },
      { instrumentId: "BTC", amount: "0.5000000000" },
    ]);
  });

  it("drops malformed and non-positive entries", () => {
    assert.deepEqual(parseAirdropSpec("dUSD, :5, BTC:abc, ETH:0, dUSD:1"), [
      { instrumentId: "dUSD", amount: "1.0000000000" },
    ]);
  });

  it("clamps an amount above the ceiling", () => {
    assert.deepEqual(parseAirdropSpec("dUSD:99999999999"), [
      { instrumentId: "dUSD", amount: "1000000.0000000000" },
    ]);
  });
});
