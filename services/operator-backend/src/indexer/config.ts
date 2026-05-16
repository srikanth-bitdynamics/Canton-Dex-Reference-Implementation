// Operator config kv store. Mutable runtime knobs (dealer whitelist,
// RFQ policy fee bps, feature flags) without redeploys.
//
// Auth: writes require a shared bearer token (env: OPERATOR_ADMIN_TOKEN).
// This is intentionally simple — production should wire OIDC / mTLS in
// front of /v1/admin/* via a reverse proxy.

import type { Db } from "./db.js";

export class OperatorConfig {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM operator_kv WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  getJson<T = unknown>(key: string): T | undefined {
    const v = this.get(key);
    return v ? (JSON.parse(v) as T) : undefined;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO operator_kv (key, value, updatedAt)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updatedAt = excluded.updatedAt`,
      )
      .run(key, value, Date.now());
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM operator_kv WHERE key = ?").run(key);
  }

  list(): Array<{ key: string; value: string; updatedAt: number }> {
    return this.db
      .prepare("SELECT key, value, updatedAt FROM operator_kv ORDER BY key")
      .all() as Array<{ key: string; value: string; updatedAt: number }>;
  }
}
