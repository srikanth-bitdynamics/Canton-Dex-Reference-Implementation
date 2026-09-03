// In-memory token-bucket rate limiter for the public write surface.
//
// The swap/liquidity request routes, the bootstrap issuer, and the
// allocation-factory endpoint became public in the bootstrap-bound phase, so
// they no longer sit behind the operator token. This limiter is their first
// line of defence against abuse. Buckets are keyed PRIMARILY by source IP (the
// hard-to-spoof dimension); a request that carries a bootstrap token is
// additionally metered per that token's `jti`, so one held token cannot hammer
// the bound flow even from rotating IPs. Body party ids are never used as a
// key — they are trivially spoofable.
//
// In-memory only: a single-process limiter, reset on restart. A multi-instance
// deployment should front this with a shared limiter, but the local guard is
// valuable on its own.

import type { IncomingMessage } from "node:http";

export interface RateLimitRule {
  /** Bucket size: the largest burst allowed. */
  capacity: number;
  /** Steady-state refill, tokens per second. */
  refillPerSec: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

// Defaults: generous enough for real interactive use, tight enough to blunt a
// script. Per IP, per minute.
export const RATE_LIMITS = {
  bootstrap: { capacity: 10, refillPerSec: 10 / 60 },
  request: { capacity: 30, refillPerSec: 30 / 60 },
  "allocation-factory": { capacity: 60, refillPerSec: 60 / 60 },
} satisfies Record<string, RateLimitRule>;

// The public write routes this limiter guards, mapped to their rule class.
// Settle routes and reads are intentionally absent.
const ROUTE_CLASS: Record<string, keyof typeof RATE_LIMITS> = {
  "POST /v1/session/bootstrap": "bootstrap",
  "POST /v1/pools/swap/request": "request",
  "POST /v1/pools/add-liquidity/request": "request",
  "POST /v1/pools/remove-liquidity/request": "request",
  "POST /v1/registry/allocation-factory": "allocation-factory",
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private takes = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Consume one token from `key`'s bucket. Returns false when it is empty. */
  take(key: string, rule: RateLimitRule): boolean {
    const t = this.now();
    // Amortized cleanup so idle buckets do not accumulate unbounded.
    if (++this.takes % 1024 === 0) this.sweep();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: rule.capacity, last: t };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = Math.max(0, (t - b.last) / 1000);
      b.tokens = Math.min(rule.capacity, b.tokens + elapsedSec * rule.refillPerSec);
      b.last = t;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drop buckets that have sat full (idle) for longer than `maxIdleMs`. */
  sweep(maxIdleMs = 10 * 60 * 1000): void {
    const t = this.now();
    for (const [key, b] of this.buckets) {
      if (t - b.last > maxIdleMs) this.buckets.delete(key);
    }
  }
}

/** The rule class for a public write route, or null when it is not limited. */
export function rateLimitClassFor(
  method: string,
  path: string,
): keyof typeof RATE_LIMITS | null {
  return ROUTE_CLASS[`${method} ${path}`] ?? null;
}

/** Best-effort source IP for keying. Falls back to a constant when unknown. */
export function clientIp(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

// The result of a rate-limit check: allowed, or the class that ran dry.
export type RateLimitCheck = { ok: true } | { ok: false; class: string };

/**
 * Enforce the IP-primary limit for a public write route, keyed by source IP —
 * the dimension an attacker cannot cheaply rotate. Called before dispatch.
 * A no-op (ok) for routes that are not limited.
 */
export function enforceRateLimit(
  limiter: RateLimiter,
  method: string,
  path: string,
  ip: string,
): RateLimitCheck {
  const cls = rateLimitClassFor(method, path);
  if (!cls) return { ok: true };
  if (!limiter.take(`${cls}|ip:${ip}`, RATE_LIMITS[cls])) return { ok: false, class: cls };
  return { ok: true };
}

/**
 * An additional per-bootstrap-token bucket for the request routes, enforced
 * alongside (not instead of) the IP limit: the IP bucket caps total volume from
 * a source regardless of how many tokens it holds, while this bucket caps how
 * hard any single token can drive the bound flow. `tokenKey` is a stable,
 * non-spoofable handle for the token (its jti or a hash).
 */
export function enforceTokenLimit(limiter: RateLimiter, tokenKey: string): RateLimitCheck {
  if (!limiter.take(`request|token:${tokenKey}`, RATE_LIMITS.request)) {
    return { ok: false, class: "request" };
  }
  return { ok: true };
}
