// End-to-end test for the operator backend's RFQ accept flow.
// Drives the InMemoryLedger with handlers that mimic Daml choice
// semantics, then exercises RfqService.accept and asserts on the
// resulting MatchedTrade + PolicyReceipt.
//
// This is the "B6 worked example" deliverable.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InMemoryLedger,
  OperatorBackend,
  verifyReceipt,
  POLICY_VERSION,
} from "../src/index.ts";
import type {
  ContractId,
  Party,
  Rfq,
  RfqQuote,
  PolicyReceipt,
} from "../src/types.ts";
import { RfqAuthError } from "../src/rfq/index.ts";
import { RegistryClient } from "@canton-dex/registry-client";
import type { ChoiceContextRef } from "@canton-dex/registry-client";

class StubRegistry extends RegistryClient {
  constructor() {
    super({ baseUrl: "http://stub" });
  }
  override async getFactories(): Promise<{
    allocationFactoryCid: ContractId<"AllocationFactory">;
    settlementFactoryCid: ContractId<"SettlementFactory">;
    disclosure: never[];
  }> {
    return {
      allocationFactoryCid: "#alloc-fac:0" as ContractId<"AllocationFactory">,
      settlementFactoryCid: "#settle-fac:0" as ContractId<"SettlementFactory">,
      disclosure: [],
    };
  }
  override async getChoiceContext(): Promise<ChoiceContextRef> {
    return { context: { values: {} }, disclosure: [] };
  }
}

function setupLedger(): InMemoryLedger {
  const ledger = new InMemoryLedger();

  ledger.registerCreateHandler("CantonDex.Dex.Rfq:Rfq", (payload) => {
    const r = payload as Rfq;
    return { observers: [r.operator, ...r.whitelist] };
  });
  ledger.registerCreateHandler("CantonDex.Dex.Rfq:RfqQuote", (payload) => {
    const q = payload as RfqQuote;
    return { observers: [q.trader, q.operator] };
  });

  // Rfq_Accept handler: mimics the Daml choice body.
  ledger.registerChoice<{
    tradeCid: ContractId<"MatchedTrade">;
    receipt: PolicyReceipt;
  }>("CantonDex.Dex.Rfq:Rfq", "Rfq_Accept", (ctx) => {
    const rfq = ctx.self.payload as Rfq;
    const arg = ctx.arg as {
      acceptedQuoteCid: ContractId<"RfqQuote">;
      consideredQuoteCids: ContractId<"RfqQuote">[];
      admin: Party;
      currentTime: string;
      signature: string;
    };

    const considered: RfqQuote[] = [];
    for (const cid of arg.consideredQuoteCids) {
      const entry = ctx.acs.get(cid as string);
      if (!entry) throw new Error(`quote ${cid} not in ACS`);
      considered.push(entry.payload as RfqQuote);
    }
    const accepted = considered.find(
      (q) => q.contractId === arg.acceptedQuoteCid,
    );
    if (!accepted) throw new Error("accepted not in considered");
    if (accepted.rfqId !== rfq.rfqId) throw new Error("rfq id mismatch");

    ctx.archive(ctx.self.contractId);
    for (const cid of arg.consideredQuoteCids) {
      ctx.archive(cid as string);
    }

    const valid = considered.filter(
      (q) => Date.parse(q.expiresAt) > Date.parse(arg.currentTime),
    );
    const ranked = [...valid].sort((a, b) => {
      const tierA = a.tier === "TierTrusted" ? 0 : 1;
      const tierB = b.tier === "TierTrusted" ? 0 : 1;
      if (tierA !== tierB) return tierA - tierB;
      const pa = parseFloat(a.price);
      const pb = parseFloat(b.price);
      if (pa !== pb) return rfq.side === "RFQ_Buy" ? pa - pb : pb - pa;
      return Date.parse(a.postedAt) - Date.parse(b.postedAt);
    });
    const rankedDealers = ranked.map((q, i) => ({
      party: q.dealer,
      rank: i + 1,
      price: q.price,
      tier: q.tier === "TierTrusted" ? "trusted" : "whitelist",
    }));
    const acceptedRank =
      ranked.findIndex((q) => q.dealer === accepted.dealer) + 1;

    const receipt: PolicyReceipt = {
      policyVersion: POLICY_VERSION,
      policyHash: "sha256:rfq-policy-v1.4",
      rfqId: rfq.rfqId,
      rankedDealers,
      acceptedDealer: accepted.dealer,
      acceptedRank,
      consideredCount: ranked.length,
      signedBy: rfq.operator,
      signedAt: arg.currentTime,
      signature: arg.signature,
    };

    const tradeCid = ctx.create(
      "CantonDex.Dex.MatchedTrade:MatchedTrade",
      {
        contractId: "" as ContractId<"MatchedTrade">,
        venue: rfq.operator,
        admin: arg.admin,
        transferLegs: [],
        settlementDeadline: rfq.expiresAt,
        policyReceipt: receipt,
      },
      [rfq.operator, rfq.trader, accepted.dealer],
    ) as ContractId<"MatchedTrade">;

    return { tradeCid, receipt };
  });

  // Rfq_Cancel handler: archives the RFQ (trader-controlled choice).
  ledger.registerChoice<Record<string, never>>(
    "CantonDex.Dex.Rfq:Rfq",
    "Rfq_Cancel",
    (ctx) => {
      ctx.archive(ctx.self.contractId);
      return {};
    },
  );

  return ledger;
}

