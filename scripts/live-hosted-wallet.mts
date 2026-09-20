import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { openDb } from "../services/operator-backend/src/indexer/db.js";
import { HostedWalletService, hostedLedgerClient } from "../services/operator-backend/src/hosted-wallet/index.js";
import { from64, verifyTopology, verifyPrepared, type HostedConfig, type Topology } from "../app/web/src/wallet/hosted-crypto.js";
import type { PreparedSubmission } from "../app/web/src/wallet/sequential-submit.js";

const url = process.env.CANTON_LEDGER_URL!;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) || process.env.CANTON_LEDGER_TOKEN !== "sandbox-auth-disabled") {
  throw new Error("This proof requires a throwaway local sandbox with authentication disabled.");
}
const api = hostedLedgerClient(url, "sandbox-auth-disabled", "sandbox-auth-disabled");
const details = await api("/v2/parties") as { partyDetails: Array<{ party: string }> };
const operator = process.env.CANTON_OPERATOR ?? details.partyDetails.find(p => !p.party.startsWith("dex-user-"))!.party;
const connected = await api(`/v2/state/connected-synchronizers?party=${encodeURIComponent(operator)}`) as { connectedSynchronizers: Array<{ synchronizerId: string }> };
const participant = await api("/v2/parties/participant-id") as { participantId: string };
const cfg: HostedConfig = { origin: "http://localhost:5173", network: "canton:testnet",
  synchronizerId: connected.connectedSynchronizers[0]!.synchronizerId, participantId: participant.participantId };
