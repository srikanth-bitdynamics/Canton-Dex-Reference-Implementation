// DEX-107: IdempotentLedger transitions — cache hit on success, in-flight
// rejection, and the new replay guard (same commandId, different args).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "../src/indexer/db.js";
import { IdempotentLedger, hashSubmitRequest } from "../src/indexer/idempotency.js";
import type {
  LedgerEvent,
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
} from "../src/ledger/index.js";

// Inner submitter that counts calls and returns a canned result, or throws.
class CountingLedger implements LedgerSubmitter {
  calls = 0;
  result: unknown = { ok: true };
  throwError: Error | null = null;

  async submit<R>(_req: SubmitRequest): Promise<R> {
    this.calls += 1;
    if (this.throwError) throw this.throwError;
    return this.result as R;
  }
  async *subscribe<T>(_f: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {}
  async query<T>(_f: SubscriptionFilter): Promise<T[]> {
    return [];
  }
}

function req(commandId: string, amount: string): SubmitRequest {
  return {
    actAs: ["op" as never],
    commandId,
    command: {
      kind: "create",
      templateId: "Test:T",
      argument: { amount },
    },
  };
}

let dir: string;
let db: Db;
let inner: CountingLedger;
let ledger: IdempotentLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "idem-"));
  db = openDb(join(dir, "test.db"));
  inner = new CountingLedger();
  ledger = new IdempotentLedger(inner, db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("DEX-107 IdempotentLedger", () => {
  it("caches the result and does not re-fire on a same-arg retry", async () => {
    const r1 = await ledger.submit(req("cmd-1", "10.0"));
    const r2 = await ledger.submit(req("cmd-1", "10.0"));
    assert.deepEqual(r1, { ok: true });
    assert.deepEqual(r2, { ok: true });
    assert.equal(inner.calls, 1, "second submit served from cache");
  });

  it("rejects a replay: same commandId, different args", async () => {
    await ledger.submit(req("cmd-2", "10.0"));
    await assert.rejects(
      () => ledger.submit(req("cmd-2", "999.0")),
      /replayed with different args/,
    );
    assert.equal(inner.calls, 1, "the replay did not reach the inner ledger");
  });

  it("records argsHash so distinct content is distinguishable", () => {
    const h1 = hashSubmitRequest(req("x", "1.0"));
    const h2 = hashSubmitRequest(req("x", "2.0"));
    const h1b = hashSubmitRequest(req("x", "1.0"));
    assert.notEqual(h1, h2);
    assert.equal(h1, h1b);
  });

  it("on error, marks the row error and allows a later retry", async () => {
    inner.throwError = new Error("boom");
    await assert.rejects(() => ledger.submit(req("cmd-3", "5.0")), /boom/);
    // Clear the error; same commandId + same args should now retry (prior
    // status was 'error', not 'ok').
    inner.throwError = null;
    const r = await ledger.submit(req("cmd-3", "5.0"));
    assert.deepEqual(r, { ok: true });
    assert.equal(inner.calls, 2, "retried after the prior error");
  });
});
