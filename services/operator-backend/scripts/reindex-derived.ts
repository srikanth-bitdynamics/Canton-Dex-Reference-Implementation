// Recompute the indexer's derived columns for rows written before the
// exactness and labelling fixes.
//
// Those fixes were forward-only: rows already in the database keep the values
// they were written with. A swap recorded before the change can differ from
// the ledger in the last decimal place, and a trade recorded before the
// labelling fix has `trader` and `dealer` the wrong way round on buys.
//
// No ledger read is needed. `pool_states` is append-only and stores reserves
// and supply as exact decimal strings keyed by contract id, and every `swaps`
// row names both the old and new state; `trades` keeps the raw payload it was
// derived from. Everything below is recomputed from those.
//
//   node --import tsx scripts/reindex-derived.ts --db path/to/indexer.db
//   node --import tsx scripts/reindex-derived.ts --db ... --dry-run
//
// Idempotent: running it twice changes nothing the second time.

import { openDb } from "../src/indexer/db.js";
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
    // An unparseable reserve is left alone rather than overwritten.
    continue;
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
  let parsed: {
    transferLegs?: Array<{
      sender?: { owner?: string };
      receiver?: { owner?: string };
    }>;
    policyReceipt?: { acceptedDealer?: string | null } | null;
  };
  try {
    parsed = JSON.parse(t.payload);
  } catch {
    continue;
  }
  const legs = parsed.transferLegs ?? [];
  const legParties = [
    ...new Set(
      legs.flatMap((l) => [l.sender?.owner, l.receiver?.owner]).filter(Boolean),
    ),
  ] as string[];

  // Same derivation as the indexer: the venue-signed receipt names the dealer;
  // the trader is the other party. Without a receipt there is no dealer role.
  const acceptedDealer = parsed.policyReceipt?.acceptedDealer ?? null;
  const dealer = acceptedDealer;
  const trader = acceptedDealer
    ? (legParties.find((x) => x !== acceptedDealer) ?? null)
    : (legs[0]?.sender?.owner ?? null);
  const counterparty = legParties.find((x) => x !== trader) ?? null;

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
