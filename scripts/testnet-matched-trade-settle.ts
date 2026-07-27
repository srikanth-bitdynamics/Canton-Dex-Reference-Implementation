// Prove MatchedTrade_Settle against the live deployment.
//
// WHY THIS EXISTS. The matched-trade path is the one flow the DEX advertises
// that had never executed on a real participant, and it was carrying two
// unvalidated fixes:
//
//   - the settle payload. `batchesByAdmin` is a Daml GenMap (an ARRAY of
//     [key, value] pairs) of a plain SettlementBatchV2 RECORD, and the backend
//     was sending an OBJECT of the vendored upstream VARIANT shape with a
//     `tag`, `allocationCids` instead of `allocations`, and no `dexPairCid`.
//     The choice could never decode, so nothing past it had ever run.
//   - `readAs: [admin]` on the settle submission. A registry Holding is
//     `signatory admin, owner`, so the operator cannot see the counterparties'
//     locked holdings; the settle fetches and archives them.
//
// It drives `MatchedTradeService` DIRECTLY rather than the HTTP route, for two
// reasons: the operator write routes are token-gated and this deployment sets
// no token, and going through the service is what actually exercises the two
// fixes. Everything the counterparties do goes through the PUBLIC faucet and
// relay, exactly as a browser would.
//
// Read-only against everything except the two throwaway faucet parties it
// creates and the one trade it settles between them.
//
// Usage, on the deployment host:
//   set -a; . /etc/canton-dex/testnet.env; set +a
//   node --import tsx scripts/testnet-matched-trade-settle.ts

import { JsonApiLedger } from "../services/operator-backend/src/ledger/json-api.js";
import { FixedRegistry } from "../services/operator-backend/src/registry/fixed-registry.js";
import { MatchedTradeService } from "../services/operator-backend/src/matched-trade/index.js";
import { selectCoveringHoldings } from "../services/operator-backend/src/testnet-onboarding/swap.js";
import * as dec from "../services/operator-backend/src/pool/decimal.js";
import type { ContractId } from "@canton-dex/registry-client";
import type { Party } from "../services/operator-backend/src/types.js";

