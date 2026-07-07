import type { Order } from '@/types/contracts';

interface OrderBookProps {
  pair: { base: string; quote: string };
  orders: Order[];
  onCancelOrder: (orderId: string) => void;
}

export function OrderBook({ pair, orders, onCancelOrder }: OrderBookProps) {
  const asks = orders
    .filter(o => o.side === 'Ask')
    .sort((a, b) => a.limitPrice - b.limitPrice);
  const bids = orders
    .filter(o => o.side === 'Bid')
    .sort((a, b) => b.limitPrice - a.limitPrice);

  const bestAsk = asks[0]?.limitPrice;
  const bestBid = bids[0]?.limitPrice;
  const spread = bestAsk && bestBid ? (bestAsk - bestBid).toFixed(2) : '—';
  const spreadPct = bestAsk && bestBid
    ? (((bestAsk - bestBid) / bestAsk) * 100).toFixed(3)
    : '—';

  // Depth bars: scale by the largest single-order remainingQty so each
  // row's bar reflects its relative size on the book.
  const maxQty = Math.max(
    ...orders.map(o => o.remainingQty),
    0,
  ) || 1;

  return (
    <div className="bg-surface-card rounded-lg border border-surface-border p-4">
      <h3 className="text-text-primary font-sans font-semibold mb-3">
        {pair.base} / {pair.quote} order book
      </h3>

      <div className="space-y-0.5 mb-2">
        <div className="grid grid-cols-3 text-xs text-text-muted font-sans px-2 pb-1">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Status</span>
        </div>

        {/* Asks (sells) - displayed top to bottom, lowest ask at bottom */}
        {asks.slice(0, 8).reverse().map(order => (
          <OrderRow
            key={order.contractId}
            order={order}
            color="red"
            onCancel={onCancelOrder}
            depthPct={(order.remainingQty / maxQty) * 100}
          />
        ))}

        {/* Spread */}
        <div className="text-center text-xs text-text-muted font-mono py-1 border-y border-surface-border">
          spread: {spread} ({spreadPct}%)
        </div>

        {/* Bids (buys) - displayed top to bottom, highest bid at top */}
        {bids.slice(0, 8).map(order => (
          <OrderRow
            key={order.contractId}
            order={order}
            color="green"
            onCancel={onCancelOrder}
            depthPct={(order.remainingQty / maxQty) * 100}
          />
        ))}
      </div>
    </div>
  );
}

function OrderRow({
  order,
  color,
  onCancel,
  depthPct,
}: {
  order: Order;
  color: 'red' | 'green';
  onCancel: (id: string) => void;
  depthPct: number;
}) {
  const statusDot = order.status === 'Funded'
    ? 'bg-accent-green'
    : order.status === 'PartiallyFilled'
      ? 'bg-accent-yellow'
      : 'bg-text-muted';

  const depthBg = color === 'green'
    ? 'rgba(34, 197, 94, 0.12)'  // semi-transparent accent-green
    : 'rgba(239, 68, 68, 0.12)'; // semi-transparent accent-red

  return (
    <div className="relative grid grid-cols-3 text-sm font-mono px-2 py-1 hover:bg-surface-hover rounded group">
      <div
        aria-hidden
        className="absolute inset-y-0 right-0 pointer-events-none"
        style={{ width: `${Math.max(0, Math.min(100, depthPct))}%`, background: depthBg }}
      />
      <span className={`relative ${color === 'green' ? 'text-accent-green' : 'text-accent-red'}`}>
        {order.limitPrice.toFixed(2)}
      </span>
      <span className="relative text-right text-text-primary">
        {order.remainingQty.toFixed(4)}
      </span>
      <span className="relative text-right flex items-center justify-end gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} title={order.status} />
        <button
          onClick={() => onCancel(order.contractId)}
          className="rounded border border-surface-border px-1.5 py-0.5 text-[11px] leading-none text-text-muted hover:text-accent-red hover:border-accent-red transition-colors"
          title="Cancel this order"
        >
          Cancel
        </button>
      </span>
    </div>
  );
}
