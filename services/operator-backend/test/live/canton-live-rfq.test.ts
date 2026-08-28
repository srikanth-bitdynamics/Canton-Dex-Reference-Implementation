// Canton-backed RFQ service integration test.
//
// This drives the same RfqService code as `rfq.test.ts`, but through
// JsonApiLedger against an already-running Canton participant. It does not
// start the HTTP server, dApp, or a wallet, and it does not fund or settle the
// MatchedTrade. CANTON_LIVE_RFQ gates all live submissions.
//
// Prerequisites:
//   - the current canton-dex trading DAR and dependencies are uploaded;
//   - the five configured parties exist;
//   - the JWT has actAs rights for operator, trader, and both dealers.
//     CANTON_BTC_ADMIN is data on the resulting trade, not an authorizer here.
//
// Run from services/operator-backend:
//      $ CANTON_LIVE_RFQ=1 \
//        CANTON_JSON_API_URL=... CANTON_JSON_API_TOKEN=... \
//        CANTON_OPERATOR_PARTY=... CANTON_TRADER_PARTY=... \
//        CANTON_DEALER_JUMP=... CANTON_DEALER_ORCA=... \
//        CANTON_BTC_ADMIN=... npm run test:live:rfq
//
// What it verifies:
//   - real Rfq/RfqQuote creates and Rfq_Accept/cancel exercises;
//   - exact CIDs returned by RfqService.list;
//   - the choice result's receipt verifies and equals the PolicyReceipt stored
//     on the queried MatchedTrade.
//
// STATE WARNING: the accept case leaves one MatchedTrade. Use a throwaway
// LocalNet or dedicated test parties. The RFQ id printed by node:test identifies
// the run if manual cleanup is needed.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JsonApiLedger,
  OperatorBackend,
  POLICY_VERSION,
  verifyReceipt,
} from "../../src/index.ts";
import type {
  ContractId,
  Party,
  PolicyReceipt,
  Rfq,
  RfqQuote,
} from "../../src/types.ts";
import { FixedRegistryClient } from "@canton-dex/registry-client";

const liveEnabled = process.env.CANTON_LIVE_RFQ === "1";

// Skip the entire suite when not enabled. node:test supports per-test
// `skip` but we want a single skip message at suite level.
if (!liveEnabled) {
  test(
    "Canton live RFQ (skipped: set CANTON_LIVE_RFQ=1 to enable)",
    { skip: true },
    () => {},
  );
}

