// POST /v1/testnet/rfq and POST /v1/testnet/rfq/accept: the public,
// unauthenticated endpoints that compose and settle an RFQ for a party this
// deployment's faucet minted.
//
// An RFQ touches more authorities than any other flow here -- the trader's Rfq,
// a dealer-signed quote per dealer, the joint accept, the operator's
// request-allocations, each counterparty's own allocation, and the operator's
// settle -- and the whole point of these two routes is that almost none of that
// is the caller's to choose. So the assertions are made on what the OPERATOR
// submitted and what the PARTICIPANT received at each step: the pair text, the
// dealer set, the tiers, the quoted prices, the rfqId, the funding holdings and
// the settle's inputs are all checked to be the server's own.
//
// What this file CANNOT prove is that the wire shapes decode: the stub
// participant accepts any JSON. That gap is why
// trading-tests/CantonDex/Tests/RfqSettlementTests.daml exists, and why the
// flow is additionally run against the live deployment by
// scripts/testnet-rfq-roundtrip.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperatorBackend } from "../src/index.js";
import { startHttpServer } from "../src/http/index.js";
import { DealersService } from "../src/dealers/index.js";
import { openDb, type Db } from "../src/indexer/db.js";
import { testnetOnboardingFromEnv } from "../src/testnet-onboarding/index.js";
import { REGISTRY_HOLDING_TEMPLATE_ID } from "../src/testnet-onboarding/registry-mint.js";
import { DEX_PAIR_TEMPLATE_ID } from "../src/testnet-onboarding/order.js";
import {
  RFQ_QUOTE_TEMPLATE_ID,
  TRADE_ALLOCATION_REQUEST_TEMPLATE_ID,
} from "../src/testnet-onboarding/rfq.js";
import type {
  CreatedEventRef,
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
/** Another tester: their RFQs are not the first one's to accept. */
const OTHER_TESTER = "dex-tester-5b2e77::1220bb02";
/** The demo dealers, also faucet-shaped so they can author their own side. */
const TRUSTED = "dex-tester-dealer-northwind::1220cc01";
const WHITELISTED = "dex-tester-dealer-harbourline::1220cc02";
/** Registered but switched off: it must never be asked to quote. */
const BENCHED = "dex-tester-dealer-benched::1220cc03";

const LEDGER_URL = "http://participant:7575";
const UPDATE_ID = "1220update0001";
const RFQ_CID = "00rfq:0";
const TRADE_CID = "00trade:0";
const QUOTE_CID_PREFIX = "00quote:";
const ALLOCATION_CID = "00alloc:0";
const FACTORY_CID = "00factory:0";
const POOL_CID = "00pool:0";
const BASE = "dBTC";
const QUOTE = "dUSD";

/**
 * Pool reserves of 100000 dUSD over 1000 dBTC: a mid of exactly 100. Chosen so
 * every quoted price below is exact at the 10dp scale and a spread in bps is
 * readable by eye.
 */
const MID = 100;

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
      // Deliberately the same contract the choice context returns: the RFQ
      // flow must dedupe, or the participant rejects the relayed submission.
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

/** Both counterparties stocked on both sides, plus decoys. */
const DEFAULT_HOLDINGS: StubHolding[] = [
  { contractId: "00t-usd:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "10000.0000000000" },
  { contractId: "00t-btc:0", admin: ADMIN, owner: HOSTED, instrumentId: BASE, amount: "1.0000000000" },
  { contractId: "00d-btc:0", admin: ADMIN, owner: TRUSTED, instrumentId: BASE, amount: "5.0000000000" },
  { contractId: "00d-usd:0", admin: ADMIN, owner: TRUSTED, instrumentId: QUOTE, amount: "500000.0000000000" },
  // Never selectable: locked, or somebody else's.
  { contractId: "00t-locked:0", admin: ADMIN, owner: HOSTED, instrumentId: QUOTE, amount: "999999.0000000000", locked: true },
  { contractId: "00foreign:0", admin: ADMIN, owner: OTHER_TESTER, instrumentId: BASE, amount: "500.0000000000" },
];

interface StubRfq {
  contractId: string;
  trader: string;
  rfqId: string;
  side: "RFQ_Buy" | "RFQ_Sell";
}

interface StubQuote {
  contractId: string;
  dealer: string;
  rfqId: string;
  price: string;
  tier: "TierTrusted" | "TierWhitelist";
  /** Millis from now. Negative = already lapsed when the accept runs. */
  expiresInMs: number;
}

/**
 * Serves the pair listing, the pool, the holdings and the RFQ book, and records
 * every operator submission so a test can pin exactly what each step ran with.
 */
class RfqLedger implements LedgerSubmitter {
  readonly submits: SubmitRequest[] = [];
  private quoteSeq = 0;

  constructor(
    readonly holdings: StubHolding[] = DEFAULT_HOLDINGS,
    readonly rfqs: StubRfq[] = [],
    readonly quotes: StubQuote[] = [],
  ) {}

  async submit<R>(req: SubmitRequest): Promise<R> {
    return (await this.submitWithUpdateId<R>(req)).result;
  }

  async submitWithUpdateId<R>(req: SubmitRequest): Promise<SubmitReceipt<R>> {
    this.submits.push(req);
    const cmd = req.command;
    if (cmd.kind === "create") {
      if (cmd.templateId === RFQ_QUOTE_TEMPLATE_ID) {
        return {
          result: `${QUOTE_CID_PREFIX}${this.quoteSeq++}` as R,
          updateId: "1220quote0001",
        };
      }
      return { result: RFQ_CID as R, updateId: "1220create0001" };
    }
    if (cmd.kind === "exercise") {
      switch (cmd.choice) {
        case "Rfq_Accept":
          return {
            result: {
              tradeCid: TRADE_CID,
              // The receipt the ledger computed; the service returns it
              // verbatim, so a test can tell it apart from the one the
              // operator built locally.
              receipt: {
                policyVersion: "v2.0",
                policyHash: "sha256:rfq-policy-v2.0",
                rfqId: "rfq-from-ledger",
                rankedDealers: [],
                acceptedDealer: TRUSTED,
                acceptedRank: 1,
                consideredCount: 2,
                signedBy: OPERATOR,
                signedAt: "2026-01-01T00:00:00.000Z",
                signature: "0xledger",
              },
            } as R,
            updateId: "1220accept0001",
          };
        case "MatchedTrade_RequestAllocations":
          return { result: ["00areq:0", "00areq:1"] as R, updateId: "1220req0001" };
        case "MatchedTrade_Settle":
          return { result: {} as R, updateId: "1220settle0001" };
        case "Rfq_Cancel":
          return { result: {} as R, updateId: "1220cancel0001" };
      }
    }
    return { result: "#result:0" as R, updateId: null };
  }

  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {
    // no streaming in this stub
  }

  async treeCreatedEvents(): Promise<CreatedEventRef[]> {
    return [
      { contractId: ALLOCATION_CID, templateId: "cafe:CantonDex.Registry.V2:Allocation" },
    ];
  }

  async query<T>(filter: SubscriptionFilter): Promise<T[]> {
    switch (filter.templateId) {
      case DEX_PAIR_TEMPLATE_ID:
        return [{
          contractId: "00pair:0", operator: OPERATOR, admin: ADMIN,
          baseInstrumentId: BASE, quoteInstrumentId: QUOTE,
          tradingMode: "TM_Both", active: true,
        } as unknown as T];
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
            quoteAmount: `${MID * 1000}.0000000000`,
          },
          totalLpSupply: "10000.0000000000", publicReaders: [],
        } as unknown as T];
      case "CantonDex.Dex.PoolRules:PoolRules":
        return [{ contractId: "00rules:0", operator: OPERATOR } as unknown as T];
      case "CantonDex.Dex.Rfq:Rfq":
        return this.rfqs.map((r) => ({
          ...r, operator: OPERATOR, pair: `${BASE}/${QUOTE}`,
          size: "0.0100000000",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          whitelist: [TRUSTED, WHITELISTED],
          createdAt: new Date().toISOString(),
        })) as unknown as T[];
      case RFQ_QUOTE_TEMPLATE_ID:
        return this.quotes.map((q) => ({
          contractId: q.contractId, dealer: q.dealer, trader: HOSTED,
          operator: OPERATOR, rfqId: q.rfqId, price: q.price, tier: q.tier,
          expiresAt: new Date(Date.now() + q.expiresInMs).toISOString(),
          postedAt: new Date(Date.now() - 60_000).toISOString(),
        })) as unknown as T[];
      case TRADE_ALLOCATION_REQUEST_TEMPLATE_ID:
        // One per counterparty, exactly as MatchedTrade_RequestAllocations
        // splits the legs. Each carries BOTH legs, one-sided per authorizer.
        return [
          tradeRequest("00areq:0", HOSTED),
          tradeRequest("00areq:1", TRUSTED),
        ] as unknown as T[];
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

  /** Create submissions of one template, in order. */
  creates(templateId: string): SubmitRequest[] {
    return this.submits.filter(
      (s) => s.command.kind === "create" && s.command.templateId === templateId,
    );
  }

  /** The choice argument of the single submission of `name`. */
  argument(name: string): Record<string, unknown> {
    const [found, ...rest] = this.choice(name);
    assert.ok(found, `expected one ${name} submission`);
    assert.equal(rest.length, 0, `expected exactly one ${name} submission`);
    return (found.command as { argument: Record<string, unknown> }).argument;
  }

  /** The create argument of the nth create of `templateId`. */
  createArgument(templateId: string, n: number): Record<string, unknown> {
    const found = this.creates(templateId)[n];
    assert.ok(found, `expected a create #${n} of ${templateId}`);
    return (found.command as { argument: Record<string, unknown> }).argument;
  }
}

const basicAccount = (owner: string) => ({ owner, provider: null, id: "" });

/** An RFQ_Buy trade: the dealer sends base, the trader sends quote. */
function tradeRequest(contractId: string, authorizer: string) {
  return {
    contractId,
    authorizer: basicAccount(authorizer),
    admin: ADMIN,
    settlement: {
      executors: [OPERATOR], id: "MatchedTrade", cid: TRADE_CID,
      meta: { values: {} },
    },
    settlementDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    transferLegs: [
      {
        transferLegId: "base-leg", sender: basicAccount(TRUSTED),
        receiver: basicAccount(HOSTED), amount: "0.0100000000",
        instrumentId: BASE, meta: { values: {} },
      },
      {
        transferLegId: "quote-leg", sender: basicAccount(HOSTED),
        receiver: basicAccount(TRUSTED), amount: "1.0000000000",
        instrumentId: QUOTE, meta: { values: {} },
      },
    ],
  };
}

interface ParticipantCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

/** Stand-in participant: party lookup, submit-and-wait, transaction tree. */
function participantStub(hosted: string[]): {
  fetchImpl: typeof fetch;
  submissions: () => Record<string, unknown>[];
} {
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
                  nodeId: 0, contractId: ALLOCATION_CID,
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
  ledger: RfqLedger;
  submissions: () => Record<string, unknown>[];
}

interface ServerOpts {
  hosted?: string[];
  holdings?: StubHolding[];
  rfqs?: StubRfq[];
  quotes?: StubQuote[];
  /** Rows to seed the dealer table with. Default: trusted + whitelisted. */
  dealers?: Array<{ party: string; name: string; trusted: boolean; whitelisted: boolean }>;
  /** false = no participant behind this deployment (the dev server). */
  participant?: boolean;
}

const DEFAULT_DEALERS = [
  { party: WHITELISTED, name: "Harbourline Capital", trusted: false, whitelisted: true },
  { party: TRUSTED, name: "Northwind Markets", trusted: true, whitelisted: true },
  { party: BENCHED, name: "Benched Partners", trusted: false, whitelisted: false },
];

const openDbs: Db[] = [];

async function startServer(
  env: Record<string, string | undefined>,
  opts: ServerOpts = {},
): Promise<StartedServer> {
  const ledger = new RfqLedger(
    opts.holdings ?? DEFAULT_HOLDINGS,
    opts.rfqs ?? [],
    opts.quotes ?? [],
  );
  const { fetchImpl, submissions } = participantStub(
    opts.hosted ?? [HOSTED, TRUSTED, WHITELISTED],
  );

  const db = openDb(join(mkdtempSync(join(tmpdir(), "dex-rfq-")), "test.db"));
  openDbs.push(db);
  const dealers = new DealersService(db);
  for (const d of opts.dealers ?? DEFAULT_DEALERS) dealers.upsert(d);

  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Declared out here so the env restore below stays synchronous with the call
  // that read it; the listen is awaited after the swap is undone.
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
      db,
      context: {
        operator: OPERATOR as never,
        lpRegistrar: LP_REGISTRAR as never,
        admin: ADMIN as never,
        allocationFactoryCid: FACTORY_CID,
        settlementFactoryCid: "00settle:0",
        allocationFactoryExtraArgs: {
          context: { values: {} }, meta: { values: {} },
        },
        allocationFactoryDisclosure: [],
        network: "canton:test",
      },
      testnetOnboarding: testnetOnboardingFromEnv({
        ledger,
        admin: ADMIN as never,
        pool: backend.pool,
        rfq: {
          service: backend.rfq,
          matchedTrade: backend.matchedTrade,
          dealers,
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

function rfqBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    party: HOSTED,
    pair: `${BASE}/${QUOTE}`,
    side: "RFQ_Buy",
    size: "0.0100000000",
    ...extra,
  };
}

async function withServer(
  env: Record<string, string | undefined>,
  opts: ServerOpts,
  run: (s: StartedServer) => Promise<void>,
): Promise<void> {
  const server = await startServer(env, opts);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

describe("POST /v1/testnet/rfq", () => {
  it("composes the request and one quote per WHITELISTED dealer", async () => {
    await withServer(ON, {}, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody());
      assert.equal(res.status, 200);

      // Exactly the two whitelisted dealers quoted. The benched one is in the
      // table and must never be asked -- the whitelist is a switch, not a list
      // of everyone the operator has ever heard of.
      const quotes = res.body.quotes as Array<{ dealer: string }>;
      assert.deepEqual(
        quotes.map((q) => q.dealer).sort(),
        [WHITELISTED, TRUSTED].sort(),
      );

      // Each quote is signed by ITS OWN dealer, not the operator: RfqQuote is
      // `signatory dealer`, and a quote the operator authored under its own
      // party would not be a dealer's quote at all.
      const creates = s.ledger.creates(RFQ_QUOTE_TEMPLATE_ID);
      assert.equal(creates.length, 2);
      for (const c of creates) {
        const arg = (c.command as { argument: Record<string, unknown> }).argument;
        assert.deepEqual(c.actAs, [arg.dealer]);
      }
    });
  });

  it("takes the whitelist from its own table, never the body", async () => {
    await withServer(ON, {}, async (s) => {
      const res = await postJson(
        s.url,
        "/v1/testnet/rfq",
        // A caller naming the benched dealer, an unknown party, and itself.
        rfqBody({ whitelist: [BENCHED, OTHER_TESTER, HOSTED] }),
      );
      assert.equal(res.status, 200);
      const arg = s.ledger.createArgument("CantonDex.Dex.Rfq:Rfq", 0);
      assert.deepEqual((arg.whitelist as string[]).sort(), [WHITELISTED, TRUSTED].sort());
    });
  });

  it("builds the pair text from its own listing, never the body", async () => {
    await withServer(ON, {}, async (s) => {
      // Rfq_Accept splits this text literally into leg instrument ids, so a
      // caller that could write it would mint legs naming instruments with no
      // registry config -- a trade that can never be allocated.
      const res = await postJson(
        s.url,
        "/v1/testnet/rfq",
        rfqBody({ poolCid: POOL_CID, pair: "BTC/USDC" }),
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.pair, `${BASE}/${QUOTE}`);
      const arg = s.ledger.createArgument("CantonDex.Dex.Rfq:Rfq", 0);
      assert.equal(arg.pair, `${BASE}/${QUOTE}`);
    });
  });

  it("refuses a pair this deployment does not trade", async () => {
    await withServer(ON, {}, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody({ pair: "BTC/USDC" }));
      assert.equal(res.status, 400);
    });
  });

  it("prices every quote off its own mid, tighter for a trusted dealer", async () => {
    await withServer(ON, {}, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody());
      const quotes = res.body.quotes as Array<{
        dealer: string; price: string; tier: string;
      }>;
      const trusted = quotes.find((q) => q.dealer === TRUSTED)!;
      const other = quotes.find((q) => q.dealer === WHITELISTED)!;

      assert.equal(trusted.tier, "TierTrusted");
      assert.equal(other.tier, "TierWhitelist");

      // On a buy the trader pays, so both quotes sit ABOVE mid -- the spread is
      // against the trader, as it would be from a real market maker -- and the
      // trusted dealer's is the nearer of the two.
      assert.ok(parseFloat(trusted.price) > MID);
      assert.ok(parseFloat(other.price) > MID);
      assert.ok(parseFloat(trusted.price) < parseFloat(other.price));
    });
  });

  it("puts the spread the other way on a sell", async () => {
    await withServer(ON, {}, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody({ side: "RFQ_Sell" }));
      const quotes = res.body.quotes as Array<{ dealer: string; price: string }>;
      const trusted = quotes.find((q) => q.dealer === TRUSTED)!;
      const other = quotes.find((q) => q.dealer === WHITELISTED)!;
      // The trader receives, so both sit BELOW mid and trusted is the higher.
      assert.ok(parseFloat(trusted.price) < MID);
      assert.ok(parseFloat(other.price) < MID);
      assert.ok(parseFloat(trusted.price) > parseFloat(other.price));
    });
  });

  it("generates the rfqId itself and ignores one in the body", async () => {
    await withServer(ON, {}, async (s) => {
      // The rfqId becomes the commandId of the create AND the accept, which is
      // an idempotency key on the participant: a caller-chosen one would let
      // two callers collide, or one replay another's.
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody({ rfqId: "attacker-chosen" }));
      assert.equal(res.status, 200);
      assert.notEqual(res.body.rfqId, "attacker-chosen");
      const arg = s.ledger.createArgument("CantonDex.Dex.Rfq:Rfq", 0);
      assert.notEqual(arg.rfqId, "attacker-chosen");
      assert.equal(arg.trader, HOSTED);
    });
  });

  it("gives every quote the RFQ's own expiry, clamped to the floor", async () => {
    await withServer(ON, {}, async (s) => {
      // Below MIN_RFQ_MINUTES. Rfq_Accept copies the RFQ's expiry onto the
      // MatchedTrade's settlementDeadline and Allocation_Settle aborts once it
      // passes, so an unclamped 1-minute RFQ fails INSIDE the settle.
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody({ expiryMinutes: 1 }));
      assert.equal(res.status, 200);
      const expiresAt = res.body.expiresAt as string;
      assert.ok(Date.parse(expiresAt) - Date.now() > 4 * 60_000);

      const rfq = s.ledger.createArgument("CantonDex.Dex.Rfq:Rfq", 0);
      assert.equal(rfq.expiresAt, expiresAt);
      for (let i = 0; i < 2; i++) {
        const q = s.ledger.createArgument(RFQ_QUOTE_TEMPLATE_ID, i);
        assert.equal(q.expiresAt, expiresAt);
      }
    });
  });

  it("refuses a party the faucet did not mint, before any query", async () => {
    await withServer(ON, {}, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody({ party: OPERATOR }));
      assert.equal(res.status, 403);
      assert.equal(s.ledger.submits.length, 0);
    });
  });

  it("refuses a party this participant does not host", async () => {
    // The hint on a party id is only a claim; a party that merely LOOKS like a
    // faucet party but lives on another participant is not ours to act for.
    await withServer(ON, { hosted: [] }, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody());
      assert.equal(res.status, 403);
    });
  });

  it("refuses a non-positive or malformed size", async () => {
    await withServer(ON, {}, async (s) => {
      for (const size of ["0.0000000000", "-1.0000000000", "abc", "1e5"]) {
        const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody({ size }));
        assert.equal(res.status, 400, `size ${size} must be refused`);
      }
      assert.equal(s.ledger.submits.length, 0);
    });
  });

  it("reports itself unavailable with no dealers registered", async () => {
    await withServer(ON, { dealers: [] }, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody());
      assert.equal(res.status, 400);
      // Nothing was created: an RFQ nobody can quote is not worth an Rfq.
      assert.equal(s.ledger.creates("CantonDex.Dex.Rfq:Rfq").length, 0);
    });
  });

  it("does not exist without the faucet flag", async () => {
    await withServer({ DEX_TESTNET_ONBOARDING: undefined }, {}, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody());
      assert.equal(res.status, 404);
    });
  });

  it("reports 501 on a deployment with no participant", async () => {
    await withServer(ON, { participant: false }, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq", rfqBody());
      assert.equal(res.status, 501);
    });
  });
});

