import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { openDb } from "../src/indexer/db.js";
import { HostedWalletService } from "../src/hosted-wallet/index.js";
import { verifyHs256 } from "../src/http/caller-auth.js";

function fixture() {
  const db = openDb(":memory:");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
  const calls: Array<{ path: string; body: any; admin: boolean | undefined }> = [];
  let now = Date.now();
  let rightsFail = false;
  const hash = randomBytes(32).toString("base64");
  const cfg = {
    db, origin: "https://dex.example", network: "canton:testnet", synchronizerId: "sync::123",
    participantId: "participant::123", ledgerUserId: "external-users", callerJwtSecret: "test-secret", callerJwtAudience: "dex",
    now: () => now,
    ledger: async (path: string, body?: unknown, admin?: boolean): Promise<Record<string, unknown>> => {
      calls.push({ path, body, admin });
      if (path.endsWith("generate-topology")) return { partyId: `dex-user::${publicKey}`, publicKeyFingerprint: publicKey, multiHash: hash, topologyTransactions: ["topology"] };
      if (path.endsWith("/rights") && rightsFail) throw new Error("grant unavailable");
      if (path.endsWith("/prepare")) return { preparedTransaction: "prepared", preparedTransactionHash: hash, hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" };
      if (path.endsWith("executeAndWaitForTransaction")) return { transaction: { updateId: "update-1", events: [] } };
      if (path.endsWith("ledger-end")) return { offset: 42 };
      return {};
    },
  };
  let service = new HostedWalletService(cfg);
  function envelope(action: string, payload: Record<string, unknown> = {}) {
    const ch = service.challenge({ publicKey, action, payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") }, "ip");
    return { nonce: ch.nonce, payload, signature: sign(null, Buffer.from(ch.message as string), keys.privateKey).toString("base64") };
  }
  const request = (action: string, payload: Record<string, unknown> = {}) => service.request(action, envelope(action, payload), "ip");
  const topologySignature = () => sign(null, Buffer.from(hash, "base64"), keys.privateKey).toString("base64");
  async function onboard() { await request("topology"); await request("allocate", { topologySignature: topologySignature() }); }
  return { db, cfg, calls, publicKey, request, envelope, onboard, topologySignature, hash,
    service: () => service, restart: () => { service = new HostedWalletService(cfg); },
    advance: () => { now += 121_000; }, failRights: (value: boolean) => { rightsFail = value; } };
}

describe("external hosted wallet authority", () => {
  it("requires signature, exact payload and route, a live challenge, and one-time consumption", async () => {
    const f = fixture();
    try {
      const e = f.envelope("topology");
      await assert.rejects(f.service().request("topology", { ...e, signature: randomBytes(64).toString("base64") }, "ip"), /invalid request signature/);
      await assert.rejects(f.service().request("topology", { ...e, payload: { party: "victim" } }, "ip"), /payload changed/);
      await assert.rejects(f.service().request("session", e, "ip"), /invalid or expired/);
      assert.equal(f.calls.length, 0);
      await f.service().request("topology", e, "ip");
      await assert.rejects(f.service().request("topology", e, "ip"), /invalid or expired/);
      const expired = f.envelope("session"); f.advance();
      await assert.rejects(f.service().request("session", expired, "ip"), /invalid or expired/);
    } finally { f.db.close(); }
  });

  it("creates only external parties and grants read/execute rights without CanActAs", async () => {
    const f = fixture();
    try {
      await f.onboard();
      const grant = f.calls.find(c => c.path.endsWith("/rights"))!;
      assert.equal(grant.body.userId, "external-users");
      assert.deepEqual(grant.body.rights.map((r: any) => Object.keys(r.kind)[0]), ["CanReadAs", "CanExecuteAs"]);
      assert.ok(f.calls.every(c => c.path !== "/v2/parties" && !c.path.includes("commands/submit")));
      const allocation = f.calls.find(c => c.path.endsWith("external/allocate"))!;
      assert.equal(allocation.body.userId, undefined);
      assert.equal(allocation.body.multiHashSignatures.length, 1);
      assert.equal(allocation.admin, true);
    } finally { f.db.close(); }
  });

  it("resumes a failed rights grant without creating another party", async () => {
    const f = fixture();
    try {
      await f.request("topology"); f.failRights(true);
      await assert.rejects(f.request("allocate", { topologySignature: f.topologySignature() }), /grant unavailable/);
      await assert.rejects(f.request("session"), /not allocated/);
      f.restart(); f.failRights(false);
      await f.request("allocate", { topologySignature: f.topologySignature() });
      assert.equal(f.calls.filter(c => c.path.endsWith("external/allocate")).length, 1);
    } finally { f.db.close(); }
  });

  it("binds sessions and private reads to the stored key owner", async () => {
    const f = fixture();
    try {
      await f.onboard();
      await assert.rejects(f.request("session", { party: "victim" }), /own party/);
      await assert.rejects(f.request("holdings", { party: "victim", filters: [] }), /own party/);
      const session = await f.request("session");
      assert.equal(verifyHs256(session.callerToken as string, "test-secret", { audience: "dex" })?.sub, `dex-user::${f.publicKey}`);
      await f.request("holdings", { filters: [], filtersByParty: { victim: {} } });
      const query = f.calls.at(-1)!;
      assert.deepEqual(Object.keys(query.body.filter.filtersByParty), [`dex-user::${f.publicKey}`]);
      assert.equal(query.body.activeAtOffset, 42);
    } finally { f.db.close(); }
  });

  it("prepares only allowed commands under the authenticated party and fixed ledger user", async () => {
    const f = fixture();
    try {
      await f.onboard();
      await assert.rejects(f.request("prepare", { commands: [{ ExerciseCommand: { choice: "Registry_Mint" } }], commandId: "bad" }), /unsupported wallet command/);
      await f.request("prepare", { commands: [{ ExerciseCommand: { choice: "AllocationFactory_Allocate" } }], commandId: "good", actAs: ["victim"], readAs: ["victim"], userId: "operator" });
      const prepare = f.calls.at(-1)!;
      assert.deepEqual(prepare.body.actAs, [`dex-user::${f.publicKey}`]);
      assert.deepEqual(prepare.body.readAs, []);
      assert.equal(prepare.body.userId, "external-users");
      assert.equal(prepare.admin, undefined);
    } finally { f.db.close(); }
  });

  it("executes the stored transaction only with its user's transaction signature and caches completion", async () => {
    const f = fixture();
    try {
      await f.onboard();
      const prepared = await f.request("prepare", { commands: [{ ExerciseCommand: { choice: "AllocationFactory_Allocate" } }], commandId: "good" });
      await assert.rejects(f.request("execute", { id: prepared.id, transactionSignature: randomBytes(64).toString("base64") }), /invalid transaction signature/);
      const payload = { id: prepared.id, transactionSignature: f.topologySignature(), preparedTransaction: "attacker", partySignatures: {} };
      const result = await f.request("execute", payload);
      f.restart();
      assert.deepEqual(await f.request("execute", payload), result);
      const calls = f.calls.filter(c => c.path.endsWith("executeAndWaitForTransaction"));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.body.preparedTransaction, "prepared");
      assert.equal(calls[0]!.body.partySignatures.signatures[0].party, `dex-user::${f.publicKey}`);
    } finally { f.db.close(); }
  });

  it("preserves consumed challenges and onboarding limits across service restarts", async () => {
    const f = fixture();
    try {
      const e = f.envelope("topology");
      await f.service().request("topology", e, "ip"); f.restart();
      await assert.rejects(f.service().request("topology", e, "ip"), /invalid or expired/);
      assert.equal((f.db.prepare("SELECT count FROM hosted_wallet_limits WHERE bucket LIKE '%onboarding:ip'").get() as { count: number }).count, 1);
      await f.request("topology");
      assert.equal(f.calls.filter(c => c.path.endsWith("generate-topology")).length, 1);
    } finally { f.db.close(); }
  });
});
