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
  SubmitReceipt,
  SubmitRequest,
  SubscriptionFilter,
  LedgerEvent,
  CreatedEventRef,
} from "../ledger/index.js";
import type { Party } from "@canton-dex/registry-client";

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
    return this.once(req, () => this.inner.submit<R>(req));
  }

  /**
   * Forward the updateId-reporting submission to the inner ledger under the
   * same row lock as `submit`. Delegating it unguarded would quietly drop
   * idempotency for whichever flows use it; falling back to `submit` when the
   * inner driver has no updateId to report keeps the wrapper transparent.
   */
  async submitWithUpdateId<R>(req: SubmitRequest): Promise<SubmitReceipt<R>> {
    const inner = this.inner.submitWithUpdateId;
    if (!inner) {
      return { result: await this.submit<R>(req), updateId: null };
    }
    return this.once(req, () => inner.call(this.inner, req) as Promise<SubmitReceipt<R>>);
  }

  /**
   * Run `exec` at most once per commandId: cached result on replay, refusal
   * while one is in flight, retry after an error or a stale pending row.
   */
  private async once<T>(req: SubmitRequest, exec: () => Promise<T>): Promise<T> {
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
      //
      // Relaxed for an EXERCISE row that recorded an error. Those commandIds
      // are derived from the contract acted on (`order-cancel:<cid>`,
      // `lp-add-settle:<cid>`), so one failure followed by any change to the
      // request — a re-resolved factory, a different disclosure set, a code
      // change — would leave that order uncancellable and that settlement
      // unsettleable for good. The choice is consuming, so a retry that finds
      // the contract already archived fails rather than acting twice.
      //
      // NOT relaxed for a create. `pool-create:<base>:<quote>` and
      // `pool-state-create:<poolId>` are keyed on names, and neither Pool nor
      // PoolState declares a Daml contract key, so nothing on-ledger prevents
      // a duplicate. A create that committed but lost its response leaves an
      // `error` row; letting a changed-arg retry through would then produce a
      // second Pool for the same pair. Here the guard is the only protection
      // there is.
      const retryableError =
        existing.status === "error" && req.command.kind === "exercise";
      if (
        !retryableError &&
        existing.argsHash !== null &&
        existing.argsHash !== argsHash
      ) {
        throw new Error(
          `idempotency: commandId ${req.commandId} replayed with different args`,
        );
      }
      if (existing.status === "ok" && existing.resultJson) {
        return JSON.parse(existing.resultJson) as T;
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
      const result = await exec();
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

  // Forward operator-discovery recovery to the inner ledger. Without this the
  // wrapper silently drops the optional method, breaking updateId-only wallet
  // settle (CIP-0103 SDK + PartyLayer) which recover created cids from the tree.
  treeCreatedEvents(updateId: string, party: Party): Promise<CreatedEventRef[]> {
    if (!this.inner.treeCreatedEvents) {
      throw new Error("inner ledger does not support treeCreatedEvents");
    }
    return this.inner.treeCreatedEvents(updateId, party);
  }

  /** Delete rows older than TTL. Call periodically. */
  sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    this.db
      .prepare("DELETE FROM command_submissions WHERE submittedAt < ?")
      .run(cutoff);
  }
}
