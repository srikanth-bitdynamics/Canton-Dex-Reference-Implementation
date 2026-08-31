// Event indexer. Polls the ledger for the templates we care about,
// diffs against persisted state, and writes new events / projections.
//
// Design: polling, not streaming. Trade-off: misses fast-moving
// intermediate states (e.g. two Pool versions inside the same poll
// window collapse to one swap row). For testnet preview this is fine;
// for production we'd switch to a transaction-stream subscriber.
// Crash safety: state is reconciled from current ACS on every tick,
// so a crash just means a missed poll, not a corrupt DB.

import type { Db } from "./db.js";
import type { LedgerSubmitter } from "../ledger/index.js";
import type { InstrumentId, Party } from "../types.js";
import * as dec from "../pool/decimal.js";

// Display label (text ids) vs identity key (admins folded in). Text symbols are
// display only; two instruments can share an id under different admins.
function pairLabel(base: InstrumentId, quote: InstrumentId): string {
  return `${base.id}/${quote.id}`;
}
function pairIdentityKey(base: InstrumentId, quote: InstrumentId): string {
  return `${base.admin}:${base.id}/${quote.admin}:${quote.id}`;
}

type LedgerQuery = Pick<LedgerSubmitter, "query">;

const MATCHED_TRADE = "CantonDex.Dex.MatchedTrade:MatchedTrade";
const SETTLED_TRADE = "CantonDex.Dex.MatchedTrade:SettledTrade";

// A V2 transfer leg, as the ACS serves it. `sender`/`receiver` owners are
// `Optional Party`, so either a party string or null.
interface TransferLegRow {
  transferLegId: string;
  sender: { owner: Party | null };
  receiver: { owner: Party | null };
  amount: string;
  instrumentId: string;
}

// Both trade templates now carry admin-tagged legs (`TradeLeg`): the instrument
// admin travels alongside each `V2.TransferLeg`, whose own `instrumentId` is
// only the text id.
interface TradeLegRow {
  admin: Party;
  leg: TransferLegRow;
}

interface MatchedTradeContract {
  contractId: string;
  venue: Party;
  tradeLegs?: TradeLegRow[];
  settlementDeadline?: string | null;
  policyReceipt?: {
    policyVersion: string;
    rfqId: string;
    rankedDealers: Array<{ party: Party; rank: number; tier: string }>;
    acceptedDealer: Party;
    acceptedRank: number;
    consideredCount: number;
    signedBy: Party;
    signedAt: string;
  } | null;
}

// An order-book fill settles inside OrderMatchExecution_Execute, which archives
// the execution contract in the same transaction. SettledTrade is the record it
// leaves behind, and it carries the same legs a MatchedTrade does.
interface SettledTradeContract {
  contractId: string;
  operator: Party;
  matchId: string;
  settledAt: string;
  tradeLegs?: TradeLegRow[];
}

type TradeRow = MatchedTradeContract & { templateId: string };

function settledAsTrade(s: SettledTradeContract): TradeRow {
  return {
    contractId: s.contractId,
    venue: s.operator,
    tradeLegs: s.tradeLegs,
    settlementDeadline: null,
    policyReceipt: null,
    templateId: SETTLED_TRADE,
  };
}

// PoolState rotates on every pool op. We track its transitions for swap
// detection and join pool config by poolId.
interface PoolConfigRow {
  contractId: string;
  poolId: string;
  baseInstrumentId: InstrumentId;
  quoteInstrumentId: InstrumentId;
}
interface PoolStateRow {
  contractId: string;
  poolId: string;
  status: string;
  reserves: { baseAmount: string; quoteAmount: string };
  totalLpSupply: string;
}
interface PoolContract {
  contractId: string;
  baseInstrumentId: InstrumentId;
  quoteInstrumentId: InstrumentId;
  status: string;
  reserves: { baseAmount: string; quoteAmount: string };
  totalLpSupply: string;
}

interface RfqContract {
  contractId: string;
  trader: Party;
  rfqId: string;
  baseInstrumentId: InstrumentId;
  quoteInstrumentId: InstrumentId;
  expiresAt: string;
  createdAt: string;
}

export interface IndexerConfig {
  intervalMs: number;
  observingParty: Party;
}

