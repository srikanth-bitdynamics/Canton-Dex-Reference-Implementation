// Portfolio view.
//
// Surfaces:
//   - holdings table (ordinary assets plus LP positions)
//   - funded-order allocation breakdown
//   - pool activity feed supplied by the indexer

import { Link } from 'react-router-dom';

import { ASSETS } from '@/primitives/assets';
import { Glyph, PairGlyph } from '@/primitives/Glyph';
import { StatusBadge } from '@/primitives/StatusBadge';
import { fmt, fmtUsd } from '@/primitives/format';
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

const shortRef = (value: string, label: string) =>
  `${label} …${value.slice(-6)}`;

interface AllocationRow {
  label: string;
  amt: string;
  tag: string;
}

export function Portfolio({
  holdings,
  pools,
  orders,
  recentActivity,
}: PortfolioProps) {
  const isLpOf = (p: Pool, h: Holding) =>
    p.lpInstrumentId.id === h.instrumentId && p.lpInstrumentId.admin === h.admin;
  const ordinaryHoldings = holdings.filter(
    (h) => !pools.some((p) => isLpOf(p, h)),
  );
  const grouped = ordinaryHoldings.reduce<
    Record<
      string,
      { admin: string; instrumentId: string; available: number; locked: number }
    >
  >((acc, h) => {
    const key = `${h.admin}\u0000${h.instrumentId}`;
    if (!acc[key]) {
      acc[key] = {
        admin: h.admin,
        instrumentId: h.instrumentId,
        available: 0,
        locked: 0,
      };
    }
    if (h.locked) acc[key]!.locked += h.amount;
    else acc[key]!.available += h.amount;
    return acc;
  }, {});

  // Live USD prices for every symbol we display. `null` for any symbol
  // the backend has no source for — callers render "—" instead of $0.
  const heldSymbols = Object.values(grouped).map((row) => row.instrumentId);
  const poolSymbols = pools.flatMap((p) => [
    p.baseInstrumentId,
    p.quoteInstrumentId,
  ]);
  const { prices: priceUsd } = useAssetPricesUsd([
    ...heldSymbols,
    ...poolSymbols,
  ]);
  const priceFor = (sym: string): number | null => priceUsd[sym] ?? null;
  const priceOr0 = (sym: string) => priceFor(sym) ?? 0;

  // Match LP holdings on the full (admin, id) identity. Comparing the textual
  // id alone would conflate instruments issued by different registrars. Split
  // holding contracts are consolidated into one row per pool.
  const lpRows = pools.flatMap((pool) => {
    const matching = holdings.filter((h) => isLpOf(pool, h));
    if (matching.length === 0) return [];
    const available = matching
      .filter((h) => !h.locked)
      .reduce((sum, h) => sum + h.amount, 0);
    const locked = matching
      .filter((h) => h.locked)
      .reduce((sum, h) => sum + h.amount, 0);
    const amount = available + locked;
    const pct = pool.totalLpSupply > 0 ? amount / pool.totalLpSupply : 0;
    const baseShare = pct * pool.reserves.baseAmount;
    const quoteShare = pct * pool.reserves.quoteAmount;
    const value =
      baseShare * priceOr0(pool.baseInstrumentId) +
      quoteShare * priceOr0(pool.quoteInstrumentId);
    return {
      pool,
      amount,
      available,
      locked,
      pct,
      baseShare,
      quoteShare,
      value,
    };
  });
  const someUnknownPrice =
    heldSymbols.some((s) => priceFor(s) == null) ||
    lpRows.some(
      ({ pool }) =>
        priceFor(pool.baseInstrumentId) == null ||
        priceFor(pool.quoteInstrumentId) == null,
    );

  // Active orders expose the allocation that funds their remaining quantity.
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
        tag: shortRef(o.allocationCid!, 'Allocation'),
      };
    });
  const allocations: AllocationRow[] = orderAllocations;

  const ordinaryValue = Object.values(grouped).reduce(
    (s, v) => s + (v.available + v.locked) * priceOr0(v.instrumentId),
    0,
  );
  const lpValue = lpRows.reduce((s, r) => s + r.value, 0);
  const ordinaryLockedValue = Object.values(grouped).reduce(
    (s, v) => s + v.locked * priceOr0(v.instrumentId),
    0,
  );
  const lpLockedValue = lpRows.reduce(
    (sum, row) =>
      sum + (row.amount > 0 ? (row.value * row.locked) / row.amount : 0),
    0,
  );
  const lockedValue = ordinaryLockedValue + lpLockedValue;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Portfolio</h1>
          <p className="page-sub">
            All holdings, LP positions, and on-ledger activity for your party.
          </p>
        </div>
      </div>

      <div className="grid-3" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="stat-l">Total portfolio value</div>
          <div className="stat-v" style={{ fontSize: 26 }}>
            {someUnknownPrice ? '—' : fmtUsd(ordinaryValue + lpValue)}
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
            {someUnknownPrice
              ? '—'
              : fmtUsd(ordinaryValue + lpValue - lockedValue)}
          </div>
          <div className="stat-d">Free for new operations</div>
        </div>
        <div className="stat">
          <div className="stat-l">Locked in allocations</div>
          <div className="stat-v">
            {someUnknownPrice ? '—' : fmtUsd(lockedValue)}
          </div>
          <div className="stat-d">Funding active allocations</div>
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
              {Object.entries(grouped).map(([key, row]) => {
                const { admin, instrumentId: sym, available, locked } = row;
                const a = ASSETS[sym];
                const total = available + locked;
                return (
                  <tr
                    key={key}
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
                            {a?.name ?? sym} · issuer {shortRef(admin, 'party')}
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
                  key={`${r.pool.contractId}:${r.pool.lpInstrumentId.admin}:${r.pool.lpInstrumentId.id}`}
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
                    {fmt(r.available, 4)}
                  </td>
                  <td
                    className="text-right py-2 px-3 mono"
                    style={{ color: 'var(--text-2)' }}
                  >
                    {fmt(r.locked, 4)}
                  </td>
                  <td className="text-right py-2 px-3 mono">
                    {fmt(r.amount, 4)}
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
              <span className="card-sub">Funding active orders</span>
            </div>
            <div className="card-body">
              {allocations.length === 0 && (
                <EmptyState compact>
                  No active funded orders.
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
                      <span className="badge tiny blue">prefunded</span>
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
          <span className="card-sub">Pool swaps observed by the indexer</span>
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
            <span style={{ textAlign: 'right' }}>Status</span>
          </div>
          {recentActivity.length === 0 && (
            <EmptyState compact>
              No indexed pool swaps yet.
            </EmptyState>
          )}
          {recentActivity.map((a) => {
            return (
              <div key={a.id} className="activity-row">
                <span className="time">
                  {new Date(a.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span>
                  <span className="badge blue tiny">
                    {a.type}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12 }}>
                  {a.details}
                </span>
                <span style={{ textAlign: 'right' }}>
                  <StatusBadge status={a.status} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
