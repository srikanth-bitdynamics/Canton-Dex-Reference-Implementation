// 24h stats + price-history hooks.
//
// Backed by:
//   GET /v1/stats/24h?pair=BASE/QUOTE  → { priceChange24h, volume24h, swapCount24h }
//   GET /v1/price-history?pair=&hours= → { points: [{ts, price}, ...] }
//
// Both endpoints read from the SQLite indexer (`swaps` table). When
// the indexer has no rows for a pair, the hooks return `null` for
// the delta and `[]` for points. Callers should render "—" instead
// of fabricating a number.

import { useQuery } from '@tanstack/react-query';

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8080';

export interface Stats24h {
  pair: string;
  priceChange24h: number | null;
  volume24h: number | null;
  swapCount24h: number;
}

export function useStats24h(pair: string | null | undefined) {
  return useQuery({
    queryKey: ['stats24h', pair ?? ''],
    queryFn: async (): Promise<Stats24h | null> => {
      if (!pair) return null;
      const res = await fetch(
        `${API_BASE}/v1/stats/24h?pair=${encodeURIComponent(pair)}`,
      );
      if (!res.ok) return null;
      return (await res.json()) as Stats24h;
    },
    enabled: !!pair,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export interface PricePoint {
  ts: number;
  price: number;
}

export function usePriceHistory(
  pair: string | null | undefined,
  hours = 24,
) {
  return useQuery({
    queryKey: ['priceHistory', pair ?? '', hours],
    queryFn: async (): Promise<PricePoint[]> => {
      if (!pair) return [];
      const res = await fetch(
        `${API_BASE}/v1/price-history?pair=${encodeURIComponent(pair)}&hours=${hours}`,
      );
      if (!res.ok) return [];
      const body = (await res.json()) as { points: PricePoint[] };
      return body.points;
    },
    enabled: !!pair,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
