// SQLite-backed persistence for the operator-backend. Hosts the event
// indexer's tables, the idempotency cache, and operator config kv.
//
// Schema is deliberately Postgres-compatible (no SQLite-only types,
// no AUTOINCREMENT — we use INTEGER PRIMARY KEY which becomes a rowid)
// so we can swap to pg if/when the testnet outgrows a single file.
//
// Migrations are append-only: each new schema change adds a numbered
// step to `MIGRATIONS`. `applyMigrations` runs anything past the
// recorded `user_version`.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  // v1: event log + per-domain projections
  `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    templateId TEXT NOT NULL,
    contractId TEXT NOT NULL,
    party TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_party_ts ON events(party, ts);
  CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts);

  CREATE TABLE IF NOT EXISTS trades (
    tradeCid TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    pair TEXT NOT NULL,
    trader TEXT,
    dealer TEXT,
    policyVersion TEXT,
    acceptedRank INTEGER,
    consideredCount INTEGER,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS trades_trader_ts ON trades(trader, ts);

  CREATE TABLE IF NOT EXISTS pool_states (
    poolCid TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    pairKey TEXT NOT NULL,
    baseInstrumentId TEXT NOT NULL,
    quoteInstrumentId TEXT NOT NULL,
    status TEXT,
    baseReserve TEXT,
    quoteReserve TEXT,
    totalLpSupply TEXT,
    predecessor TEXT,
    archived INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS pool_states_pair_ts ON pool_states(pairKey, ts);

  CREATE TABLE IF NOT EXISTS swaps (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    oldPoolCid TEXT NOT NULL,
    newPoolCid TEXT NOT NULL,
    pair TEXT NOT NULL,
    baseDelta TEXT NOT NULL,
    quoteDelta TEXT NOT NULL,
    priceAfter TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS swaps_pair_ts ON swaps(pair, ts);

  CREATE TABLE IF NOT EXISTS rfq_history (
    rfqId TEXT NOT NULL,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL,
    trader TEXT,
    pair TEXT,
    acceptedDealer TEXT,
    acceptedRank INTEGER,
    policyVersion TEXT,
    PRIMARY KEY (rfqId, ts)
  );
  CREATE INDEX IF NOT EXISTS rfq_trader_ts ON rfq_history(trader, ts);
  `,
  // v2: idempotency cache for command submissions
  `
  CREATE TABLE IF NOT EXISTS command_submissions (
    commandId TEXT PRIMARY KEY,
    submittedAt INTEGER NOT NULL,
    completedAt INTEGER,
    status TEXT NOT NULL,         -- 'pending' | 'ok' | 'error'
    resultJson TEXT
  );
  CREATE INDEX IF NOT EXISTS command_submissions_submittedAt
    ON command_submissions(submittedAt);
  `,
  // v3: operator config kv
  `
  CREATE TABLE IF NOT EXISTS operator_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  `,
  // v4: dealer registry (RFQ counterparties)
  `
  CREATE TABLE IF NOT EXISTS dealers (
    party TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0,
    whitelisted INTEGER NOT NULL DEFAULT 1,
    latencyMs INTEGER,
    fillRate REAL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  `,
  // v5: replay-detection hash of the request args per commandId.
  // A same-commandId submit with a different argsHash is a replay/conflict
  // and must be rejected rather than silently re-fired or cache-hit.
  `
  ALTER TABLE command_submissions ADD COLUMN argsHash TEXT;
  `,
  // v6: what a pool rotation actually WAS.
  //
  // The indexer emits a `swaps` row for every PoolState rotation, but five
  // Daml choices rotate one -- Swap, Pause, Resume, SettleAddLiquidity and
  // SettleRemoveLiquidity -- so LP moves and pause/resume were served to the
  // UI as swaps with a fabricated direction and price. The indexer polls the
  // ACS and never sees a choice name, so the discriminator has to come from
  // the state itself: `totalLpSupply` changes on an add/remove and on nothing
  // else (swap fees accrue to LPs through the reserves, minting no shares).
  //
  // Backfill from pool_states, which is append-only with a soft `archived`
  // flag and has carried totalLpSupply since v1, so no ledger re-read is
  // needed. poolCid is the PRIMARY KEY, so each correlated subquery yields at
  // most one row; a row whose join misses falls through to the sign test,
  // where a swap's reserve deltas have opposite signs while an add moves both
  // up and a remove moves both down.
  //
  // The supply comparison gates on exact string inequality before letting a
  // REAL comparison pick the direction, so two distinct supplies can never
  // collapse to "unchanged" the way a bare CAST would above ~2^53. Two
  // distinct strings that do compare equal as REAL fall through to the sign
  // test rather than being mislabelled.
  `
  ALTER TABLE swaps ADD COLUMN kind TEXT NOT NULL DEFAULT 'swap';
  CREATE INDEX IF NOT EXISTS swaps_kind_pair_ts ON swaps(kind, pair, ts);
  UPDATE swaps SET kind = CASE
    WHEN (SELECT n.totalLpSupply FROM pool_states n WHERE n.poolCid = swaps.newPoolCid)
      <> (SELECT o.totalLpSupply FROM pool_states o WHERE o.poolCid = swaps.oldPoolCid)
     AND (SELECT CAST(n.totalLpSupply AS REAL) FROM pool_states n WHERE n.poolCid = swaps.newPoolCid)
       > (SELECT CAST(o.totalLpSupply AS REAL) FROM pool_states o WHERE o.poolCid = swaps.oldPoolCid)
      THEN 'add_liquidity'
    WHEN (SELECT n.totalLpSupply FROM pool_states n WHERE n.poolCid = swaps.newPoolCid)
      <> (SELECT o.totalLpSupply FROM pool_states o WHERE o.poolCid = swaps.oldPoolCid)
     AND (SELECT CAST(n.totalLpSupply AS REAL) FROM pool_states n WHERE n.poolCid = swaps.newPoolCid)
       < (SELECT CAST(o.totalLpSupply AS REAL) FROM pool_states o WHERE o.poolCid = swaps.oldPoolCid)
      THEN 'remove_liquidity'
    WHEN CAST(baseDelta AS REAL) = 0 AND CAST(quoteDelta AS REAL) = 0
      THEN 'state_change'
    WHEN CAST(baseDelta AS REAL) > 0 AND CAST(quoteDelta AS REAL) > 0
      THEN 'add_liquidity'
    WHEN CAST(baseDelta AS REAL) < 0 AND CAST(quoteDelta AS REAL) < 0
      THEN 'remove_liquidity'
    ELSE 'swap'
  END;
  ALTER TABLE trades ADD COLUMN counterparty TEXT;
  UPDATE events SET kind = (
    SELECT s.kind FROM swaps s WHERE s.newPoolCid = events.contractId
  )
  WHERE kind = 'pool_swap'
    AND EXISTS (SELECT 1 FROM swaps s WHERE s.newPoolCid = events.contractId);
  `,
];

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return db;
}

function applyMigrations(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
