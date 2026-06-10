// Idempotency wrapper for ledger command submission.
//
// Why: the operator-backend submits commands under deterministic
// `commandId`s. If the backend crashes mid-submit and the dApp retries,
// we want to either (a) return the previously cached result if we have
// it, or (b) detect that a same-commandId submit is already in flight
// and refuse to double-fire.
//
// Mechanism:
//   - Each submit() takes a row lock by inserting a 'pending' row keyed
//     on commandId. If the row already exists with status='ok' we
//     return the cached result. If status='pending' and not stale we
//     reject as already-in-flight. If 'error' or stale-pending we
//     overwrite and retry.
//   - On success we update the row to 'ok' with the JSON result.
//   - On error we update to 'error' so the same commandId can be
//     retried after the caller decides what to do.
//
// TTL: rows older than the configured TTL are eligible for overwrite.
// We also expose a sweep() to delete old rows on demand.

import { createHash } from "node:crypto";

import type { Db } from "./db.js";
import type {
  LedgerSubmitter,
  SubmitRequest,
  SubscriptionFilter,
  LedgerEvent,
} from "../ledger/index.js";

const PENDING_STALE_MS = 60_000;
const TTL_MS = 24 * 60 * 60 * 1000;

// Hash of the request args (command + acting parties). Used to detect a
// replay: same commandId, different content.
export function hashSubmitRequest(req: SubmitRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: req.command,
        actAs: req.actAs ?? [],
        readAs: req.readAs ?? [],
      }),
    )
    .digest("hex");
}

export class IdempotentLedger implements LedgerSubmitter {
  constructor(
    private readonly inner: LedgerSubmitter,
    private readonly db: Db,
  ) {}

  async submit<R>(req: SubmitRequest): Promise<R> {
    const now = Date.now();
    const argsHash = hashSubmitRequest(req);
    const existing = this.db
      .prepare(
        "SELECT submittedAt, status, resultJson, argsHash FROM command_submissions WHERE commandId = ?",
      )
      .get(req.commandId) as
      | {
          submittedAt: number;
          status: "pending" | "ok" | "error";
          resultJson: string | null;
          argsHash: string | null;
        }
      | undefined;

    if (existing) {
      // Replay guard: the same commandId with different args is a
      // conflict — a deterministic commandId must map to exactly one request.
      // Reject rather than serving a stale cached result or re-firing. (A
      // legacy row predating the argsHash column has argsHash === null; treat
      // it as unknown and let it proceed/overwrite.)
      if (existing.argsHash !== null && existing.argsHash !== argsHash) {
        throw new Error(
          `idempotency: commandId ${req.commandId} replayed with different args`,
        );
      }
      if (existing.status === "ok" && existing.resultJson) {
        return JSON.parse(existing.resultJson) as R;
      }
      if (
        existing.status === "pending" &&
        now - existing.submittedAt < PENDING_STALE_MS
      ) {
        throw new Error(
          `idempotency: commandId ${req.commandId} already in flight`,
        );
      }
      // Stale-pending or prior-error: overwrite and retry.
    }

    this.db
      .prepare(
        `INSERT INTO command_submissions (commandId, submittedAt, status, argsHash)
         VALUES (?, ?, 'pending', ?)
         ON CONFLICT(commandId) DO UPDATE SET
           submittedAt = excluded.submittedAt,
           status = 'pending',
           resultJson = NULL,
           completedAt = NULL,
           argsHash = excluded.argsHash`,
      )
      .run(req.commandId, now, argsHash);

    try {
      const result = await this.inner.submit<R>(req);
      this.db
        .prepare(
          `UPDATE command_submissions
           SET status='ok', resultJson=?, completedAt=?
           WHERE commandId=?`,
        )
        .run(JSON.stringify(result ?? null), Date.now(), req.commandId);
      return result;
    } catch (err) {
      this.db
        .prepare(
          `UPDATE command_submissions
           SET status='error', resultJson=?, completedAt=?
           WHERE commandId=?`,
        )
        .run(
          JSON.stringify({ error: String((err as Error).message ?? err) }),
          Date.now(),
          req.commandId,
        );
      throw err;
    }
  }

  subscribe<T>(filter: SubscriptionFilter): AsyncIterable<LedgerEvent<T>> {
    return this.inner.subscribe<T>(filter);
  }

  query<T>(filter: SubscriptionFilter): Promise<T[]> {
    return this.inner.query<T>(filter);
  }

  /** Delete rows older than TTL. Call periodically. */
  sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    this.db
      .prepare("DELETE FROM command_submissions WHERE submittedAt < ?")
      .run(cutoff);
  }
}
