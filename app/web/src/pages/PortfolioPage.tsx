import { useQuery } from '@tanstack/react-query';
import { Portfolio } from '@/components/Portfolio';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';
import type { TransactionEvent } from '@/types/contracts';
import { EmptyState } from '@/primitives/EmptyState';
import { fmt } from '@/primitives/format';

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

  // The indexer records pool-reserve deltas rather than swapper identity, so
  // this feed shows pool-wide swap activity.
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
          // Decimal strings, exactly as the ledger holds them.
          inputAmount: string;
          outputAmount: string;
        }>;
      } catch {
        return [];
      }
    },
    refetchInterval: 10_000,
  });

  const recentActivity: TransactionEvent[] = (swaps ?? []).map((s, i) => {
    const paid = Number(s.inputAmount);
    const received = Number(s.outputAmount);
    return {
      id: `swap-${s.ts}-${i}`,
      type: 'Swap',
      timestamp: new Date(s.ts).toISOString(),
      details: `${fmt(paid, 4)} ${s.inputInstrumentId} → ${fmt(received)} ${s.outputInstrumentId}`,
      status: 'Settled',
    };
  });

  if (!party) {
    return (
      <EmptyState title="No wallet connected">
        Connect a wallet to view backend-reported holdings, LP positions, and activity.
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
