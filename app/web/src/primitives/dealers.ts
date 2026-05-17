// Dealer registry — fetched from the operator backend at runtime.
//
// No hardcoded list lives in the frontend. The backend's
// `DealersService` (SQLite-backed) is the single source of truth;
// admins manage it via `PUT /v1/admin/dealers` and the dApp reads
// via `GET /v1/dealers`.
//
// Consumers should use `useDealers()` (React Query hook) so re-renders
// stay in sync with admin changes; ad-hoc helpers like
// `dealerByParty()` take an explicit dealer list so they don't fetch
// behind the caller's back.

import { useQuery } from '@tanstack/react-query';

export interface Dealer {
  party: string;
  name: string;
  trusted: boolean;
  whitelisted: boolean;
  /** Round-trip latency in milliseconds. Null until measured. */
  latencyMs: number | null;
  /** Observed fill rate 0..1. Null until measured. */
  fillRate: number | null;
}

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8080';

async function fetchDealers(): Promise<Dealer[]> {
  const res = await fetch(`${API_BASE}/v1/dealers`);
  if (!res.ok) {
    // Surface the failure rather than masking it with stale data.
    throw new Error(`/v1/dealers returned ${res.status}`);
  }
  return (await res.json()) as Dealer[];
}

/**
 * React Query hook: returns the live dealer list. Refetches on focus
 * and every 30s so admin edits propagate without a full reload.
 */
export function useDealers() {
  return useQuery({
    queryKey: ['dealers'],
    queryFn: fetchDealers,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/**
 * Lookup helper. Takes the dealer list explicitly so callers don't
 * accidentally fan out fetches. Falls back to a stub derived from the
 * party id when the dealer isn't in the list (e.g., a dealer who
 * quoted before the operator added them to the registry).
 */
export function dealerByParty(
  party: string | undefined | null,
  list: Dealer[] | undefined,
): Dealer {
  const found = list?.find((d) => d.party === party);
  if (found) return found;
  return {
    party: party ?? '',
    name: party ? (party.split('::')[0] ?? party) : '—',
    trusted: false,
    whitelisted: false,
    latencyMs: null,
    fillRate: null,
  };
}