if (liveEnabled) {
  const baseUrl = required("CANTON_JSON_API_URL");
  const token = required("CANTON_JSON_API_TOKEN");
  const operator = required("CANTON_OPERATOR_PARTY") as Party;
  const trader = required("CANTON_TRADER_PARTY") as Party;
  const dealerJump = required("CANTON_DEALER_JUMP") as Party;
  const dealerOrca = required("CANTON_DEALER_ORCA") as Party;
  const btcAdmin = required("CANTON_BTC_ADMIN") as Party;
  const runId = `${Date.now()}-${process.pid}`;
  console.info(`[canton-rfq-live] run id: ${runId}`);

  interface MatchedTradeContract {
    contractId: ContractId<"MatchedTrade">;
    venue: Party;
    admin: Party;
    policyReceipt: PolicyReceipt | null;
  }

  const ledger = new JsonApiLedger({
    baseUrl,
    token,
    applicationId: "canton-dex-live-rfq",
  });

  // The integration test only needs the registry client for the
  // factories endpoint. For the RFQ flow we don't actually settle the
  // resulting MatchedTrade so the factories aren't read; a stub is
  // sufficient.
  // Inline-defined stub (avoid forward reference to a class declared
  // later in the file).
  const registry = new FixedRegistryClient(() => ({
    allocationFactoryCid:
      "stub-not-used-in-rfq" as ContractId<"AllocationFactory">,
    settlementFactoryCid:
      "stub-not-used-in-rfq" as ContractId<"SettlementFactory">,
    disclosure: [],
  }));

  const backend = new OperatorBackend({
    ledger,
    registry,
    operatorParty: operator,
  });

  test("Canton live RFQ: accept produces MatchedTrade with PolicyReceipt", async () => {
    const now = new Date().toISOString();
    const expiresIn1h = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const expiresIn15m = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const rfqId = `rfq-live-${runId}`;

    // 1. Trader creates the Rfq.
    const rfqCid = (await ledger.submit<ContractId<"Rfq">>({
      actAs: [trader],
      commandId: `seed-rfq-${rfqId}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Dex.Rfq:Rfq",
        argument: {
          trader,
          operator,
          rfqId,
          pair: "BTC/USDC",
          side: "RFQ_Buy",
          size: "5.0",
          expiresAt: expiresIn1h,
          whitelist: [dealerOrca, dealerJump],
          createdAt: now,
        },
      },
    })) as ContractId<"Rfq">;

    // 2. Two dealers post quotes.
    const quoteJump = await ledger.submit<ContractId<"RfqQuote">>({
      actAs: [dealerJump],
      commandId: `quote-jump-${rfqId}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Dex.Rfq:RfqQuote",
        argument: {
          dealer: dealerJump,
          trader,
          operator,
          rfqId,
          price: "60510.00",
          expiresAt: expiresIn15m,
          postedAt: now,
          tier: "TierTrusted",
        },
      },
    });
    const quoteOrca = await ledger.submit<ContractId<"RfqQuote">>({
      actAs: [dealerOrca],
      commandId: `quote-orca-${rfqId}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Dex.Rfq:RfqQuote",
        argument: {
          dealer: dealerOrca,
          trader,
          operator,
          rfqId,
          price: "60530.00",
          expiresAt: expiresIn15m,
          postedAt: now,
          tier: "TierTrusted",
        },
      },
    });

    // 3. Operator backend drives Rfq_Accept (joint trader+operator).
    const result = await backend.rfq.accept({
      rfqCid,
      acceptedQuoteCid: quoteJump,
      consideredQuoteCids: [quoteJump, quoteOrca],
      admin: btcAdmin,
      now,
    });

    assert.equal(
      result.receipt.acceptedDealer,
      dealerJump,
      "Jump should be accepted as the policy-ranked quote",
    );
    assert.equal(result.receipt.acceptedRank, 1);
    assert.equal(result.receipt.consideredCount, 2);
    assert.equal(result.receipt.policyVersion, POLICY_VERSION);
    assert.equal(verifyReceipt(result.receipt), true, "receipt verifies");
    assert.ok(typeof result.tradeCid === "string");
    assert.ok((result.tradeCid as string).length > 0);

    const trades = await ledger.query<MatchedTradeContract>({
      templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
      observingParty: operator,
    });
    const trade = trades.find((candidate) => candidate.contractId === result.tradeCid);
    assert.ok(trade, "Rfq_Accept result CID must identify a visible MatchedTrade");
    assert.equal(trade.venue, operator);
    assert.equal(trade.admin, btcAdmin);
    assert.deepEqual(
      trade.policyReceipt,
      result.receipt,
      "queried MatchedTrade must store the choice result's PolicyReceipt",
    );
  });

  test("Canton live RFQ: list returns the exact visible RFQ and quote CIDs", async () => {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rfqId = `rfq-list-${runId}`;
    const { rfqCid } = await backend.rfq.create({
      trader,
      rfqId,
      pair: "BTC/USDC",
      side: "RFQ_Buy",
      size: "2.0",
      expiresAt,
      whitelist: [dealerOrca],
      createdAt: now,
    });
    const quoteCid = await ledger.submit<ContractId<"RfqQuote">>({
      actAs: [dealerOrca],
      commandId: `quote-list-${runId}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Dex.Rfq:RfqQuote",
        argument: {
          dealer: dealerOrca,
          trader,
          operator,
          rfqId,
          price: "60520.00",
          expiresAt,
          postedAt: now,
          tier: "TierTrusted",
        },
      },
    });

    try {
      const list = await backend.rfq.list();
      assert.equal(
        list.rfqs.find((rfq) => rfq.contractId === rfqCid)?.rfqId,
        rfqId,
        "list must include the RFQ created by this case",
      );
      assert.equal(
        list.quotes.find((quote) => quote.contractId === quoteCid)?.rfqId,
        rfqId,
        "list must include the quote created by this case",
      );
    } finally {
      await Promise.all([
        backend.rfq.cancel({ rfqCid }),
        ledger.submit<void>({
          actAs: [dealerOrca],
          commandId: `withdraw-list-quote-${runId}`,
          command: {
            kind: "exercise",
            templateId: "CantonDex.Dex.Rfq:RfqQuote",
            contractId: quoteCid,
            choice: "RfqQuote_Withdraw",
            argument: {},
          },
        }),
      ]);
    }
  });

  test("Canton live RFQ: cancel archives an open Rfq", async () => {
    const now = new Date().toISOString();
    const expiresIn1h = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rfqId = `rfq-cancel-${runId}`;

    const rfqCid = (await ledger.submit<ContractId<"Rfq">>({
      actAs: [trader],
      commandId: `seed-cancel-${rfqId}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Dex.Rfq:Rfq",
        argument: {
          trader,
          operator,
          rfqId,
          pair: "BTC/USDC",
          side: "RFQ_Buy",
          size: "1.0",
          expiresAt: expiresIn1h,
          whitelist: [dealerOrca],
          createdAt: now,
        },
      },
    })) as ContractId<"Rfq">;

    const beforeCancel = await backend.rfq.list();
    assert.equal(
      beforeCancel.rfqs.find((rfq) => rfq.contractId === rfqCid)?.rfqId,
      rfqId,
      "created RFQ must be visible before cancellation",
    );

    await backend.rfq.cancel({ rfqCid });

    const after = await backend.rfq.list();
    const stillThere = after.rfqs.find(
      (r: Rfq) => r.contractId === rfqCid,
    );
    assert.equal(stillThere, undefined, "cancelled Rfq should be archived");
  });
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env: ${name}`);
  return v;
}
