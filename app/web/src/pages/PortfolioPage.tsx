import { useQuery } from '@tanstack/react-query';
import { Portfolio } from '@/components/Portfolio';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';

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

  if (!party) {
    return (
      <div className="text-text-muted text-center py-12">
        Connect a wallet to view your portfolio.
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="text-text-muted text-center py-12">Loading portfolio...</div>
    );
  }

  return (
    <Portfolio
      holdings={holdings ?? []}
      pools={pools ?? []}
      orders={orders ?? []}
      recentActivity={[]}
    />
  );
}
