// Recompute the indexer's derived columns from the exact source values retained
// in append-only pool-state and trade records.
//
// No ledger read: pool_states is append-only and keeps exact reserve strings
// keyed by contract id, every swaps row names the states it sits between, and
// trades keeps the payload it was derived from.
//
//   node --import tsx scripts/reindex-derived.ts --db <path> [--dry-run]
//
// Idempotent.

import { openDb } from "../src/indexer/db.js";
import { deriveTradeParties } from "../src/indexer/trade-parties.js";
import * as dec from "../src/pool/decimal.js";
import { rootLogger } from "../src/lib/logger.js";

const log = rootLogger.child({ component: "reindex-derived" });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg("db");
const dryRun = process.argv.includes("--dry-run");
if (!dbPath) {
  log.error("usage: reindex-derived.ts --db <path> [--dry-run]");
  process.exit(1);
}

const db = openDb(dbPath);

interface StateRow {
  baseReserve: string | null;
  quoteReserve: string | null;
}

const state = db.prepare(
  "SELECT baseReserve, quoteReserve FROM pool_states WHERE poolCid = ?",
);

let swapsChecked = 0;
let swapsFixed = 0;

const swaps = db
  .prepare("SELECT id, oldPoolCid, newPoolCid, baseDelta, quoteDelta, priceAfter FROM swaps")
  .all() as Array<{
    id: number;
    oldPoolCid: string;
    newPoolCid: string;
    baseDelta: string;
    quoteDelta: string;
    priceAfter: string;
  }>;

const updateSwap = db.prepare(
  "UPDATE swaps SET baseDelta = ?, quoteDelta = ?, priceAfter = ? WHERE id = ?",
);

for (const s of swaps) {
  swapsChecked += 1;
  const oldS = state.get(s.oldPoolCid) as StateRow | undefined;
  const newS = state.get(s.newPoolCid) as StateRow | undefined;
  if (!oldS?.baseReserve || !newS?.baseReserve) continue;

  let baseDelta: string;
  let quoteDelta: string;
  let priceAfter: string;
  try {
    const nb = dec.parseDecimal(newS.baseReserve);
    const nq = dec.parseDecimal(newS.quoteReserve!);
    const ob = dec.parseDecimal(oldS.baseReserve);
    const oq = dec.parseDecimal(oldS.quoteReserve!);
    baseDelta = dec.formatDecimal(nb - ob);
    quoteDelta = dec.formatDecimal(nq - oq);
    priceAfter = nb > 0n ? dec.formatDecimal(dec.div(nq, nb)) : dec.formatDecimal(0n);
  } catch {
    continue; // unparseable reserve: leave the row alone
  }

  if (
    baseDelta === s.baseDelta &&
    quoteDelta === s.quoteDelta &&
    priceAfter === s.priceAfter
  ) {
    continue;
  }
  log.info("swap row differs", {
    id: s.id,
    baseDelta: { was: s.baseDelta, now: baseDelta },
    quoteDelta: { was: s.quoteDelta, now: quoteDelta },
    priceAfter: { was: s.priceAfter, now: priceAfter },
  });
  swapsFixed += 1;
  if (!dryRun) updateSwap.run(baseDelta, quoteDelta, priceAfter, s.id);
}

let tradesChecked = 0;
let tradesFixed = 0;

const trades = db
  .prepare("SELECT tradeCid, trader, dealer, counterparty, payload FROM trades")
  .all() as Array<{
    tradeCid: string;
    trader: string | null;
    dealer: string | null;
    counterparty: string | null;
    payload: string;
  }>;

const updateTrade = db.prepare(
  "UPDATE trades SET trader = ?, dealer = ?, counterparty = ? WHERE tradeCid = ?",
);

for (const t of trades) {
  tradesChecked += 1;
  let payload: unknown;
  try {
    payload = JSON.parse(t.payload);
  } catch {
    continue;
  }
  // Same derivation as the indexer, shared via `deriveTradeParties`.
  const { trader, dealer, counterparty } = deriveTradeParties(payload);
  // No identifiable leg parties (empty, legacy-empty, or malformed payload):
  // leave the stored row untouched rather than overwriting it with null.
  if (trader === null && counterparty === null) continue;

  if (trader === t.trader && dealer === t.dealer && counterparty === t.counterparty) {
    continue;
  }
  log.info("trade row differs", {
    tradeCid: t.tradeCid,
    trader: { was: t.trader, now: trader },
    dealer: { was: t.dealer, now: dealer },
    counterparty: { was: t.counterparty, now: counterparty },
  });
  tradesFixed += 1;
  if (!dryRun) updateTrade.run(trader, dealer, counterparty, t.tradeCid);
}

log.info("reindex complete", {
  dryRun,
  swaps: { checked: swapsChecked, changed: swapsFixed },
  trades: { checked: tradesChecked, changed: tradesFixed },
});
