// Trade page — swap card on the left, pool stats + recent activity on
// the right. Mirrors cdex-trade.jsx TradeView. The page is a thin shell
// over <SwapCard> + a pool stats panel; all wallet handoff and on-ledger
// state still lives behind ledger.executeSwap / useToast.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { SwapCard } from '@/components/SwapCard';
import { PairGlyph } from '@/primitives/Glyph';
import { Spark } from '@/primitives/Spark';
import { fmt, fmtUsd, fmtUsdK } from '@/primitives/format';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';
import { useAssetPricesUsd } from '@/hooks/usePrices';
import { usePriceHistory } from '@/hooks/useStats';

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

  const { data: swaps } = useQuery({
    queryKey: ['swaps'],
    queryFn: async () => {
      try {
        const res = await fetch(
          (import.meta.env.VITE_API_BASE ?? 'http://localhost:8080') +
            '/v1/swaps?limit=20',
        );
        if (!res.ok) return [];
        return (await res.json()) as Array<{
          ts: number;
          pair: string;
          inputInstrumentId: string;
          inputAmount: number;
          outputAmount: number;
          trader: string;
        }>;
      } catch {
        return [];
      }
    },
    refetchInterval: 10_000,
  });

  const activePool = useMemo(
    () => pools?.find((p) => p.status === 'Active' || p.status === 'Unfunded'),
    [pools],
  );

  const balances: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    holdings?.forEach((h) => {
      if (!h.locked) {
        out[h.instrumentId] =
          (out[h.instrumentId] ?? 0) + parseFloat(h.amount as unknown as string);
      }
    });
    return out;
  }, [holdings]);

  if (!pools) {
    return <div className="text-text-secondary text-center py-12">Loading pools…</div>;
  }

  if (!activePool) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-text-secondary text-center">
          <div className="text-2xl mb-2">No active pools</div>
          <div className="text-sm">
            Create a pool in the Admin panel to start trading.
          </div>
        </div>
      </div>
    );
  }

  const pool = activePool;
  const mid = pool.reserves.baseAmount > 0
    ? pool.reserves.quoteAmount / pool.reserves.baseAmount
    : 0;
  const pairKey = `${pool.baseInstrumentId}/${pool.quoteInstrumentId}`;
  const { prices: priceUsd } = useAssetPricesUsd([
    pool.baseInstrumentId,
    pool.quoteInstrumentId,
  ]);
  const { data: priceHistory } = usePriceHistory(pairKey, 24);
  const basePrice = priceUsd[pool.baseInstrumentId];
  const quotePrice = priceUsd[pool.quoteInstrumentId];
  const tvl =
    basePrice != null && quotePrice != null
      ? pool.reserves.baseAmount * basePrice +
        pool.reserves.quoteAmount * quotePrice
      : null;

  const recentSwapsForPair = (swaps ?? []).filter(
    (s) => s.pair === `${pool.baseInstrumentId}/${pool.quoteInstrumentId}`,
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Trade</h1>
          <p className="page-sub">
            Swap directly against a Canton DEX liquidity pool. All amounts
            settle on-ledger via Token Standard V2 allocations.
          </p>
        </div>
        <div className="row">
          <div className="status-pill">
            <span className="dot" />
            Network: Canton {import.meta.env.VITE_CANTON_NETWORK_ID ?? 'devnet'}
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '460px 1fr',
          gap: 24,
          alignItems: 'start',
        }}
      >
        {/* Left: swap card */}
        <SwapCard pool={pool} userBalances={balances} />

        {/* Right: pool stats + recent activity */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="row" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10 }}>
              <PairGlyph
                base={pool.baseInstrumentId}
                quote={pool.quoteInstrumentId}
                size={28}
              />
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>
                  {pool.baseInstrumentId} / {pool.quoteInstrumentId}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  Pool · Fee {(pool.feeBps / 100).toFixed(2)}% ·{' '}
                  <span className="alloc-pill">
                    Pool#{pool.contractId.slice(0, 8)}
                  </span>
                </div>
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <div
              className="stat"
              style={{
                padding: '8px 14px',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
              }}
            >
              <div>
                <div className="stat-l">Mid</div>
                <div className="stat-v" style={{ fontSize: 16 }}>
                  <span className="num">{fmt(mid, 2)}</span>
                </div>
              </div>
              {priceHistory && priceHistory.length >= 2 ? (
                <Spark
                  data={priceHistory.map((p) => p.price)}
                  color="#3FB950"
                  width={120}
                  height={28}
                />
              ) : (
                <span
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--text-3)' }}
                >
                  no history
                </span>
              )}
            </div>
          </div>

          <div className="grid-3">
            <div className="stat">
              <div className="stat-l">Pool TVL</div>
              <div className="stat-v">{tvl != null ? fmtUsdK(tvl) : '—'}</div>
              <div className="stat-d">
                {fmt(pool.reserves.baseAmount, 4)} {pool.baseInstrumentId} ·{' '}
                {fmt(pool.reserves.quoteAmount, 0)} {pool.quoteInstrumentId}
              </div>
            </div>
            <div className="stat">
              <div className="stat-l">Pool fee</div>
              <div className="stat-v">{(pool.feeBps / 100).toFixed(2)}%</div>
              <div className="stat-d">paid to LPs</div>
            </div>
            <div className="stat">
              <div className="stat-l">LP supply</div>
              <div className="stat-v">{fmt(pool.totalLpSupply, 4)}</div>
              <div className="stat-d">unversioned LP token</div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3 className="card-title">
                Recent swaps · {pool.baseInstrumentId}/{pool.quoteInstrumentId}
              </h3>
              <span className="card-sub">From the indexer</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '90px 1fr 90px 110px 110px',
                  gap: 12,
                  padding: '10px 16px',
                  fontSize: 10,
                  color: 'var(--text-2)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  borderBottom: '1px solid var(--border-soft)',
                }}
              >
                <span>Time</span>
                <span>Direction</span>
                <span style={{ textAlign: 'right' }}>Size</span>
                <span style={{ textAlign: 'right' }}>Effective rate</span>
                <span style={{ textAlign: 'right' }}>Counterparty</span>
              </div>
              {recentSwapsForPair.length === 0 && (
                <div
                  style={{
                    padding: 24,
                    textAlign: 'center',
                    color: 'var(--text-2)',
                    fontSize: 12,
                  }}
                >
                  No swaps yet for this pair. Submit one above to see it
                  appear here.
                </div>
              )}
              {recentSwapsForPair.map((s, i) => {
                const inIsBase = s.inputInstrumentId === pool.baseInstrumentId;
                const dir = inIsBase
                  ? `${pool.baseInstrumentId}→${pool.quoteInstrumentId}`
                  : `${pool.quoteInstrumentId}→${pool.baseInstrumentId}`;
                const rate =
                  s.inputAmount > 0
                    ? inIsBase
                      ? s.outputAmount / s.inputAmount
                      : s.inputAmount / s.outputAmount
                    : 0;
                return (
                  <div
                    key={i}
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        '90px 1fr 90px 110px 110px',
                      gap: 12,
                      padding: '10px 16px',
                      borderBottom:
                        i < recentSwapsForPair.length - 1
                          ? '1px solid var(--border-soft)'
                          : 0,
                      fontSize: 12,
                      alignItems: 'center',
                    }}
                  >
                    <span className="mono" style={{ color: 'var(--text-2)' }}>
                      {new Date(s.ts * 1000).toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}
                    </span>
                    <span className="mono">{dir}</span>
                    <span
                      className="mono num"
                      style={{ textAlign: 'right' }}
                    >
                      {fmt(s.inputAmount, 4)} {s.inputInstrumentId}
                    </span>
                    <span
                      className="mono num"
                      style={{ textAlign: 'right' }}
                    >
                      {fmtUsd(rate)}
                    </span>
                    <span
                      className="mono"
                      style={{
                        textAlign: 'right',
                        color: 'var(--text-2)',
                        fontSize: 11,
                      }}
                    >
                      {s.trader.slice(0, 10)}…
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
