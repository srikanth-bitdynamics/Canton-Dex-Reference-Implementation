// Dealer registry. The operator owns the list of RFQ counterparties:
// who can quote, whose quotes get the "trusted" tier bump in the
// matching policy, and per-dealer telemetry (latency, fill rate) that
// the UI surfaces during compose.
//
// Backed by the SQLite indexer DB. Read-only consumers query
// `list()`; admin endpoints call `upsert()` / `remove()` behind the
// bearer-token auth middleware.
//
// Why this is a separate module from `OperatorConfig`: dealers are
// row-shaped (party id + a handful of fields), not flat key-value.
// Keeping them in their own table makes admin UIs simpler and lets
// the indexer fill in telemetry (latencyMs, fillRate) from observed
// trade events later without colliding with config keys.

import type { Db } from "../indexer/db.js";

export interface Dealer {
  party: string;
  name: string;
  trusted: boolean;
  whitelisted: boolean;
  /** Round-trip latency in milliseconds. Null until measured. */
  latencyMs: number | null;
  /** Observed fill rate 0..1 across the dealer's quotes. Null until measured. */
  fillRate: number | null;
}

interface DealerRow {
  party: string;
  name: string;
  trusted: number;
  whitelisted: number;
  latencyMs: number | null;
  fillRate: number | null;
}

function rowToDealer(r: DealerRow): Dealer {
  return {
    party: r.party,
    name: r.name,
    trusted: r.trusted === 1,
    whitelisted: r.whitelisted === 1,
    latencyMs: r.latencyMs,
    fillRate: r.fillRate,
  };
}

export class DealersService {
  constructor(private readonly db: Db) {}

  list(): Dealer[] {
    const rows = this.db
      .prepare(
        "SELECT party, name, trusted, whitelisted, latencyMs, fillRate FROM dealers ORDER BY name",
      )
      .all() as DealerRow[];
    return rows.map(rowToDealer);
  }

  get(party: string): Dealer | null {
    const row = this.db
      .prepare(
        "SELECT party, name, trusted, whitelisted, latencyMs, fillRate FROM dealers WHERE party = ?",
      )
      .get(party) as DealerRow | undefined;
    return row ? rowToDealer(row) : null;
  }

  /**
   * Insert or update by party. Fields that aren't provided keep their
   * previous values on update so the admin can patch one field at a
   * time without resetting the others to defaults.
   */
  upsert(input: {
    party: string;
    name?: string;
    trusted?: boolean;
    whitelisted?: boolean;
    latencyMs?: number | null;
    fillRate?: number | null;
  }): Dealer {
    const now = Date.now();
    const existing = this.get(input.party);
    const next: Dealer = {
      party: input.party,
      name: input.name ?? existing?.name ?? input.party.split("::")[0]!,
      trusted: input.trusted ?? existing?.trusted ?? false,
      whitelisted: input.whitelisted ?? existing?.whitelisted ?? true,
      latencyMs:
        input.latencyMs !== undefined ? input.latencyMs : existing?.latencyMs ?? null,
      fillRate:
        input.fillRate !== undefined ? input.fillRate : existing?.fillRate ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO dealers (party, name, trusted, whitelisted, latencyMs, fillRate, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT createdAt FROM dealers WHERE party = ?), ?), ?)
         ON CONFLICT(party) DO UPDATE SET
           name = excluded.name,
           trusted = excluded.trusted,
           whitelisted = excluded.whitelisted,
           latencyMs = excluded.latencyMs,
           fillRate = excluded.fillRate,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        next.party,
        next.name,
        next.trusted ? 1 : 0,
        next.whitelisted ? 1 : 0,
        next.latencyMs,
        next.fillRate,
        next.party,
        now,
        now,
      );
    return next;
  }

  remove(party: string): boolean {
    const result = this.db.prepare("DELETE FROM dealers WHERE party = ?").run(party);
    return result.changes > 0;
  }

  /**
   * Seed dealers from a JSON array if the table is currently empty.
   * Used at startup so a fresh DB has something useful; once any
   * dealer exists, the operator owns the list.
   */
  seedIfEmpty(initial: Array<Partial<Dealer> & { party: string }>): void {
    const count = (
      this.db.prepare("SELECT COUNT(*) as n FROM dealers").get() as { n: number }
    ).n;
    if (count > 0) return;
    for (const d of initial) this.upsert(d);
  }
}
