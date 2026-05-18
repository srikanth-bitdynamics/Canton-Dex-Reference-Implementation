// Live price hooks. The operator backend's /v1/prices endpoint sources
// from pool mid (constant-product) → static PRICES env → undefined.
// The frontend never bakes constants — when no source has a price for
// a symbol, components render "—" rather than mislead the user.
//
// `usePrices` returns prices for a set of trading pairs.
// `useAssetPriceUsd` is the common case: USD price of one symbol
// (anchored on `${sym}/USDC`; USDC itself = 1).

import { useQuery } from '@tanstack/react-query';

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8080';

interface PriceQuote {
  pair: string;
  price: string;
  source: 'pool' | 'static' | 'feed';
  asOf: string;
}

async function fetchPrices(pairs: string[]): Promise<Record<string, number>> {
  if (pairs.length === 0) return {};
  const res = await fetch(
    `${API_BASE}/v1/prices?pairs=${pairs.map(encodeURIComponent).join(',')}`,
  );
  if (!res.ok) throw new Error(`/v1/prices ${res.status}`);
  const body = (await res.json()) as { prices: PriceQuote[] };
  const out: Record<string, number> = {};
  for (const p of body.prices) out[p.pair] = parseFloat(p.price);
  return out;
}

/**
 * Fetch live prices for the given pairs. Returns a map keyed by pair.
 * Missing pairs (no source has a price) are simply absent from the map.
 */
export function usePrices(pairs: string[]) {
  const sorted = [...pairs].sort().join(',');
  return useQuery({
    queryKey: ['prices', sorted],
    queryFn: () => fetchPrices(pairs),
    enabled: pairs.length > 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/**
 * USD price lookup helper. Anchored on `<sym>/USDC` per the same
 * convention used by the backend pricing service. USDC is 1.0 by
 * definition; everything else queries the live price endpoint.
 *
 * Returns `null` when no source has a price for the symbol — callers
 * should render "—" or "no price" rather than substitute a fallback.
 */
export function useAssetPricesUsd(symbols: string[]): {
  prices: Record<string, number | null>;
  loading: boolean;
} {
  const needed = [...new Set(symbols.filter((s) => s !== 'USDC'))];
  const pairs = needed.map((s) => `${s}/USDC`);
  const { data, isLoading } = usePrices(pairs);
  const out: Record<string, number | null> = { USDC: 1 };
  for (const sym of needed) {
    const p = data?.[`${sym}/USDC`];
    out[sym] = typeof p === 'number' ? p : null;
  }
  return { prices: out, loading: isLoading };
}
