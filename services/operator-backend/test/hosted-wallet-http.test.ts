import { it } from "node:test";
import assert from "node:assert/strict";
import { startHttpServer } from "../src/http/index.js";
import { InMemoryLedger } from "../src/ledger/in-memory.js";
import { OperatorBackend } from "../src/index.js";
import { openDb } from "../src/indexer/db.js";
import { HostedWalletService } from "../src/hosted-wallet/index.js";
import { StubRegistry } from "./stub-registry.js";
import { createServer } from "node:http";
import { verifyHostedLedgerAccess } from "../src/hosted-wallet/index.js";

it("hosted startup rejects anonymous access and excess ledger rights", async () => {
  let anonymousStatus = 200;
  let adminStatus = 403;
  let rights: unknown[] = [];
  const server = createServer((req, res) => {
    if (!req.headers.authorization) { res.writeHead(anonymousStatus); res.end(); return; }
    if (req.url === "/v2/users") { res.writeHead(adminStatus); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ rights }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await assert.rejects(verifyHostedLedgerAccess(url, "wallet", "token"), /anonymous requests/);
    anonymousStatus = 401;
    adminStatus = 200;
    await assert.rejects(verifyHostedLedgerAccess(url, "wallet", "token"), /user-administration access/);
    adminStatus = 403;
    for (const kind of ["CanActAs", "ParticipantAdmin", "CanReadAsAnyParty", "IdentityProviderAdmin"]) {
      rights = [{ kind: { [kind]: { value: {} } } }];
      await assert.rejects(verifyHostedLedgerAccess(url, "wallet", "token"), /only CanReadAs and CanExecuteAs/);
    }
    rights = ["CanReadAs", "CanExecuteAs"].map(kind => ({ kind: { [kind]: { value: { party: "user" } } } }));
    await verifyHostedLedgerAccess(url, "wallet", "token");
    rights = [];
    await verifyHostedLedgerAccess(url, "wallet", "token");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it("hosted HTTP routes fail closed when disabled, cross-origin, or unsigned", async () => {
  const backend = new OperatorBackend({ ledger: new InMemoryLedger(), registry: new StubRegistry(), operatorParty: "op" as never });
  const cfg = { backend, port: 0, host: "127.0.0.1", context: { operator: "op" as never, lpRegistrar: "lp" as never, admin: "admin" as never, network: "canton:testnet" } };
  const disabled = await startHttpServer(cfg);
  try {
    const res = await fetch(`${disabled.url}/v1/hosted-wallet/config`);
    assert.equal(res.status, 404);
  } finally { await disabled.close(); }
  const db = openDb(":memory:");
  let ledgerCalls = 0;
  const wallet = new HostedWalletService({ db, origin: "https://dex.example", network: "canton:testnet", participantId: "participant", synchronizerId: "sync", ledgerUserId: "user", callerJwtSecret: "secret", ledger: async () => { ledgerCalls++; return {}; } });
  const enabled = await startHttpServer({ ...cfg, hostedWallet: wallet });
  try {
    assert.equal((await fetch(`${enabled.url}/v1/hosted-wallet/config`)).status, 200);
    assert.equal((await fetch(`${enabled.url}/v1/hosted-wallet/config`, { headers: { Origin: "https://attacker.example" } })).status, 403);
    assert.equal((await fetch(`${enabled.url}/v1/hosted-wallet/config`, { headers: { Origin: "https://dex.example" } })).status, 200);
    for (const action of ["topology", "allocate", "session", "holdings", "prepare", "execute"]) {
      const res = await fetch(`${enabled.url}/v1/hosted-wallet/${action}`, { method: "POST", headers: { Origin: "https://dex.example", "Content-Type": "application/json" }, body: JSON.stringify({ party: "victim", nonce: "forged", signature: "forged", payload: {} }) });
      assert.equal(res.status, 401, action);
    }
    assert.equal(ledgerCalls, 0);
  } finally { await enabled.close(); db.close(); }
});