const LIVE_QUOTES: StubQuote[] = [
  { contractId: `${QUOTE_CID_PREFIX}0`, dealer: TRUSTED, rfqId: "rfq-1", price: "100.0500000000", tier: "TierTrusted", expiresInMs: 3_600_000 },
  { contractId: `${QUOTE_CID_PREFIX}1`, dealer: WHITELISTED, rfqId: "rfq-1", price: "100.1500000000", tier: "TierWhitelist", expiresInMs: 3_600_000 },
];

const OWN_RFQ: StubRfq[] = [
  { contractId: RFQ_CID, trader: HOSTED, rfqId: "rfq-1", side: "RFQ_Buy" },
];

function acceptBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    party: HOSTED,
    rfqCid: RFQ_CID,
    acceptedQuoteCid: `${QUOTE_CID_PREFIX}0`,
    ...extra,
  };
}

describe("POST /v1/testnet/rfq/accept", () => {
  const ACCEPTABLE: ServerOpts = { rfqs: OWN_RFQ, quotes: LIVE_QUOTES };

  it("accepts, allocates for both counterparties, and settles", async () => {
    await withServer(ON, ACCEPTABLE, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq/accept", acceptBody());
      assert.equal(res.status, 200);
      assert.equal(res.body.tradeCid, TRADE_CID);

      // The receipt is the LEDGER's, returned verbatim -- it is what a trader
      // audits the ranking against, and the trade carrying it is archived by
      // the settle in this same request.
      const receipt = res.body.receipt as Record<string, unknown>;
      assert.equal(receipt.signature, "0xledger");
      assert.equal(res.body.acceptedRank, 1);

      // One relayed allocation per counterparty, each acting as ITSELF.
      const relayed = s.submissions();
      assert.equal(relayed.length, 2);
      assert.deepEqual(
        relayed.map((r) => (r.actAs as string[])[0]).sort(),
        [HOSTED, TRUSTED].sort(),
      );
      for (const r of relayed) {
        const cmds = r.commands as Array<{ ExerciseCommand: { choice: string } }>;
        assert.equal(cmds.length, 1);
        // Never AllocationRequest_Accept: it archives the request, and the
        // settle fetches and archives them itself.
        assert.equal(cmds[0]!.ExerciseCommand.choice, "AllocationFactory_Allocate");
      }
    });
  });

  it("funds each side from that side's OWN unlocked holdings", async () => {
    await withServer(ON, ACCEPTABLE, async (s) => {
      await postJson(s.url, "/v1/testnet/rfq/accept", acceptBody());
      const byParty = new Map(
        s.submissions().map((r) => [
          (r.actAs as string[])[0]!,
          (r.commands as Array<{
            ExerciseCommand: { choiceArgument: { inputHoldingCids: string[] } };
          }>)[0]!.ExerciseCommand.choiceArgument.inputHoldingCids,
        ]),
      );
      // The trader sends the QUOTE leg, the dealer the BASE leg -- each from a
      // holding it owns. The locked one and the other tester's are never
      // reachable: a caller-supplied cid would let them fund with someone
      // else's balance, and there is no way to supply one.
      assert.deepEqual(byParty.get(HOSTED), ["00t-usd:0"]);
      assert.deepEqual(byParty.get(TRUSTED), ["00d-btc:0"]);
    });
  });

  it("binds the settle to the allocations the relay produced", async () => {
    await withServer(ON, ACCEPTABLE, async (s) => {
      await postJson(s.url, "/v1/testnet/rfq/accept", acceptBody());
      const settle = s.ledger.argument("MatchedTrade_Settle");

      // batchesByAdmin is a Daml GenMap: an ARRAY of [key, value] pairs, of a
      // plain SettlementBatchV2 record. An object here encodes a TextMap, which
      // this is not -- the shape that had never once decoded on a participant.
      const batches = settle.batchesByAdmin as Array<[string, Record<string, unknown>]>;
      assert.equal(batches.length, 1);
      assert.equal(batches[0]![0], ADMIN);
      const allocations = batches[0]![1].allocations as Array<{ allocationCid: string }>;
      assert.deepEqual(allocations.map((a) => a.allocationCid), [
        ALLOCATION_CID,
        ALLOCATION_CID,
      ]);
      assert.equal("tag" in batches[0]![1], false);
      assert.equal(settle.dexPairCid, null);

      // The requests are archived by the settle rather than orphaned: nothing
      // here answered via AllocationRequest_Accept, so they are still active.
      assert.deepEqual(settle.allocationRequests, ["00areq:0", "00areq:1"]);
    });
  });

  it("reads the settle as the instrument admin", async () => {
    await withServer(ON, ACCEPTABLE, async (s) => {
      await postJson(s.url, "/v1/testnet/rfq/accept", acceptBody());
      const [settle] = s.ledger.choice("MatchedTrade_Settle");
      // A registry Holding is `signatory admin, owner`, so the operator is not
      // a stakeholder of the locked holdings the settle fetches and archives.
      assert.deepEqual(settle!.readAs, [ADMIN]);
      assert.deepEqual(settle!.actAs, [OPERATOR]);
    });
  });

  it("refuses an RFQ composed by another party", async () => {
    await withServer(
      ON,
      {
        rfqs: [{ contractId: RFQ_CID, trader: OTHER_TESTER, rfqId: "rfq-1", side: "RFQ_Buy" }],
        quotes: LIVE_QUOTES,
      },
      async (s) => {
        // The load-bearing check: Rfq_Accept is submitted as [trader, operator]
        // under a ledger user that can act as every party the faucet allocated,
        // so a cid taken on trust would let one tester accept another's RFQ.
        const res = await postJson(s.url, "/v1/testnet/rfq/accept", acceptBody());
        assert.equal(res.status, 403);
        assert.equal(s.ledger.choice("Rfq_Accept").length, 0);
      },
    );
  });

  it("refuses a quote that is not live on this RFQ", async () => {
    await withServer(ON, ACCEPTABLE, async (s) => {
      const res = await postJson(
        s.url,
        "/v1/testnet/rfq/accept",
        acceptBody({ acceptedQuoteCid: "00quote:99" }),
      );
      assert.equal(res.status, 400);
      assert.equal(s.ledger.choice("Rfq_Accept").length, 0);
    });
  });

  it("sends a considered set it filtered itself, dropping a lapsed quote", async () => {
    await withServer(
      ON,
      {
        rfqs: OWN_RFQ,
        quotes: [
          LIVE_QUOTES[0]!,
          { ...LIVE_QUOTES[1]!, expiresInMs: -60_000 },
          // Another RFQ's quote: it must not be dragged into this accept.
          { contractId: "00quote:9", dealer: TRUSTED, rfqId: "rfq-other", price: "1.0", tier: "TierTrusted", expiresInMs: 3_600_000 },
        ],
      },
      async (s) => {
        const res = await postJson(s.url, "/v1/testnet/rfq/accept", acceptBody());
        assert.equal(res.status, 200);
        // Rfq_Accept asserts every considered quote is still valid and is a
        // CONSUMING choice: one lapsed cid aborts it after the Rfq and every
        // quote have already been archived, with no unwind.
        const accept = s.ledger.argument("Rfq_Accept");
        assert.deepEqual(accept.consideredQuoteCids, [`${QUOTE_CID_PREFIX}0`]);
        assert.equal(accept.admin, ADMIN);
      },
    );
  });

  it("refuses a party the faucet did not mint, before any query", async () => {
    await withServer(ON, ACCEPTABLE, async (s) => {
      const res = await postJson(s.url, "/v1/testnet/rfq/accept", acceptBody({ party: OPERATOR }));
      assert.equal(res.status, 403);
      assert.equal(s.ledger.submits.length, 0);
    });
  });

  it("refuses a malformed contract id before anything is queried", async () => {
    await withServer(ON, ACCEPTABLE, async (s) => {
      for (const extra of [{ rfqCid: "not-a-cid" }, { acceptedQuoteCid: "" }]) {
        const res = await postJson(s.url, "/v1/testnet/rfq/accept", acceptBody(extra));
        assert.equal(res.status, 400);
      }
      assert.equal(s.ledger.submits.length, 0);
    });
  });

  it("carries no operator token on any of it", async () => {
    await withServer(ON, ACCEPTABLE, async (s) => {
      // Both routes are reachable with no Authorization header at all; that is
      // the whole reason they exist rather than the token-gated /v1/rfq pair.
      const composed = await postJson(s.url, "/v1/testnet/rfq", rfqBody());
      assert.equal(composed.status, 200);
      const accepted = await postJson(s.url, "/v1/testnet/rfq/accept", acceptBody());
      assert.equal(accepted.status, 200);
    });
  });
});

