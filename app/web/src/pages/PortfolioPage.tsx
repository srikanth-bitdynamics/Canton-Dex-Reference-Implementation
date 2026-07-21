import { useQuery } from '@tanstack/react-query';
import { Portfolio } from '@/components/Portfolio';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';
import type { TransactionEvent } from '@/types/contracts';
import { EmptyState } from '@/primitives/EmptyState';

export function PortfolioPage() {
  const party = useCurrentParty();
  const { data: holdings, isLoading } = useQuery({
    queryKey: ['holdings', party],
    queryFn: () => ledger.getHoldings(party!),
    enabled: !!party,
  });
  const { data: pools } = useQuery({
    queryKey: ['pools'],
    queryFn: ledger.getPools,
  });
  const { data: orders } = useQuery({
    queryKey: ['orders', party],
    queryFn: () => ledger.getOrders(party!),
    enabled: !!party,
  });

  // Activity feed: derive from the indexer's on-ledger swap history. (The
  // indexer records pool-reserve deltas, not the swapper party, so this is
  // pool-wide swap activity; the feed was previously an unwired stub.)
  const { data: swaps } = useQuery({
    queryKey: ['swaps', 'activity'],
    queryFn: async () => {
      try {
        const res = await fetch(
          (import.meta.env.VITE_API_BASE ?? 'http://localhost:8080') +
            '/v1/swaps?limit=50',
        );
        if (!res.ok) return [];
        return (await res.json()) as Array<{
          ts: number;
          pair: string;
          inputInstrumentId: string;
          outputInstrumentId: string;
          inputAmount: number;
          outputAmount: number;
        }>;
      } catch {
        return [];
      }
    },
    refetchInterval: 10_000,
  });

  const recentActivity: TransactionEvent[] = (swaps ?? []).map((s, i) => ({
    id: `swap-${s.ts}-${i}`,
    type: 'Swap',
    timestamp: new Date(s.ts).toISOString(),
    details: `${s.inputAmount} ${s.inputInstrumentId} → ${s.outputAmount.toFixed(2)} ${s.outputInstrumentId}`,
    status: 'Settled',
    amounts: [
      { asset: s.inputInstrumentId, amount: -s.inputAmount },
      { asset: s.outputInstrumentId, amount: s.outputAmount },
    ],
  }));

  if (!party) {
    return (
      <EmptyState title="No wallet connected">
        Connect a wallet to view holdings, LP positions, and on-ledger activity.
      </EmptyState>
    );
  }
  if (isLoading) {
    return (
      <EmptyState title="Loading portfolio">Reading holdings and activity for your party.</EmptyState>
    );
  }

  return (
    <Portfolio
      holdings={holdings ?? []}
      pools={pools ?? []}
      orders={orders ?? []}
      recentActivity={recentActivity}
    />
  );
}
