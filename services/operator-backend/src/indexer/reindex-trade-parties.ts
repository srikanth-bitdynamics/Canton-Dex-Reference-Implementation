// Recompute the trades table's derived party columns from each row's retained
// payload, using the shared `deriveTradeParties`. A row whose payload yields no
// identifiable leg parties (empty, malformed, or a non-array leg field) is left
// untouched rather than overwritten with null. Kept as a function over a minimal
// SQLite surface so the reindex path itself is unit-testable against an
// in-memory database.

import { deriveTradeParties } from "./trade-parties.js";

interface TradeRow {
  tradeCid: string;
  trader: string | null;
  dealer: string | null;
  counterparty: string | null;
  payload: string;
}

interface Statement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

interface SqliteDb {
  prepare(sql: string): Statement;
}

export interface TradePartyChange {
  tradeCid: string;
  before: { trader: string | null; dealer: string | null; counterparty: string | null };
  after: { trader: string | null; dealer: string | null; counterparty: string | null };
}

export interface ReindexTradePartiesResult {
  checked: number;
  fixed: number;
  changes: TradePartyChange[];
}

export function reindexTradeParties(db: SqliteDb, dryRun: boolean): ReindexTradePartiesResult {
  const trades = db
    .prepare("SELECT tradeCid, trader, dealer, counterparty, payload FROM trades")
    .all() as TradeRow[];
  const update = db.prepare(
    "UPDATE trades SET trader = ?, dealer = ?, counterparty = ? WHERE tradeCid = ?",
  );
  let checked = 0;
  const changes: TradePartyChange[] = [];
  for (const t of trades) {
    checked += 1;
    let payload: unknown;
    try {
      payload = JSON.parse(t.payload);
    } catch {
      continue;
    }
    const { trader, dealer, counterparty } = deriveTradeParties(payload);
    if (trader === null && counterparty === null) continue;
    if (trader === t.trader && dealer === t.dealer && counterparty === t.counterparty) continue;
    changes.push({
      tradeCid: t.tradeCid,
      before: { trader: t.trader, dealer: t.dealer, counterparty: t.counterparty },
      after: { trader, dealer, counterparty },
    });
    if (!dryRun) update.run(trader, dealer, counterparty, t.tradeCid);
  }
  return { checked, fixed: changes.length, changes };
}