describe("GET /v1/rfq", () => {
  it("requires an owner and filters to what that party can see on-ledger", async () => {
    await withServer(
      ON,
      {
        rfqs: OWN_RFQ,
        quotes: LIVE_QUOTES,
      },
      async (s) => {
        // Unfiltered is the operator's own view and needs the admin token,
        // which this server has none of.
        const all = await fetch(`${s.url}/v1/rfq`);
        assert.equal(all.status, 400);

        const asTrader = await (await fetch(
          `${s.url}/v1/rfq?owner=${encodeURIComponent(HOSTED)}`,
        )).json() as { rfqs: unknown[]; quotes: unknown[] };
        assert.equal(asTrader.rfqs.length, 1);
        assert.equal(asTrader.quotes.length, 2);

        // A whitelisted dealer sees the request it was asked to quote and its
        // OWN quote -- never the competing dealer's price, which is the
        // property that makes a competitive RFQ worth running.
        const asDealer = await (await fetch(
          `${s.url}/v1/rfq?owner=${encodeURIComponent(TRUSTED)}`,
        )).json() as { rfqs: unknown[]; quotes: Array<{ dealer: string }> };
        assert.equal(asDealer.rfqs.length, 1);
        assert.deepEqual(asDealer.quotes.map((q) => q.dealer), [TRUSTED]);

        // A party on neither side sees nothing at all.
        const asStranger = await (await fetch(
          `${s.url}/v1/rfq?owner=${encodeURIComponent(OTHER_TESTER)}`,
        )).json() as { rfqs: unknown[]; quotes: unknown[] };
        assert.equal(asStranger.rfqs.length, 0);
        assert.equal(asStranger.quotes.length, 0);
      },
    );
  });
});
