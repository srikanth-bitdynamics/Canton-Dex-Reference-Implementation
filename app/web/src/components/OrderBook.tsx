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

  return (
    <div className="bg-surface-card rounded-lg border border-surface-border p-4">
      <h3 className="text-text-primary font-sans font-semibold mb-3">
        {pair.base} / {pair.quote} Order Book
      </h3>

      <div className="space-y-0.5 mb-2">
        <div className="grid grid-cols-3 text-xs text-text-muted font-sans px-2 pb-1">
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Status</span>
        </div>

        {/* Asks (sells) - displayed top to bottom, lowest ask at bottom */}
        {asks.slice(0, 8).reverse().map(order => (
          <OrderRow key={order.contractId} order={order} color="red" onCancel={onCancelOrder} />
        ))}

        {/* Spread */}
        <div className="text-center text-xs text-text-muted font-mono py-1 border-y border-surface-border">
          spread: {spread}
        </div>

        {/* Bids (buys) - displayed top to bottom, highest bid at top */}
        {bids.slice(0, 8).map(order => (
          <OrderRow key={order.contractId} order={order} color="green" onCancel={onCancelOrder} />
        ))}
      </div>
    </div>
  );
}

function OrderRow({
  order,
  color,
  onCancel,
}: {
  order: Order;
  color: 'red' | 'green';
  onCancel: (id: string) => void;
}) {
  const statusDot = order.status === 'Funded'
    ? 'bg-accent-green'
    : order.status === 'PartiallyFilled'
      ? 'bg-accent-yellow'
      : 'bg-text-muted';

  return (
    <div className="grid grid-cols-3 text-sm font-mono px-2 py-1 hover:bg-surface-hover rounded group">
      <span className={color === 'green' ? 'text-accent-green' : 'text-accent-red'}>
        {order.limitPrice.toFixed(2)}
      </span>
      <span className="text-right text-text-primary">{order.remainingQty.toFixed(4)}</span>
      <span className="text-right flex items-center justify-end gap-1">
        <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
        <button
          onClick={() => onCancel(order.contractId)}
          className="text-text-muted hover:text-accent-red opacity-0 group-hover:opacity-100 transition-opacity text-xs"
          title="Cancel order"
        >
          ✕
        </button>
      </span>
    </div>
  );
}
