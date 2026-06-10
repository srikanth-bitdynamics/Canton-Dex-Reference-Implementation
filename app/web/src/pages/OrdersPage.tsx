import { useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { OrderBook } from '@/components/OrderBook';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';
import { useToast } from '@/primitives/ToastProvider';

export function OrdersPage() {
  const queryClient = useQueryClient();
  const party = useCurrentParty();
  const toast = useToast();
  const [side, setSide] = useState<'Bid' | 'Ask'>('Bid');
  const [limitPrice, setLimitPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [placeError, setPlaceError] = useState<string | null>(null);

  const { data: pairs } = useQuery({ queryKey: ['pairs'], queryFn: ledger.getPairs });
  const activePair = pairs?.[0];

  const { data: context } = useQuery({
    queryKey: ['context'],
    queryFn: ledger.getContext,
  });

  const { data: orders } = useQuery({
    queryKey: ['orders', party],
    queryFn: () => ledger.getOrders(party!),
    enabled: !!party,
    refetchInterval: 5000,
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => {
      toast.push(`Cancel order ${id.slice(0, 10)}…`, 'cancelOrder', () =>
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
      );
      return ledger.cancelOrder(id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });

  // Track the in-flight place-order toast so onError can dismiss it and show
  // the failure instead of leaving a success-looking lifecycle card.
  const placeToastId = useRef<number | null>(null);

  const placeMutation = useMutation({
    mutationFn: async (params: Parameters<typeof ledger.placeOrder>[0]) => {
      const id = toast.push(
        `${params.side === 'Bid' ? 'BUY' : 'SELL'} ${params.quantity} ${params.pairBase} @ ${params.limitPrice}`,
        'placeOrder',
        () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
      );
      placeToastId.current = id;
      // Advance the toast on real pipeline step completion rather than the
      // cosmetic timer.
      return ledger.placeOrder({
        ...params,
        onProgress: (phase) => toast.setPhase(id, phase),
      });
    },
    onSuccess: () => {
      placeToastId.current = null;
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      setLimitPrice('');
      setQuantity('');
    },
    onError: (error) => {
      // The mutationFn pushed an optimistic lifecycle toast; on failure that
      // toast would otherwise advance to "success" on its timer. Dismiss it and
      // surface the real error.
      if (placeToastId.current != null) {
        toast.dismiss(placeToastId.current);
        placeToastId.current = null;
      }
      setPlaceError(error instanceof Error ? error.message : 'Order placement failed');
    },
  });

  const handlePlace = useCallback(() => {
    setPlaceError(null);
    if (!activePair || !context) return;
    const price = parseFloat(limitPrice);
    const qty = parseFloat(quantity);
    // Explicit NaN guards: `NaN <= 0` is false, so a blank/garbage field would
    // otherwise slip past a bare `<= 0` check.
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) {
      setPlaceError('Enter a valid positive limit price and amount.');
      return;
    }
    placeMutation.mutate({
      context,
      pairBase: activePair.baseInstrumentId,
      pairQuote: activePair.quoteInstrumentId,
      side,
      limitPrice: price,
      quantity: qty,
      expiry: null,
    });
  }, [activePair, context, side, limitPrice, quantity, placeMutation]);

  const pairOrders = orders?.filter(
    o => activePair && o.baseInstrumentId === activePair.baseInstrumentId && o.quoteInstrumentId === activePair.quoteInstrumentId
  ) ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Order Book */}
      <div>
        {activePair ? (
          <OrderBook
            pair={{ base: activePair.baseInstrumentId, quote: activePair.quoteInstrumentId }}
            orders={pairOrders}
            onCancelOrder={id => cancelMutation.mutate(id)}
          />
        ) : (
          <div className="bg-surface-card rounded-lg border border-surface-border p-8 text-text-muted text-center font-sans">
            No trading pairs available
          </div>
        )}
      </div>

      {/* Place Order */}
      <div className="bg-surface-card rounded-lg border border-surface-border p-5">
        <h3 className="text-text-primary font-sans font-semibold mb-4">Place Order</h3>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setSide('Bid')}
            className={`flex-1 py-2 rounded-lg text-sm font-sans font-medium transition-colors ${
              side === 'Bid'
                ? 'bg-accent-green text-white'
                : 'bg-surface-hover text-text-secondary hover:text-text-primary'
            }`}
          >
            Buy
          </button>
          <button
            onClick={() => setSide('Ask')}
            className={`flex-1 py-2 rounded-lg text-sm font-sans font-medium transition-colors ${
              side === 'Ask'
                ? 'bg-accent-red text-white'
                : 'bg-surface-hover text-text-secondary hover:text-text-primary'
            }`}
          >
            Sell
          </button>
        </div>

        <div className="space-y-3 mb-4">
          <div>
            <label className="text-text-secondary text-sm font-sans block mb-1">Limit price</label>
            <input
              type="number"
              value={limitPrice}
              onChange={e => setLimitPrice(e.target.value)}
              placeholder="0.00"
              className="w-full bg-surface border border-surface-border rounded-lg px-4 py-2.5 text-text-primary font-mono focus:outline-none focus:border-accent-blue"
            />
          </div>
          <div>
            <label className="text-text-secondary text-sm font-sans block mb-1">
              Amount ({activePair?.baseInstrumentId ?? 'BASE'})
            </label>
            <input
              type="number"
              value={quantity}
              onChange={e => setQuantity(e.target.value)}
              placeholder="0.00"
              className="w-full bg-surface border border-surface-border rounded-lg px-4 py-2.5 text-text-primary font-mono focus:outline-none focus:border-accent-blue"
            />
          </div>
          {limitPrice && quantity && (
            <div className="flex justify-between text-sm text-text-secondary font-sans">
              <span>Total</span>
              <span className="font-mono">
                {(parseFloat(limitPrice) * parseFloat(quantity)).toFixed(2)} {activePair?.quoteInstrumentId ?? 'QUOTE'}
              </span>
            </div>
          )}
        </div>

        {placeError && (
          <div
            className="mb-3 rounded px-3 py-2 text-sm"
            style={{
              background: 'rgba(248, 81, 73, 0.08)',
              border: '1px solid var(--red)',
              color: 'var(--red)',
            }}
          >
            {placeError}
          </div>
        )}

        <button
          onClick={handlePlace}
          disabled={
            placeMutation.isPending ||
            !limitPrice ||
            !quantity ||
            !party ||
            !context
          }
          title={!party ? 'Connect a wallet to place orders' : undefined}
          className={`w-full py-2.5 rounded-lg font-sans font-semibold text-sm transition-colors ${
            side === 'Bid'
              ? 'bg-accent-green hover:bg-accent-green/90 text-white'
              : 'bg-accent-red hover:bg-accent-red/90 text-white'
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {placeMutation.isPending ? 'Placing...' : `Place ${side === 'Bid' ? 'Buy' : 'Sell'} Order`}
        </button>
      </div>
    </div>
  );
}
