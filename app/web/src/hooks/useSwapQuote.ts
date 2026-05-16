import { useQuery } from '@tanstack/react-query';
import { ledger } from '@/services/ledger';

export function useSwapQuote(
  poolId: string | null,
  inputInstrumentId: string | null,
  inputAmount: number | null,
) {
  return useQuery({
    queryKey: ['swap-quote', poolId, inputInstrumentId, inputAmount],
    queryFn: () => ledger.computeSwapQuote(poolId!, inputInstrumentId!, inputAmount!),
    enabled: !!poolId && !!inputInstrumentId && !!inputAmount && inputAmount > 0,
    refetchInterval: 5000,
    staleTime: 3000,
  });
}