export class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerQuery,
    private readonly cfg: IndexerConfig,
  ) {}

  start(): void {
    if (this.timer) return;
    // Kick off one tick immediately; subsequent ticks on interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // single-flight; skip if prior tick still running
    this.running = true;
    const ts = Date.now();
    try {
      await Promise.all([
        this.reconcileTrades(ts),
        this.reconcilePools(ts),
        this.reconcileRfqs(ts),
      ]);
    } catch (err) {
      console.error("[indexer] tick failed:", (err as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async reconcileTrades(ts: number): Promise<void> {
    const [matched, settled] = await Promise.all([
      this.ledger.query<MatchedTradeContract>({
        templateId: MATCHED_TRADE,
        observingParty: this.cfg.observingParty,
      }),
      this.ledger.query<SettledTradeContract>({
        templateId: SETTLED_TRADE,
        observingParty: this.cfg.observingParty,
      }),
    ]);
    const live: TradeRow[] = [
      ...matched.map((t) => ({ ...t, templateId: MATCHED_TRADE })),
      ...settled.map(settledAsTrade),
    ];
    const known = new Set(
      (this.db.prepare("SELECT tradeCid FROM trades").all() as Array<{
        tradeCid: string;
      }>).map((r) => r.tradeCid),
    );
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO trades
       (tradeCid, ts, pair, baseAdmin, quoteAdmin, trader, dealer, counterparty,
        policyVersion, acceptedRank, consideredCount, payload)
       VALUES (@tradeCid, @ts, @pair, @baseAdmin, @quoteAdmin, @trader, @dealer,
        @counterparty, @policyVersion, @acceptedRank, @consideredCount, @payload)`,
    );
    const event = this.db.prepare(
      `INSERT INTO events (ts, kind, templateId, contractId, party, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: TradeRow[]) => {
      for (const t of rows) {
        if (known.has(t.contractId)) continue;
        // Unwrap the admin-tagged legs to the underlying transfer legs, kept in
        // economic order (base first). The admin lives on the wrapper; the pair
        // label and parties come from each leg.
        const tradeLegs = t.tradeLegs ?? [];
        const legs = tradeLegs.map((tl) => tl.leg);
        // The trader does not follow leg direction: legs[0]'s sender flips
        // with the side, so reading both parties off it inverted every buy.
        // The venue-signed receipt names the dealer; the trader is the other
        // party. Both writers put the base leg first, so the pair reads off
        // leg order, but the roles never do.
        const legParties = Array.from(
          new Set(
            legs.flatMap((l) => [l.sender?.owner, l.receiver?.owner]).filter(Boolean),
          ),
        ) as Party[];
        const acceptedDealer = t.policyReceipt?.acceptedDealer ?? null;
        // `dealer` is a role only a receipt establishes; `counterparty` is
        // the other party either way, since /v1/trades serves named columns.
        const dealer = acceptedDealer;
        const trader = acceptedDealer
          ? (legParties.find((x) => x !== acceptedDealer) ?? null)
          : (legs[0]?.sender?.owner ?? null);
        const counterparty =
          legParties.find((x) => x !== trader) ?? null;
        const baseSym = legs[0]?.instrumentId ?? "";
        const quoteSym = legs[1]?.instrumentId ?? "";
        const pair = `${baseSym}/${quoteSym}`;
        // Full identity of each side: the admin travels on the leg wrapper, so a
        // trade under a same-symbol pair on another registry stays distinct.
        const baseAdmin = tradeLegs[0]?.admin ?? null;
        const quoteAdmin = tradeLegs[1]?.admin ?? null;
        insert.run({
          tradeCid: t.contractId,
          ts,
          pair,
          baseAdmin,
          quoteAdmin,
          trader,
          dealer,
          counterparty,
          policyVersion: t.policyReceipt?.policyVersion ?? null,
          acceptedRank: t.policyReceipt?.acceptedRank ?? null,
          consideredCount: t.policyReceipt?.consideredCount ?? null,
          payload: JSON.stringify(t),
        });
        event.run(
          ts,
          "matched_trade",
          t.templateId,
          t.contractId,
          trader,
          JSON.stringify({ pair, trader, dealer }),
        );
      }
    });
    tx(live);
  }

  private async reconcilePools(ts: number): Promise<void> {
    const [configs, states] = await Promise.all([
      this.ledger.query<PoolConfigRow>({
        templateId: "CantonDex.Dex.Pool:Pool",
        observingParty: this.cfg.observingParty,
      }),
      this.ledger.query<PoolStateRow>({
        templateId: "CantonDex.Dex.PoolState:PoolState",
        observingParty: this.cfg.observingParty,
      }),
    ]);
    const cfgByPool = new Map(configs.map((c) => [c.poolId, c]));
    // The tracked "pool" row is keyed by the PoolState cid (the contract
    // that rotates), with instrument ids joined from the config.
    const live: PoolContract[] = states.flatMap((s) => {
      const cfg = cfgByPool.get(s.poolId);
      if (!cfg) return [];
      return [{
        contractId: s.contractId,
        baseInstrumentId: cfg.baseInstrumentId,
        quoteInstrumentId: cfg.quoteInstrumentId,
        status: s.status,
        reserves: s.reserves,
        totalLpSupply: s.totalLpSupply,
      }];
    });
    const known = new Map(
      (this.db
        .prepare(
          "SELECT poolCid, pairKey, baseReserve, quoteReserve, totalLpSupply FROM pool_states WHERE archived = 0",
        )
        .all() as Array<{
        poolCid: string;
        pairKey: string;
        baseReserve: string;
        quoteReserve: string;
        totalLpSupply: string;
      }>).map((r) => [r.poolCid, r]),
    );
    const liveCids = new Set(live.map((p) => p.contractId));

    const insertPool = this.db.prepare(
      `INSERT OR IGNORE INTO pool_states
       (poolCid, ts, pairKey, baseInstrumentId, quoteInstrumentId,
        baseAdmin, quoteAdmin, status, baseReserve, quoteReserve,
        totalLpSupply, predecessor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const markArchived = this.db.prepare(
      "UPDATE pool_states SET archived = 1 WHERE poolCid = ?",
    );
    const insertSwap = this.db.prepare(
      `INSERT INTO swaps (ts, oldPoolCid, newPoolCid, pair, baseDelta, quoteDelta, priceAfter, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const event = this.db.prepare(
      `INSERT INTO events (ts, kind, templateId, contractId, party, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      // Compute predecessor: for each NEW pool, find an archived pool with
      // the same (operator-implicit, base, quote) pair that vanished this
      // tick. If unique, link as predecessor and emit a swap.
      const archivedThisTick: Array<{
        cid: string;
        pairKey: string;
        baseReserve: string;
        quoteReserve: string;
        totalLpSupply: string;
      }> = [];
      for (const [cid, row] of known.entries()) {
        if (!liveCids.has(cid)) {
          archivedThisTick.push({
            cid,
            pairKey: row.pairKey,
            baseReserve: row.baseReserve,
            quoteReserve: row.quoteReserve,
            totalLpSupply: row.totalLpSupply,
          });
          markArchived.run(cid);
        }
      }

      for (const p of live) {
        if (known.has(p.contractId)) continue;
        const pairKey = pairIdentityKey(p.baseInstrumentId, p.quoteInstrumentId);
        const label = pairLabel(p.baseInstrumentId, p.quoteInstrumentId);
        const predecessors = archivedThisTick.filter(
          (a) => a.pairKey === pairKey,
        );
        const predecessor = predecessors.length === 1 ? predecessors[0]! : null;
        insertPool.run(
          p.contractId,
          ts,
          pairKey,
          p.baseInstrumentId.id,
          p.quoteInstrumentId.id,
          p.baseInstrumentId.admin,
          p.quoteInstrumentId.admin,
          p.status,
          p.reserves.baseAmount,
          p.reserves.quoteAmount,
          p.totalLpSupply,
          predecessor?.cid ?? null,
        );
        if (predecessor) {
          // Exact, scaled-integer arithmetic: parseFloat drifts by an ulp at
          // real magnitudes, and this feed is what clients reconcile against.
          // An unparseable reserve skips the row rather than throwing inside
          // the transaction or writing "NaN" into a NOT NULL column.
          let newBase: bigint;
          let newQuote: bigint;
          let oldBase: bigint;
          let oldQuote: bigint;
          try {
            newBase = dec.parseDecimal(p.reserves.baseAmount);
            newQuote = dec.parseDecimal(p.reserves.quoteAmount);
            oldBase = dec.parseDecimal(predecessor.baseReserve);
            oldQuote = dec.parseDecimal(predecessor.quoteReserve);
          } catch {
            console.warn(
              `[indexer] unparseable reserves on ${p.contractId}; skipping the rotation row`,
            );
            continue;
          }
          const baseDelta = dec.formatDecimal(newBase - oldBase);
          const quoteDelta = dec.formatDecimal(newQuote - oldQuote);

          // Which choice rotated the state. The indexer polls the ACS and
          // sees no choice name, so `totalLpSupply` is the discriminator: only
          // an add or a remove moves it. Exact, because float subtraction
          // collapses to 0 above ~2e6 and would call an LP mint a swap. An
          // unparseable supply falls back to the reserve signs rather than
          // matching `=== 0` and routing everything to "state_change".
          let lpDelta: bigint | null;
          try {
            lpDelta =
              dec.parseDecimal(p.totalLpSupply) -
              dec.parseDecimal(predecessor.totalLpSupply);
          } catch {
            lpDelta = null;
          }
          const bd = newBase - oldBase;
          const qd = newQuote - oldQuote;
          let kind: string;
          if (lpDelta === null) {
            // Supply unreadable: use the reserve directions. Both up is an
            // add, both down a remove -- the sign matters, not just agreement.
            if (bd > 0n && qd > 0n) kind = "add_liquidity";
            else if (bd < 0n && qd < 0n) kind = "remove_liquidity";
            else kind = "swap";
          } else if (lpDelta > 0n) {
            kind = "add_liquidity";
          } else if (lpDelta < 0n) {
            kind = "remove_liquidity";
          } else if (bd !== 0n || qd !== 0n) {
            // Either side alone: a dust swap can round one to zero.
            kind = "swap";
          } else {
            // Pause / resume: the state rotated, the numbers did not.
            kind = "state_change";
          }
          const price =
            newBase > 0n
              ? dec.formatDecimal(dec.div(newQuote, newBase))
              : dec.formatDecimal(0n);
          insertSwap.run(
            ts,
            predecessor.cid,
            p.contractId,
            label,
            baseDelta,
            quoteDelta,
            price,
            kind,
          );
          event.run(
            ts,
            kind,
            "CantonDex.Dex.PoolState:PoolState",
            p.contractId,
            this.cfg.observingParty,
            JSON.stringify({ pair: label, baseDelta, quoteDelta, price }),
          );
        }
      }
    });
    tx();
  }

  private async reconcileRfqs(ts: number): Promise<void> {
    const live = await this.ledger.query<RfqContract>({
      templateId: "CantonDex.Dex.Rfq:Rfq",
      observingParty: this.cfg.observingParty,
    });
    const liveIds = new Map(live.map((r) => [r.rfqId, r]));
    const seen = this.db
      .prepare(
        `SELECT rfqId, MAX(ts) as maxTs, status, trader, pair
         FROM rfq_history GROUP BY rfqId`,
      )
      .all() as Array<{
        rfqId: string;
        maxTs: number;
        status: string;
        trader: string | null;
        pair: string | null;
      }>;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO rfq_history
       (rfqId, ts, status, trader, pair, acceptedDealer, acceptedRank, policyVersion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      // Newly seen open RFQs; the stored pair is a display label.
      for (const r of live) {
        if (!seen.find((s) => s.rfqId === r.rfqId)) {
          const pair = pairLabel(r.baseInstrumentId, r.quoteInstrumentId);
          insert.run(r.rfqId, ts, "open", r.trader, pair, null, null, null);
        }
      }
      // RFQs that were open but have vanished — accepted or expired.
      // We can't distinguish here without an exercised-event stream;
      // mark as "closed" and rely on MatchedTrade row to populate the
      // accept side when present.
      for (const s of seen) {
        if (s.status !== "open") continue;
        if (!liveIds.has(s.rfqId)) {
          // Look for an accept signal in trades table.
          const trade = this.db
            .prepare(
              `SELECT acceptedRank, policyVersion, dealer
               FROM trades
               WHERE payload LIKE '%' || ? || '%'
               ORDER BY ts DESC LIMIT 1`,
            )
            .get(`"rfqId":"${s.rfqId}"`) as
            | {
                acceptedRank: number | null;
                policyVersion: string | null;
                dealer: string | null;
              }
            | undefined;
          if (trade?.acceptedRank != null) {
            // Carry trader and pair forward from the open row. A non-admin
            // caller can only query this table filtered by trader, so a
            // terminal row written with a null trader is unreachable: the
            // party sees their RFQ as "open" for ever.
            insert.run(
              s.rfqId,
              ts,
              "accepted",
              s.trader,
              s.pair,
              trade.dealer,
              trade.acceptedRank,
              trade.policyVersion,
            );
          } else {
            insert.run(s.rfqId, ts, "closed", s.trader, s.pair, null, null, null);
          }
        }
      }
    });
    tx();
  }
}
