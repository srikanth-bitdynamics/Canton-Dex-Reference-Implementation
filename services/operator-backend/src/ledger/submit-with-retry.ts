// Retry helper for UTXO contention. The contention error is
// retryable; everything else is not.

import { LedgerError } from "./index.js";

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export async function retryOnContention<T>(
  attempt: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 5;
  let delay = opts.initialDelayMs ?? 50;
  const maxDelay = opts.maxDelayMs ?? 1000;
  let lastErr: unknown;
  for (let i = 0; i < max; i++) {
    try {
      return await attempt();
    } catch (e) {
      lastErr = e;
      if (e instanceof LedgerError && e.kind === "contention") {
        await sleep(delay);
        delay = Math.min(maxDelay, Math.floor(delay * 2));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
