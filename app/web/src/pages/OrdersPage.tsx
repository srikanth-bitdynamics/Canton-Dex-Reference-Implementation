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
  const [cancelError, setCancelError] = useState<string | null>(null);

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
      const toastId = toast.push(`Cancel order ${id.slice(0, 10)}…`, 'cancelOrder', () =>
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
      );
      // Drive the lifecycle off the real result: complete only once the cancel
      // settles on-ledger, dismiss (and surface) on failure. The toast does not
      // auto-advance, so a failed cancel can't look like it succeeded.
      try {
        const res = await ledger.cancelOrder(id);
        toast.complete(toastId);
        return res;
      } catch (error) {
        toast.dismiss(toastId);
        throw error;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
    onError: (error) =>
      setCancelError(error instanceof Error ? error.message : 'Cancel failed'),
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
      // The toast advances ONLY on real pipeline progress. Order placement
      // blocks on two wallet approvals (create + fund); `onProgress` moves the
      // card a step at a time as each on-ledger step actually lands, so it can
      // never show "In book" while the funding approval is still pending.
      return ledger.placeOrder({
        ...params,
        onProgress: (phase) => toast.setPhase(id, phase),
      });
    },
    onSuccess: () => {
      // The order is funded + in the book — only now drive the toast to its
      // terminal phase (complete) and let it auto-dismiss.
      if (placeToastId.current != null) {
        toast.complete(placeToastId.current);
      }
      placeToastId.current = null;
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      setLimitPrice('');
      setQuantity('');
    },
    onError: (error) => {
      // The mutationFn pushed a lifecycle toast that only completes on real
      // success; on failure dismiss it and surface the real error instead of
      // leaving a half-finished card on screen.
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
        {cancelError && (
          <div
            className="mb-3 rounded px-3 py-2 text-sm"
            style={{
              background: 'rgba(248, 81, 73, 0.08)',
              border: '1px solid var(--red)',
              color: 'var(--red)',
            }}
          >
            {cancelError}
          </div>
        )}
        {activePair ? (
          <OrderBook
            pair={{ base: activePair.baseInstrumentId, quote: activePair.quoteInstrumentId }}
            orders={pairOrders}
            onCancelOrder={id => {
              setCancelError(null);
              cancelMutation.mutate(id);
            }}
          />
        ) : (
          <div className="bg-surface-card rounded-lg border border-surface-border p-8 text-text-muted text-center font-sans">
            No trading pairs available
          </div>
        )}
      </div>

      {/* Place Order */}
      <div className="bg-surface-card rounded-lg border border-surface-border p-5">
        <h3 className="text-text-primary font-sans font-semibold mb-4">Place order</h3>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setSide('Bid')}
            className={`flex-1 py-2 rounded-lg text-sm font-sans font-medium transition-colors ${
              side === 'Bid'
                ? 'bg-[var(--ok-bg)] text-[var(--ok-text)] border border-[var(--ok-border)]'
                : 'bg-surface-hover text-text-secondary hover:text-text-primary'
            }`}
          >
            Buy
          </button>
          <button
            onClick={() => setSide('Ask')}
            className={`flex-1 py-2 rounded-lg text-sm font-sans font-medium transition-colors ${
              side === 'Ask'
                ? 'bg-[var(--danger-bg)] text-[var(--danger-text)] border border-[var(--danger-border)]'
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
              ? 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)]'
              : 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--on-accent)]'
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {placeMutation.isPending ? 'Placing…' : `Place ${side === 'Bid' ? 'buy' : 'sell'} order`}
        </button>
      </div>
    </div>
  );
}
