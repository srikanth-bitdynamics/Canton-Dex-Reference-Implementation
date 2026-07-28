// Migrations must reach a database that has already run some of them.
//
// A column was once added by amending an applied migration rather than adding
// a new one. Fresh databases got it and every test passed; deployments already
// at that version skipped the step entirely and served 500s.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { openDb } from "../src/indexer/db.js";

let dir: string;
const cols = (db: { pragma: (s: string) => Array<{ name: string }> }, t: string) =>
  db.pragma(`table_info(${t})`).map((c) => c.name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cdx-mig-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("indexer migrations", () => {
  it("a fresh database gets every column", () => {
    const db = openDb(join(dir, "fresh.db"));
    assert.ok(cols(db as never, "swaps").includes("kind"));
    assert.ok(cols(db as never, "trades").includes("counterparty"));
  });

  it("a database stopped at an earlier version still gets later columns", () => {
    // The production shape: kind present, counterparty absent, user_version
    // already at the value the amended migration would have set.
    const p = join(dir, "partial.db");
    const seed = openDb(p);
    const version = seed.pragma("user_version", { simple: true }) as number;
    seed.exec("ALTER TABLE trades DROP COLUMN counterparty");
    seed.exec(`PRAGMA user_version = ${version - 1}`);
    seed.close();

    const db = openDb(p);
    assert.ok(
      cols(db as never, "trades").includes("counterparty"),
      "counterparty was not added to a database that had already run earlier steps",
    );
    assert.ok(cols(db as never, "swaps").includes("kind"));
  });

  it("re-opening is idempotent", () => {
    const p = join(dir, "twice.db");
    openDb(p).close();
    const db = openDb(p);
    assert.ok(cols(db as never, "trades").includes("counterparty"));
  });

  it("a hand-repaired database can still advance", () => {
    // Someone adds the column directly to stop the bleeding, then deploys the
    // real migration. The duplicate must not wedge the runner.
    const p = join(dir, "repaired.db");
    const seed = openDb(p);
    const version = seed.pragma("user_version", { simple: true }) as number;
    seed.exec(`PRAGMA user_version = ${version - 1}`);
    seed.close();

    const db = openDb(p);
    assert.equal(db.pragma("user_version", { simple: true }), version);
    assert.ok(cols(db as never, "trades").includes("counterparty"));
  });

  it("a genuine migration error still throws", () => {
    const p = join(dir, "broken.db");
    const seed = new Database(p);
    seed.exec("CREATE TABLE swaps (nonsense TEXT)");
    seed.close();
    assert.throws(() => openDb(p));
  });
});
