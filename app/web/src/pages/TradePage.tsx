import { useQuery } from '@tanstack/react-query';
import { SwapCard } from '@/components/SwapCard';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';

export function TradePage() {
  const party = useCurrentParty();
  const { data: pools } = useQuery({
    queryKey: ['pools'],
    queryFn: ledger.getPools,
  });

  const { data: holdings } = useQuery({
    queryKey: ['holdings', party],
    queryFn: () => ledger.getHoldings(party!),
    enabled: !!party,
  });

  const activePool = pools?.find(p => p.status === 'Active');

  const balances: Record<string, number> = {};
  holdings?.forEach(h => {
    if (!h.locked) {
      balances[h.instrumentId] =
        (balances[h.instrumentId] ?? 0) + parseFloat(h.amount as unknown as string);
    }
  });

  if (!activePool) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-text-muted font-sans text-center">
          <div className="text-2xl mb-2">No active pools</div>
          <div className="text-sm">Create a pool in the Admin panel to start trading</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-center pt-12">
      <SwapCard pool={activePool} userBalances={balances} />
    </div>
  );
}