test("RFQ accept end-to-end through operator backend", async () => {
  const ledger = setupLedger();
  const registry = new StubRegistry();
  const operator: Party = "operator::test";
  const trader: Party = "alice::test";
  const orca: Party = "orca-mm::test";
  const jump: Party = "jump-tr::test";
  const galaxy: Party = "galaxy-otc::test";

  const backend = new OperatorBackend({
    ledger,
    registry,
    operatorParty: operator,
  });

  const now = "2026-05-06T12:00:00Z";
  const expiresIn30s = "2026-05-06T12:00:30Z";
  const expiresIn1h = "2026-05-06T13:00:00Z";

  const rfqCid = (await ledger.submit<ContractId<"Rfq">>({
    actAs: [trader],
    commandId: "seed-rfq",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.Rfq:Rfq",
      argument: {
        contractId: "" as ContractId<"Rfq">,
        trader,
        operator,
        rfqId: "rfq-001",
        pair: "BTC/USDC",
        side: "RFQ_Buy",
        size: "5.0",
        expiresAt: expiresIn1h,
        whitelist: [orca, jump, galaxy],
        createdAt: now,
      } satisfies Rfq,
    },
  })) as ContractId<"Rfq">;

  const seedQuote = async (q: {
    dealer: Party;
    price: string;
    postedAt: string;
    tier: "TierTrusted" | "TierWhitelist";
  }) =>
    ledger.submit<ContractId<"RfqQuote">>({
      actAs: [q.dealer],
      commandId: `quote-${q.dealer}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Dex.Rfq:RfqQuote",
        argument: {
          contractId: "" as ContractId<"RfqQuote">,
          dealer: q.dealer,
          trader,
          operator,
          rfqId: "rfq-001",
          price: q.price,
          expiresAt: expiresIn30s,
          postedAt: q.postedAt,
          tier: q.tier,
        } satisfies RfqQuote,
      },
    });

  const quoteOrca = await seedQuote({
    dealer: orca,
    price: "60530.00",
    postedAt: now,
    tier: "TierTrusted",
  });
  const quoteJump = await seedQuote({
    dealer: jump,
    price: "60510.00",
    postedAt: "2026-05-06T11:59:57Z",
    tier: "TierTrusted",
  });
  const quoteGalaxy = await seedQuote({
    dealer: galaxy,
    price: "60509.50",
    postedAt: "2026-05-06T12:00:08Z",
    tier: "TierWhitelist",
  });

  const result = await backend.rfq.accept({
    rfqCid,
    acceptedQuoteCid: quoteJump,
    consideredQuoteCids: [quoteOrca, quoteJump, quoteGalaxy],
    admin: "btc-admin::test",
    now,
  });

  assert.equal(result.receipt.acceptedDealer, jump, "Jump should be accepted");
  assert.equal(
    result.receipt.acceptedRank,
    1,
    "Jump ranks #1 (cheapest trusted)",
  );
  assert.equal(result.receipt.consideredCount, 3);
  assert.equal(result.receipt.policyVersion, POLICY_VERSION);

  const galaxyRank = result.receipt.rankedDealers.find(
    (d) => d.party === galaxy,
  )?.rank;
  assert.equal(
    galaxyRank,
    3,
    "Galaxy ranked #3 (whitelist tier behind trusted)",
  );

  assert.equal(verifyReceipt(result.receipt), true, "receipt verifies");
  assert.match(result.tradeCid as string, /^#\d+:0$/);
});

test("policy version is exported", () => {
  assert.equal(POLICY_VERSION, "v1.4");
});

test("RFQ list / create / cancel through operator backend", async () => {
  const ledger = setupLedger();
  // Rfq_Cancel handler: archives self.
  ledger.registerChoice<Record<string, never>>(
    "CantonDex.Dex.Rfq:Rfq",
    "Rfq_Cancel",
    (ctx) => {
      ctx.archive(ctx.self.contractId);
      return {};
    },
  );
  const registry = new StubRegistry();
  const operator: Party = "operator::test";
  const trader: Party = "alice::test";
  const orca: Party = "orca-mm::test";

  const backend = new OperatorBackend({
    ledger,
    registry,
    operatorParty: operator,
  });

  const now = "2026-05-06T12:00:00Z";
  const expiresIn1h = "2026-05-06T13:00:00Z";

  const created = await backend.rfq.create({
    trader,
    rfqId: "rfq-list-001",
    pair: "BTC/USDC",
    side: "RFQ_Buy",
    size: "1.0",
    expiresAt: expiresIn1h,
    whitelist: [orca],
    createdAt: now,
  });
  assert.ok(created.rfqCid, "create returns a cid");

  const listed = await backend.rfq.list();
  const found = listed.rfqs.find((r) => r.rfqId === "rfq-list-001");
  assert.ok(found, "created Rfq appears in list");
  assert.equal(found?.trader, trader);
  assert.equal(found?.operator, operator);

  await backend.rfq.cancel({ rfqCid: created.rfqCid });
  const after = await backend.rfq.list();
  assert.equal(
    after.rfqs.find((r) => r.rfqId === "rfq-list-001"),
    undefined,
    "cancelled Rfq is gone",
  );
});

test("sweepExpired archives expired RFQs under operator authority only", async () => {
  const ledger = setupLedger();
  // Rfq_Expire handler: mimics the Daml choice — controller operator,
  // asserts the deadline has passed, archives self.
  ledger.registerChoice<Record<string, never>>(
    "CantonDex.Dex.Rfq:Rfq",
    "Rfq_Expire",
    (ctx) => {
      const rfq = ctx.self.payload as Rfq;
      const arg = ctx.arg as { currentTime: string };
      if (!ctx.actAs.has(rfq.operator)) {
        throw new Error("Rfq_Expire requires operator authority");
      }
      if (ctx.actAs.has(rfq.trader)) {
        throw new Error(
          "sweep must not rely on trader authority (external wallets)",
        );
      }
      if (Date.parse(arg.currentTime) < Date.parse(rfq.expiresAt)) {
        throw new Error("RFQ has not expired yet");
      }
      ctx.archive(ctx.self.contractId);
      return {};
    },
  );
  const registry = new StubRegistry();
  const operator: Party = "operator::test";
  const trader: Party = "alice::test";
  const orca: Party = "orca-mm::test";

  const backend = new OperatorBackend({
    ledger,
    registry,
    operatorParty: operator,
  });

  const createdAt = "2026-05-06T10:00:00Z";
  const expired = await backend.rfq.create({
    trader,
    rfqId: "rfq-sweep-expired",
    pair: "BTC/USDC",
    side: "RFQ_Buy",
    size: "1.0",
    expiresAt: "2026-05-06T11:00:00Z",
    whitelist: [orca],
    createdAt,
  });
  const live = await backend.rfq.create({
    trader,
    rfqId: "rfq-sweep-live",
    pair: "BTC/USDC",
    side: "RFQ_Buy",
    size: "1.0",
    expiresAt: "2026-05-06T18:00:00Z",
    whitelist: [orca],
    createdAt,
  });
  assert.ok(expired.rfqCid && live.rfqCid);

  const swept = await backend.rfq.sweepExpired("2026-05-06T12:00:00Z");
  assert.deepEqual(swept, ["rfq-sweep-expired"], "only the expired RFQ swept");

  const after = await backend.rfq.list();
  assert.equal(
    after.rfqs.find((r) => r.rfqId === "rfq-sweep-expired"),
    undefined,
    "expired Rfq archived",
  );
  assert.ok(
    after.rfqs.find((r) => r.rfqId === "rfq-sweep-live"),
    "live Rfq untouched",
  );
});

// Per-caller binding (finding B-2, Low residual #1): cancel/accept act as the
// fetched RFQ's `trader`. When the handler passes a `requireTrader` (the
// verified caller party), the service must reject a mismatch so an operator-
// token holder cannot grief/cancel or accept on another trader's behalf.
test("cancel rejects a caller bound to a different party (B-2)", async () => {
  const ledger = setupLedger();
  const registry = new StubRegistry();
  const operator: Party = "operator::test";
  const trader: Party = "alice::test";
  const mallory: Party = "mallory::test";
  const backend = new OperatorBackend({ ledger, registry, operatorParty: operator });

  const created = await backend.rfq.create({
    trader,
    rfqId: "rfq-bind-cancel",
    pair: "BTC/USDC",
    side: "RFQ_Buy",
    size: "1.0",
    expiresAt: "2026-05-06T13:00:00Z",
    whitelist: ["orca::test"],
    createdAt: "2026-05-06T12:00:00Z",
  });

  // Wrong caller → rejected, RFQ still present.
  await assert.rejects(
    () => backend.rfq.cancel({ rfqCid: created.rfqCid, requireTrader: mallory }),
    RfqAuthError,
  );
  const still = await backend.rfq.list();
  assert.ok(still.rfqs.find((r) => r.rfqId === "rfq-bind-cancel"), "RFQ not cancelled by wrong caller");

  // Correct caller → cancels.
  await backend.rfq.cancel({ rfqCid: created.rfqCid, requireTrader: trader });
  const after = await backend.rfq.list();
  assert.equal(
    after.rfqs.find((r) => r.rfqId === "rfq-bind-cancel"),
    undefined,
    "RFQ cancelled by its own trader",
  );
});

test("accept rejects a caller bound to a different party (B-2)", async () => {
  const ledger = setupLedger();
  const registry = new StubRegistry();
  const operator: Party = "operator::test";
  const trader: Party = "alice::test";
  const mallory: Party = "mallory::test";
  const dealer: Party = "orca-mm::test";
  const backend = new OperatorBackend({ ledger, registry, operatorParty: operator });

  const now = "2026-05-06T12:00:00Z";
  const rfqCid = (await ledger.submit<ContractId<"Rfq">>({
    actAs: [trader],
    commandId: "seed-rfq-bind-accept",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.Rfq:Rfq",
      argument: {
        contractId: "" as ContractId<"Rfq">,
        trader,
        operator,
        rfqId: "rfq-bind-accept",
        pair: "BTC/USDC",
        side: "RFQ_Buy",
        size: "1.0",
        expiresAt: "2026-05-06T13:00:00Z",
        whitelist: [dealer],
        createdAt: now,
      } satisfies Rfq,
    },
  })) as ContractId<"Rfq">;

  const quote = (await ledger.submit<ContractId<"RfqQuote">>({
    actAs: [dealer],
    commandId: "quote-bind-accept",
    command: {
      kind: "create",
      templateId: "CantonDex.Dex.Rfq:RfqQuote",
      argument: {
        contractId: "" as ContractId<"RfqQuote">,
        dealer,
        trader,
        operator,
        rfqId: "rfq-bind-accept",
        price: "60000.00",
        expiresAt: "2026-05-06T12:30:00Z",
        postedAt: now,
        tier: "TierTrusted",
      } satisfies RfqQuote,
    },
  })) as ContractId<"RfqQuote">;

  // Wrong caller → rejected before any settlement.
  await assert.rejects(
    () =>
      backend.rfq.accept({
        rfqCid,
        acceptedQuoteCid: quote,
        consideredQuoteCids: [quote],
        admin: "btc-admin::test",
        now,
        requireTrader: mallory,
      }),
    RfqAuthError,
  );

  // Correct caller → accepts.
  const result = await backend.rfq.accept({
    rfqCid,
    acceptedQuoteCid: quote,
    consideredQuoteCids: [quote],
    admin: "btc-admin::test",
    now,
    requireTrader: trader,
  });
  assert.equal(result.receipt.acceptedDealer, dealer);
});
