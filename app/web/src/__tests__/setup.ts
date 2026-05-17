// Global test setup: jest-dom matchers + a default fetch mock that
// returns shaped responses for the operator backend's read endpoints.
// Individual tests can override per-call by reassigning global.fetch.

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

const DEFAULT_RESPONSES: Record<string, unknown> = {
  '/v1/status': { network: 'canton:test', slot: 1234, synced: true, serverTime: '2026-05-17T00:00:00Z' },
  '/v1/context': {
    operator: 'op::1',
    lpRegistrar: 'lp::1',
    admin: 'ad::1',
    allocationFactoryCid: 'fac:1',
    settlementFactoryCid: 'set:1',
    network: 'canton:test',
  },
  '/v1/pools': [],
  '/v1/pairs': [],
  '/v1/orders': [],
  '/v1/holdings': [],
  '/v1/rfq': { rfqs: [], quotes: [] },
  '/v1/rfq/history': [],
  '/v1/trades': [],
  '/v1/swaps': [],
};

function findMatch(url: string): unknown | undefined {
  const path = new URL(url, 'http://test').pathname;
  if (path in DEFAULT_RESPONSES) return DEFAULT_RESPONSES[path];
  return undefined;
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = findMatch(url);
    if (body === undefined) {
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
