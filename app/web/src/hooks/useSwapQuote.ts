import { useQuery } from '@tanstack/react-query';
import { ledger } from '@/services/ledger';
import type { InstrumentId } from '@/types/contracts';

export function useSwapQuote(
  poolId: string | null,
  // Full instrument identity, so a same-symbol cross-admin pair quotes the
  // correct side; the bare id alone is ambiguous and the backend rejects it.
  inputInstrument: InstrumentId | null,
  inputAmount: number | null,
) {
  return useQuery({
    queryKey: [
      'swap-quote',
      poolId,
      inputInstrument?.admin,
      inputInstrument?.id,
      inputAmount,
    ],
    queryFn: () => ledger.computeSwapQuote(poolId!, inputInstrument!, inputAmount!),
    enabled: !!poolId && !!inputInstrument && !!inputAmount && inputAmount > 0,
    refetchInterval: 5000,
    staleTime: 3000,
  });
}
