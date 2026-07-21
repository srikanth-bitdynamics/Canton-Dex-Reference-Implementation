// Portfolio view.
//
// Surfaces:
//   - holdings table (asset rows + LP token rows synthesized from
//     pool contracts)
//   - allocation breakdown: locked-funds detail with prefunded vs
//     committed badges + clickable policy-receipt drill-down for
//     RFQ-derived activity entries
//   - activity feed: per-event tx + policy receipt pills

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { ASSETS } from '@/primitives/assets';
import { Glyph, PairGlyph } from '@/primitives/Glyph';
import { StatusBadge } from '@/primitives/StatusBadge';
import { fmt, fmtUsd } from '@/primitives/format';
import { PolicyReceiptModal } from '@/primitives/PolicyReceiptModal';
import { useAssetPricesUsd } from '@/hooks/usePrices';
import { EmptyState } from '@/primitives/EmptyState';
import type {
  Holding,
  Order,
  Pool,
  TransactionEvent,
} from '@/types/contracts';

interface PortfolioProps {
  holdings: Holding[];
  /** Pool contracts the user has LP positions in. */
  pools: Pool[];
  /** Active trader orders — drives the prefunded allocation rows. */
  orders: Order[];
  recentActivity: TransactionEvent[];
}

// Compact contract-id suffix for tag pills.
const cidTag = (cid: string, prefix: string) => {
  const tail = cid.replace(/[#:].*$/, '').slice(-4);
  return `${prefix}#${tail || cid.slice(-4)}`;
};

interface AllocationRow {
  label: string;
  amt: string;
  tag: string;
  kind: 'prefunded' | 'committed';
}

export function Portfolio({
  holdings,
  pools,
  orders,
  recentActivity,
}: PortfolioProps) {
  const [receiptOpenFor, setReceiptOpenFor] = useState<string | null>(null);

  const grouped = holdings.reduce<
    Record<string, { available: number; locked: number }>
  >((acc, h) => {
    const key = h.instrumentId;
    if (!acc[key]) acc[key] = { available: 0, locked: 0 };
    if (h.locked) acc[key]!.locked += h.amount;
    else acc[key]!.available += h.amount;
    return acc;
  }, {});

  // Live USD prices for every symbol we display. `null` for any symbol
  // the backend has no source for — callers render "—" instead of $0.
  const heldSymbols = Object.keys(grouped);
  const poolSymbols = pools.flatMap((p) => [
    p.baseInstrumentId,
    p.quoteInstrumentId,
  ]);
  const { prices: priceUsd } = useAssetPricesUsd([
    ...heldSymbols,
    ...poolSymbols,
  ]);
  // LP tokens have no market pair, so the backend can't price them. Derive each
  // pool's LP-token USD price from its share of the pool reserves; without this
  // a single LP holding makes `someUnknownPrice` true and blanks every value
  // card even though the underlying BTC/USDC are priced.
  const lpPriceUsd: Record<string, number> = {};
  for (const p of pools) {
    const basePx = priceUsd[p.baseInstrumentId];
    const quotePx = priceUsd[p.quoteInstrumentId];
    if (p.totalLpSupply > 0 && basePx != null && quotePx != null) {
      lpPriceUsd[p.lpInstrumentId.id] =
        (p.reserves.baseAmount * basePx + p.reserves.quoteAmount * quotePx) /
        p.totalLpSupply;
    }
  }
  const priceFor = (sym: string): number | null =>
    priceUsd[sym] ?? lpPriceUsd[sym] ?? null;
  const priceOr0 = (sym: string) => priceFor(sym) ?? 0;
  const someUnknownPrice =
    heldSymbols.some((s) => priceFor(s) == null) ||
    pools.some(
      (p) =>
        priceFor(p.baseInstrumentId) == null ||
        priceFor(p.quoteInstrumentId) == null,
    );

  // Synthesize LP rows from holdings whose instrument matches a pool's
  // LP instrument. Match on the full (admin, id) identity — comparing
  // the textual id alone would conflate LP tokens from different
  // registrars that happen to share a name.
  const isLpOf = (p: Pool, h: Holding) =>
    p.lpInstrumentId.id === h.instrumentId && p.lpInstrumentId.admin === h.admin;
  const lpRows = holdings
    .filter((h) => pools.some((p) => isLpOf(p, h)))
    .map((h) => {
      const pool = pools.find((p) => isLpOf(p, h))!;
      const pct =
        pool.totalLpSupply > 0 ? h.amount / pool.totalLpSupply : 0;
      const baseShare = pct * pool.reserves.baseAmount;
      const quoteShare = pct * pool.reserves.quoteAmount;
      const value =
        baseShare * priceOr0(pool.baseInstrumentId) +
        quoteShare * priceOr0(pool.quoteInstrumentId);
      return {
        holding: h,
        pool,
        pct,
        baseShare,
        quoteShare,
        value,
      };
    });

  // Real allocation breakdown:
  //   - prefunded: active Orders carrying a funded allocationCid. The
  //     locked notional is `limitPrice * remainingQty` for Bid (quote
  //     leg) and `remainingQty` of the base for Ask.
  //   - committed: LP positions, derived from lpRows above.
  const orderAllocations: AllocationRow[] = orders
    .filter((o) => o.allocationCid)
    .map((o) => {
      const isBid = o.side === 'Bid';
      const baseSym = o.baseInstrumentId;
      const quoteSym = o.quoteInstrumentId;
      const lockedSym = isBid ? quoteSym : baseSym;
      const lockedAmt = isBid
        ? o.limitPrice * o.remainingQty
        : o.remainingQty;
      return {
        label: `Order: ${isBid ? 'BUY' : 'SELL'} ${fmt(
          o.remainingQty,
          4,
        )} ${baseSym} @ ${fmt(o.limitPrice, 2)}`,
        amt: `${fmt(lockedAmt, lockedSym === baseSym ? 4 : 2)} ${lockedSym}`,
        tag: cidTag(o.allocationCid!, 'OrderAlloc'),
        kind: 'prefunded',
      };
    });
  const lpAllocations: AllocationRow[] = lpRows.map((r) => ({
    label: `LP position ${r.pool.baseInstrumentId}/${r.pool.quoteInstrumentId}`,
    amt: `${fmt(r.baseShare, 4)} ${r.pool.baseInstrumentId} + ${fmt(
      r.quoteShare,
      2,
    )} ${r.pool.quoteInstrumentId}`,
    tag: cidTag(r.holding.contractId, 'PoolAlloc'),
    kind: 'committed',
  }));
  const allocations: AllocationRow[] = [
    ...orderAllocations,
    ...lpAllocations,
  ];

  const totalValue = Object.entries(grouped).reduce(
    (s, [sym, v]) => s + (v.available + v.locked) * priceOr0(sym),
    0,
  );
  const lpValue = lpRows.reduce((s, r) => s + r.value, 0);
  const lockedValue = Object.entries(grouped).reduce(
    (s, [sym, v]) => s + v.locked * priceOr0(sym),
    0,
  );

  const receiptTrade = recentActivity.find((a) => a.id === receiptOpenFor);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">
            All holdings, LP positions, and on-ledger activity for your party.
          </p>
        </div>
        <div className="row">
          <button className="btn ghost tiny">Export CSV</button>
          <button className="btn">Refresh</button>
        </div>
      </div>

      <div className="grid-3" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="stat-l">Total portfolio value</div>
          <div className="stat-v" style={{ fontSize: 26 }}>
            {someUnknownPrice ? '—' : fmtUsd(totalValue + lpValue)}
          </div>
          <div className="stat-d">
            {someUnknownPrice
              ? 'no live price for some instruments'
              : 'live mid prices'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-l">Available</div>
          <div className="stat-v">
            {someUnknownPrice ? '—' : fmtUsd(totalValue - lockedValue)}
          </div>
          <div className="stat-d">Free for new operations</div>
        </div>
        <div className="stat">
          <div className="stat-l">Locked in allocations</div>
          <div className="stat-v">
            {someUnknownPrice ? '—' : fmtUsd(lockedValue)}
          </div>
          <div className="stat-d">Funding open orders &amp; swaps</div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr',
          gap: 20,
          alignItems: 'start',
        }}
      >
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Holdings</h3>
            <span className="card-sub">
              {Object.keys(grouped).length} assets · {lpRows.length} LP positions
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr
                style={{
                  fontSize: 10,
                  color: 'var(--text-2)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                <th className="text-left py-2 px-3">Asset</th>
                <th className="text-right py-2 px-3">Available</th>
                <th className="text-right py-2 px-3">Locked</th>
                <th className="text-right py-2 px-3">Total</th>
                <th className="text-right py-2 px-3">Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(grouped).map(([sym, { available, locked }]) => {
                const a = ASSETS[sym];
                const total = available + locked;
                return (
                  <tr
                    key={sym}
                    style={{ borderTop: '1px solid var(--border-soft)' }}
                  >
                    <td className="py-2 px-3">
                      <div className="row">
                        <Glyph sym={sym} />
                        <div style={{ marginLeft: 6 }}>
                          <div style={{ fontWeight: 600 }}>{sym}</div>
                          <div
                            style={{ fontSize: 11, color: 'var(--text-2)' }}
                          >
                            {a?.name ?? sym}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="text-right py-2 px-3 mono">
                      {fmt(available, a?.decimals ?? 4)}
                    </td>
                    <td
                      className="text-right py-2 px-3 mono"
                      style={{
                        color:
                          locked > 0 ? 'var(--yellow)' : 'var(--text-2)',
                      }}
                    >
                      {fmt(locked, a?.decimals ?? 4)}
                    </td>
                    <td className="text-right py-2 px-3 mono">
                      {fmt(total, a?.decimals ?? 4)}
                    </td>
                    <td className="text-right py-2 px-3 mono">
                      {priceFor(sym) != null
                        ? fmtUsd(total * (priceFor(sym) as number))
                        : '—'}
                    </td>
                  </tr>
                );
              })}
              {lpRows.map((r) => (
                <tr
                  key={r.holding.contractId}
                  style={{ borderTop: '1px solid var(--border-soft)' }}
                >
                  <td className="py-2 px-3">
                    <div className="row">
                      <PairGlyph
                        base={r.pool.baseInstrumentId}
                        quote={r.pool.quoteInstrumentId}
                      />
                      <div style={{ marginLeft: 6 }}>
                        <div style={{ fontWeight: 600 }}>
                          {r.pool.baseInstrumentId}/{r.pool.quoteInstrumentId}{' '}
                          <span
                            style={{
                              color: 'var(--text-2)',
                              fontSize: 11,
                              fontWeight: 400,
                            }}
                          >
                            LP
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
                          {(r.pct * 100).toFixed(3)}% of pool ·{' '}
                          <span className="mono">
                            {fmt(r.baseShare, ASSETS[r.pool.baseInstrumentId]?.decimals ?? 4)}{' '}
                            {r.pool.baseInstrumentId}
                          </span>{' '}
                          +{' '}
                          <span className="mono">
                            {fmt(r.quoteShare, ASSETS[r.pool.quoteInstrumentId]?.decimals ?? 2)}{' '}
                            {r.pool.quoteInstrumentId}
                          </span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="text-right py-2 px-3 mono">
                    {fmt(r.holding.amount, 4)}
                  </td>
                  <td
                    className="text-right py-2 px-3 mono"
                    style={{ color: 'var(--text-2)' }}
                  >
                    0.0000
                  </td>
                  <td className="text-right py-2 px-3 mono">
                    {fmt(r.holding.amount, 4)}
                  </td>
                  <td className="text-right py-2 px-3 mono">
                    {priceUsd[r.pool.baseInstrumentId] != null &&
                    priceUsd[r.pool.quoteInstrumentId] != null
                      ? fmtUsd(r.value)
                      : '—'}
                    <div style={{ marginTop: 4 }}>
                      <Link
                        to="/pools"
                        className="btn tiny ghost"
                        style={{ fontSize: 10, padding: '2px 8px' }}
                        title={`Manage LP position in ${r.pool.baseInstrumentId}/${r.pool.quoteInstrumentId}`}
                      >
                        Manage →
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Allocation breakdown</h3>
              <span className="card-sub">What's locking your funds</span>
            </div>
            <div className="card-body">
              {allocations.length === 0 && (
                <EmptyState compact>
                  No active allocations. Funds lock here while orders and swaps
                  settle.
                </EmptyState>
              )}
              {allocations.map((row, i, arr) => (
                <div
                  key={i}
                  style={{
                    padding: '10px 0',
                    borderBottom:
                      i < arr.length - 1
                        ? '1px solid var(--border-soft)'
                        : 0,
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    alignItems: 'flex-start',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>
                      {row.label}
                    </div>
                    <div className="row" style={{ gap: 6, marginTop: 4 }}>
                      <span className="alloc-pill">{row.tag}</span>
                      <span
                        className={`badge tiny ${
                          row.kind === 'committed' ? 'green' : 'blue'
                        }`}
                        title={
                          row.kind === 'committed'
                            ? 'Locked until you withdraw'
                            : 'Locked for one trade'
                        }
                      >
                        {row.kind}
                      </span>
                    </div>
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                  >
                    {row.amt}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="sp-20" />
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Activity</h3>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn tiny ghost">All</button>
            <button className="btn tiny ghost">Swaps</button>
            <button className="btn tiny ghost">Orders</button>
            <button className="btn tiny ghost">LP</button>
            <button className="btn tiny ghost">RFQ</button>
          </div>
        </div>
        <div>
          <div
            className="activity-row"
            style={{
              fontSize: 10,
              color: 'var(--text-2)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              borderBottom: '1px solid var(--border-soft)',
            }}
          >
            <span>Time</span>
            <span>Type</span>
            <span>Detail</span>
            <span style={{ textAlign: 'right' }}>Tx · Policy</span>
            <span style={{ textAlign: 'right' }}>Status</span>
          </div>
          {recentActivity.length === 0 && (
            <EmptyState compact>
              No activity yet. Swaps, orders, and LP changes appear here as
              they settle.
            </EmptyState>
          )}
          {recentActivity.map((a) => {
            const txPill =
              a.tradeCid ??
              '0x' +
                (0xa1c4 + Math.abs(a.id.charCodeAt(0)) * 17)
                  .toString(16)
                  .padStart(4, '0');
            return (
              <div key={a.id} className="activity-row">
                <span className="time">
                  {new Date(a.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span>
                  <span
                    className={`badge ${
                      a.type === 'Swap'
                        ? 'blue'
                        : a.type === 'AddLiquidity'
                          ? 'green'
                          : a.type === 'RemoveLiquidity'
                            ? 'amber'
                            : a.type === 'Rfq'
                              ? 'blue'
                              : ''
                    } tiny`}
                  >
                    {a.type}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {a.details}
                </span>
                <span
                  style={{
                    justifySelf: 'end',
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                  }}
                >
                  <span className="alloc-pill mono" style={{ fontSize: 10 }}>
                    {txPill}
                  </span>
                  {a.policyCid && (
                    <button
                      className="alloc-pill mono"
                      onClick={() => setReceiptOpenFor(a.id)}
                      title="Open policy receipt"
                      style={{
                        fontSize: 10,
                        cursor: 'pointer',
                        border: 0,
                        background: 'rgba(56,139,253,0.12)',
                        color: 'var(--blue)',
                      }}
                    >
                      {a.policyCid}
                    </button>
                  )}
                </span>
                <span style={{ textAlign: 'right' }}>
                  <StatusBadge status={a.status} />
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {receiptOpenFor && receiptTrade && (
        <PolicyReceiptModal
          trade={receiptTrade}
          onClose={() => setReceiptOpenFor(null)}
        />
      )}
    </div>
  );
}