const userId = `external-proof-${randomUUID()}`;
await api("/v2/users", { user: { id: userId, primaryParty: "", isDeactivated: false, identityProviderId: "", metadata: { resourceVersion: "", annotations: {} } }, rights: [] });
const db = openDb(":memory:");
const service = new HostedWalletService({ ...cfg, db, ledgerUserId: userId, ledger: api, callerJwtSecret: "sandbox-only-secret", now: Date.now });
const pair = generateKeyPairSync("ed25519");
const publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
async function request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const ch = service.challenge({ publicKey, action, payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") }, "local-proof");
  return service.request(action, { nonce: ch.nonce, payload, signature: nodeSign(null, Buffer.from(ch.message as string), pair.privateKey).toString("base64") }, "local-proof") as Promise<T>;
}
try {
  const topology = await request<Topology>("topology", {});
  await verifyTopology(topology, publicKey, cfg);
  await request("allocate", { topologySignature: nodeSign(null, from64(topology.multiHash), pair.privateKey).toString("base64") });
  const session = await request<{ party: string; callerToken: string }>("session", {});
  assert.equal(session.party, topology.partyId);
  assert.ok(session.callerToken);
  console.log("PASS: user key controls external party; signed session is party-bound");

  const dar = readFileSync(new URL("../trading/.daml/dist/canton-dex-trading-v2-1.4.0.dar", import.meta.url));
  const upload = await fetch(`${url}/v2/packages`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: dar });
  if (!upload.ok) throw new Error(`DAR upload failed: ${await upload.text()}`);
  const submission: PreparedSubmission = {
    commandId: `external-order-${randomUUID()}`, actAs: [topology.partyId],
    commands: [{ CreateCommand: {
      templateId: "#canton-dex-trading-v2:CantonDex.Dex.OrderFundingRequest:OrderFundingRequest",
      createArguments: { operator, trader: topology.partyId, baseInstrumentId: { admin: operator, id: "BASE" }, quoteInstrumentId: { admin: operator, id: "QUOTE" }, side: "Bid", limitPrice: "2.0000000000", quantity: "1.0000000000", expiry: null },
    } }],
  };
  const prepared = await request<{ id: string; preparedTransaction: string; preparedTransactionHash: string; hashingSchemeVersion: string }>("prepare", { ...submission });
  if (process.env.DEX_SIGNING_FIXTURE) writeFileSync(process.env.DEX_SIGNING_FIXTURE, JSON.stringify({ topology, publicKey, cfg, prepared, submission }, null, 2));
  await verifyPrepared(prepared, submission, cfg);
  const changed = structuredClone(submission);
  (changed.commands[0] as { CreateCommand: { createArguments: Record<string, unknown> } }).CreateCommand.createArguments.quantity = "1000";
  await assert.rejects(verifyPrepared(prepared, changed, cfg));
  console.log("PASS: browser recomputes the transaction hash and rejects changed amounts");
  await assert.rejects(api("/v2/commands/submit-and-wait", {
    ...submission, userId: process.env.CANTON_USER_ID ?? "ledger-api-user", readAs: [],
    disclosedContracts: [], packageIdSelectionPreference: [], prefetchContractKeys: [],
  }), /"code"\s*:\s*"NO_SYNCHRONIZER_ON_WHICH_ALL_SUBMITTERS_CAN_SUBMIT"/);
  console.log("PASS: participant rejects operator-only submission for the external party");
  const signature = nodeSign(null, from64(prepared.preparedTransactionHash), pair.privateKey).toString("base64");
  const result = await request<{ transaction: { updateId: string; events: unknown[] } }>("execute", { id: prepared.id, transactionSignature: signature });
  assert.ok(result.transaction.updateId);
  assert.equal(result.transaction.events.length, 1);
  const retry = await request<typeof result>("execute", { id: prepared.id, transactionSignature: signature });
  assert.equal(retry.transaction.updateId, result.transaction.updateId);
  console.log("PASS: user-signed transaction committed; retry returns the same update", result.transaction.updateId);
  const registry = await api("/v2/commands/submit-and-wait-for-transaction", { commands: {
    userId: process.env.CANTON_USER_ID ?? "ledger-api-user", commandId: `registry-${randomUUID()}`, actAs: [operator], readAs: [],
    commands: [{ CreateCommand: { templateId: "#canton-dex-trading-v2:CantonDex.Registry.V2:Registry", createArguments: { admin: operator, users: [topology.partyId] } } }],
    disclosedContracts: [], packageIdSelectionPreference: [], prefetchContractKeys: [],
  } }) as { transaction: { events: Array<{ CreatedEvent?: { contractId: string } }> } };
  const factoryCid = registry.transaction.events.find(e => e.CreatedEvent)!.CreatedEvent!.contractId;
  const account = (owner: string | null) => ({ owner, provider: null, id: "" });
  const allocation: PreparedSubmission = { commandId: `allocation-${randomUUID()}`, actAs: [topology.partyId],
    commands: [{ ExerciseCommand: {
      templateId: "#splice-api-token-allocation-instruction-v2:Splice.Api.Token.AllocationInstructionV2:AllocationFactory",
      contractId: factoryCid, choice: "AllocationFactory_Allocate", choiceArgument: {
        settlement: { executors: [operator], id: "ExternalSigningProof", cid: null, meta: { values: {} } },
        allocation: { admin: operator, authorizer: account(topology.partyId), transferLegSides: [{ transferLegId: "lp-receipt", side: "ReceiverSide", otherside: { ...account(null), id: "mint" }, amount: "1.0000000000", instrumentId: "LP", meta: { values: {} } }],
          settlementDeadline: null, nextIterationFunding: {}, committed: true, meta: { values: {} } },
        requestedAt: new Date().toISOString(), inputHoldingCids: [], extraArgs: { context: { values: {} }, meta: { values: {} } }, actors: [topology.partyId],
      },
    } }],
  };
  const allocationPrepared = await request<typeof prepared>("prepare", { ...allocation });
  if (process.env.DEX_SIGNING_FIXTURE) writeFileSync(`${process.env.DEX_SIGNING_FIXTURE}.allocation`, JSON.stringify({ topology, publicKey, cfg, prepared: allocationPrepared, submission: allocation }, null, 2));
  await verifyPrepared(allocationPrepared, allocation, cfg);
  const allocationResult = await request<typeof result>("execute", { id: allocationPrepared.id,
    transactionSignature: nodeSign(null, from64(allocationPrepared.preparedTransactionHash), pair.privateKey).toString("base64") });
  assert.ok(JSON.stringify(allocationResult.transaction.events).includes("CantonDex.Registry.V2:Allocation"));
  console.log("PASS: externally signed TSv2 LP receipt allocation committed", allocationResult.transaction.updateId);
} finally { db.close(); }