const API = process.env.DEX_API ?? "http://127.0.0.1:3400";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var ${name}`);
  return v;
}

const LEDGER_URL = required("CANTON_LEDGER_URL");
const LEDGER_TOKEN = required("CANTON_LEDGER_TOKEN");
const OPERATOR = required("CANTON_OPERATOR") as Party;
const ADMIN = required("CANTON_ADMIN") as Party;
const USER_ID = process.env.CANTON_USER_ID ?? "ledger-api-user";
const PKG = process.env.CANTON_DEX_PACKAGE_ID ?? "#canton-dex-trading";

// The two legs of the block trade. Small, and well inside the faucet airdrop.
const BASE = { instrumentId: "dBTC", amount: "0.0100000000" };
const QUOTE = { instrumentId: "dUSD", amount: "950.0000000000" };

const ok = (s: string) => console.log(`  ✓ ${s}`);
const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  process.stdout.write(`${label}\n`);
  try {
    const r = await run();
    ok(label);
    return r;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

const basicAccount = (owner: string) => ({
  owner,
  custodian: null,
  meta: { values: {} },
});

interface Leg {
  transferLegId: string;
  sender: { owner: string };
  receiver: { owner: string };
  amount: string;
  instrumentId: string;
  meta: unknown;
}

/** A TradeAllocationRequest's legs, one-sided from the authorizer's view. */
function legToSide(authorizer: string, leg: Leg) {
  return leg.sender.owner === authorizer
    ? {
        transferLegId: leg.transferLegId,
        side: "SenderSide",
        otherside: leg.receiver,
        amount: leg.amount,
        instrumentId: leg.instrumentId,
        meta: leg.meta,
      }
    : {
        transferLegId: leg.transferLegId,
        side: "ReceiverSide",
        otherside: leg.sender,
        amount: leg.amount,
        instrumentId: leg.instrumentId,
        meta: leg.meta,
      };
}

async function main(): Promise<void> {
  const ledger = new JsonApiLedger({
    baseUrl: LEDGER_URL,
    token: LEDGER_TOKEN,
    applicationId: USER_ID,
    templateIdPrefix: process.env.CANTON_DEX_PACKAGE_ID,
    synchronizerId: process.env.CANTON_SYNCHRONIZER,
  });
  const registry = new FixedRegistry(
    (process.env.CANTON_ALLOC_FACTORY_CID ?? "") as ContractId<"AllocationFactory">,
    (process.env.CANTON_SETTLE_FACTORY_CID ?? "") as ContractId<"SettlementFactory">,
    LEDGER_URL,
    LEDGER_TOKEN,
    ADMIN,
  );
  const matchedTrade = new MatchedTradeService(ledger, registry, OPERATOR);

  const ctx = await step("read /v1/context", () =>
    api<{ admin: string; allocationFactoryCid: string; allocationFactoryExtraArgs: unknown }>(
      "/v1/context",
    ),
  );

  // Both counterparties come from the PUBLIC faucet, so their holdings are
  // ordinary registry holdings owned by parties the operator is not a
  // stakeholder of -- which is the whole point of the exercise.
  const [seller, buyer] = await step("allocate two faucet parties", async () => {
    const a = await api<{ partyId: string }>("/v1/testnet/party", {});
    const b = await api<{ partyId: string }>("/v1/testnet/party", {});
    console.log(`    seller ${a.partyId.split("::")[0]}`);
    console.log(`    buyer  ${b.partyId.split("::")[0]}`);
    return [a.partyId as Party, b.partyId as Party];
  });

  // Seller delivers base, buyer delivers quote.
  const legs: Leg[] = [
    {
      transferLegId: "base",
      sender: basicAccount(seller),
      receiver: basicAccount(buyer),
      amount: BASE.amount,
      instrumentId: BASE.instrumentId,
      meta: { values: {} },
    },
    {
      transferLegId: "quote",
      sender: basicAccount(buyer),
      receiver: basicAccount(seller),
      amount: QUOTE.amount,
      instrumentId: QUOTE.instrumentId,
      meta: { values: {} },
    },
  ];

  // A long deadline on purpose: Allocation_Settle aborts once it passes, and a
  // deadline failure looks nothing like -- but would be mistaken for -- the
  // visibility failure this run exists to retire.
  const deadline = new Date(Date.now() + 2 * 3600 * 1000).toISOString();

  const tradeCid = await step("create MatchedTrade (operator is sole signatory)", async () => {
    const r = await ledger.submitWithUpdateId!<unknown>({
      actAs: [OPERATOR],
      commandId: `mt-probe-create:${Date.now()}`,
      command: {
        kind: "create",
        templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
        argument: {
          venue: OPERATOR,
          admin: ADMIN,
          transferLegs: legs,
          settlementDeadline: deadline,
          policyReceipt: null,
        },
      },
    });
    const created = (r as { createdEvents?: Array<{ templateId: string; contractId: string }> })
      .createdEvents?.find((e) => e.templateId.endsWith("MatchedTrade:MatchedTrade"));
    if (!created) throw new Error("no MatchedTrade in the create result");
    return created.contractId as ContractId<"MatchedTrade">;
  });

  const requests = await step("MatchedTrade_RequestAllocations", async () => {
    await matchedTrade.requestAllocations({ tradeCid });
    const rows = await ledger.query<{
      contractId: string;
      authorizer: { owner: string };
      settlement: unknown;
      transferLegs: Leg[];
    }>({
      templateId: "CantonDex.Dex.MatchedTrade:TradeAllocationRequest",
      observingParty: OPERATOR,
    });
    if (rows.length < 2) throw new Error(`expected 2 requests, saw ${rows.length}`);
    return rows.slice(-2);
  });

  // Each counterparty authors its own allocation through the PUBLIC relay --
  // no operator token, and AllocationFactory_Allocate is already allowlisted.
  // Deliberately NOT calling AllocationRequest_Accept: the settle fetches and
  // archives the requests itself, and Accept would archive them first.
  const allocationCids: string[] = [];
  for (const req of requests) {
    const party = req.authorizer.owner as Party;
    const label = party.split("::")[0];
    const side = req.transferLegs.map((l) => legToSide(party, l));
    const senderLeg = side.find((x) => x.side === "SenderSide");

    const cid = await step(`allocate as ${label} via the public relay`, async () => {
      let inputHoldingCids: string[] = [];
      if (senderLeg) {
        const holdings = await api<
          Array<{
            contractId: string;
            owner: string;
            admin: string;
            instrumentId: string;
            amount: string;
            locked: boolean;
          }>
        >(`/v1/holdings?owner=${encodeURIComponent(party)}`);
        const sel = selectCoveringHoldings(
          holdings as never,
          { owner: party, admin: ADMIN, instrumentId: senderLeg.instrumentId },
          dec.parseDecimal(senderLeg.amount),
        );
        if (!sel.cids?.length) {
          throw new Error(
            `${label} cannot cover ${senderLeg.amount} ${senderLeg.instrumentId} ` +
              `(unlocked ${dec.formatDecimal(sel.available)})`,
          );
        }
        inputHoldingCids = sel.cids;
      }

      const receipt = await api<{ updateId: string; createdEvents?: Array<{ templateId: string; contractId: string }> }>(
        "/v1/testnet/submit",
        {
          party,
          commands: [
            {
              ExerciseCommand: {
                templateId:
                  "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory",
                contractId: ctx.allocationFactoryCid,
                choice: "AllocationFactory_Allocate",
                choiceArgument: {
                  settlement: req.settlement,
                  allocation: {
                    settlement: req.settlement,
                    admin: ADMIN,
                    transferLegSides: side,
                    nextIterationFunding: null,
                    committed: false,
                    authorizer: basicAccount(party),
                    meta: { values: {} },
                  },
                  requestedAt: new Date().toISOString(),
                  inputHoldingCids,
                  actors: [party],
                  extraArgs: ctx.allocationFactoryExtraArgs,
                },
              },
            },
          ],
        },
      );
      const alloc = (receipt.createdEvents ?? []).find((e) =>
        e.templateId.endsWith("CantonDex.Registry.V2:Allocation"),
      );
      if (!alloc) throw new Error("the relay reported no Allocation");
      return alloc.contractId;
    });
    allocationCids.push(cid);
  }

  await step("MatchedTrade_Settle  <-- the payload + readAs fixes", async () => {
    await matchedTrade.settle({
      tradeCid,
      batchesByAdmin: new Map([
        [ADMIN, { allocationCids: allocationCids as ContractId<"Allocation">[] }],
      ]),
      // Empty on purpose. See MatchedTradeSettleInput.
      allocationRequestCids: [],
      dexPairCid: null,
    });
  });

  await step("confirm the legs moved", async () => {
    for (const [party, want] of [
      [buyer, BASE],
      [seller, QUOTE],
    ] as const) {
      const holdings = await api<Array<{ instrumentId: string; amount: string; locked: boolean }>>(
        `/v1/holdings?owner=${encodeURIComponent(party)}`,
      );
      const got = holdings
        .filter((h) => h.instrumentId === want.instrumentId && !h.locked)
        .reduce((s, h) => s + parseFloat(h.amount), 0);
      console.log(`    ${party.split("::")[0]} holds ${got} ${want.instrumentId}`);
      const stuck = holdings.filter((h) => h.locked);
      if (stuck.length) {
        throw new Error(`${party.split("::")[0]} still has ${stuck.length} LOCKED holding(s)`);
      }
    }
  });

  console.log("\nMatchedTrade settled on-ledger. Nothing left locked.");
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
