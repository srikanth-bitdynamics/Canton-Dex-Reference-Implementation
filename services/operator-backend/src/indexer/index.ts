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
import type { Party } from "../types.js";

type LedgerQuery = Pick<LedgerSubmitter, "query">;

interface MatchedTradeContract {
  contractId: string;
  venue: Party;
  admin: Party;
  transferLegs?: Array<{
    transferLegId: string;
    sender: { owner: Party };
    receiver: { owner: Party };
    amount: string;
    instrumentId: string;
  }>;
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

// DEX-40/41: the contract that rotates on every pool op is now PoolState
// (Pool config is immutable). We track PoolState transitions for swap
// detection, joining Pool config by poolId for the instrument ids.
interface PoolConfigRow {
  contractId: string;
  poolId: string;
  baseInstrumentId: string;
  quoteInstrumentId: string;
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
  baseInstrumentId: string;
  quoteInstrumentId: string;
  status: string;
  reserves: { baseAmount: string; quoteAmount: string };
  totalLpSupply: string;
}

interface RfqContract {
  contractId: string;
  trader: Party;
  rfqId: string;
  pair: string;
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
    const live = await this.ledger.query<MatchedTradeContract>({
      templateId: "CantonDex.Dex.MatchedTrade:MatchedTrade",
      observingParty: this.cfg.observingParty,
    });
    const known = new Set(
      (this.db.prepare("SELECT tradeCid FROM trades").all() as Array<{
        tradeCid: string;
      }>).map((r) => r.tradeCid),
    );
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO trades
       (tradeCid, ts, pair, trader, dealer, policyVersion,
        acceptedRank, consideredCount, payload)
       VALUES (@tradeCid, @ts, @pair, @trader, @dealer, @policyVersion,
        @acceptedRank, @consideredCount, @payload)`,
    );
    const event = this.db.prepare(
      `INSERT INTO events (ts, kind, templateId, contractId, party, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: MatchedTradeContract[]) => {
      for (const t of rows) {
        if (known.has(t.contractId)) continue;
        const legs = t.transferLegs ?? [];
        const trader = legs[0]?.sender?.owner ?? legs[0]?.receiver?.owner ?? null;
        const dealer = legs[0]?.receiver?.owner ?? null;
        const baseSym = legs[0]?.instrumentId ?? "";
        const quoteSym = legs[1]?.instrumentId ?? "";
        const pair = `${baseSym}/${quoteSym}`;
        insert.run({
          tradeCid: t.contractId,
          ts,
          pair,
          trader,
          dealer,
          policyVersion: t.policyReceipt?.policyVersion ?? null,
          acceptedRank: t.policyReceipt?.acceptedRank ?? null,
          consideredCount: t.policyReceipt?.consideredCount ?? null,
          payload: JSON.stringify(t),
        });
        event.run(
          ts,
          "matched_trade",
          "CantonDex.Dex.MatchedTrade:MatchedTrade",
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
          "SELECT poolCid, pairKey, baseReserve, quoteReserve FROM pool_states WHERE archived = 0",
        )
        .all() as Array<{
        poolCid: string;
        pairKey: string;
        baseReserve: string;
        quoteReserve: string;
      }>).map((r) => [r.poolCid, r]),
    );
    const liveCids = new Set(live.map((p) => p.contractId));

    const insertPool = this.db.prepare(
      `INSERT OR IGNORE INTO pool_states
       (poolCid, ts, pairKey, baseInstrumentId, quoteInstrumentId,
        status, baseReserve, quoteReserve, totalLpSupply, predecessor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const markArchived = this.db.prepare(
      "UPDATE pool_states SET archived = 1 WHERE poolCid = ?",
    );
    const insertSwap = this.db.prepare(
      `INSERT INTO swaps (ts, oldPoolCid, newPoolCid, pair, baseDelta, quoteDelta, priceAfter)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      }> = [];
      for (const [cid, row] of known.entries()) {
        if (!liveCids.has(cid)) {
          archivedThisTick.push({
            cid,
            pairKey: row.pairKey,
            baseReserve: row.baseReserve,
            quoteReserve: row.quoteReserve,
          });
          markArchived.run(cid);
        }
      }

      for (const p of live) {
        if (known.has(p.contractId)) continue;
        const pairKey = `${p.baseInstrumentId}/${p.quoteInstrumentId}`;
        const predecessors = archivedThisTick.filter(
          (a) => a.pairKey === pairKey,
        );
        const predecessor = predecessors.length === 1 ? predecessors[0]! : null;
        insertPool.run(
          p.contractId,
          ts,
          pairKey,
          p.baseInstrumentId,
          p.quoteInstrumentId,
          p.status,
          p.reserves.baseAmount,
          p.reserves.quoteAmount,
          p.totalLpSupply,
          predecessor?.cid ?? null,
        );
        if (predecessor) {
          const baseDelta = (
            parseFloat(p.reserves.baseAmount) -
            parseFloat(predecessor.baseReserve)
          ).toFixed(10);
          const quoteDelta = (
            parseFloat(p.reserves.quoteAmount) -
            parseFloat(predecessor.quoteReserve)
          ).toFixed(10);
          const price =
            parseFloat(p.reserves.baseAmount) > 0
              ? (
                  parseFloat(p.reserves.quoteAmount) /
                  parseFloat(p.reserves.baseAmount)
                ).toFixed(10)
              : "0";
          insertSwap.run(
            ts,
            predecessor.cid,
            p.contractId,
            pairKey,
            baseDelta,
            quoteDelta,
            price,
          );
          event.run(
            ts,
            "pool_swap",
            "CantonDex.Dex.PoolState:PoolState",
            p.contractId,
            this.cfg.observingParty,
            JSON.stringify({ pair: pairKey, baseDelta, quoteDelta, price }),
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
        "SELECT rfqId, MAX(ts) as maxTs, status FROM rfq_history GROUP BY rfqId",
      )
      .all() as Array<{ rfqId: string; maxTs: number; status: string }>;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO rfq_history
       (rfqId, ts, status, trader, pair, acceptedDealer, acceptedRank, policyVersion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      // Newly seen open RFQs.
      for (const r of live) {
        if (!seen.find((s) => s.rfqId === r.rfqId)) {
          insert.run(r.rfqId, ts, "open", r.trader, r.pair, null, null, null);
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
            insert.run(
              s.rfqId,
              ts,
              "accepted",
              null,
              null,
              trade.dealer,
              trade.acceptedRank,
              trade.policyVersion,
            );
          } else {
            insert.run(s.rfqId, ts, "closed", null, null, null, null, null);
          }
        }
      }
    });
    tx();
  }
}
