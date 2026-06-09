// Pools page: list view with click-through to PoolDetail. Add/remove
// liquidity flows live in PoolDetail; the list view's "Manage" button
// just selects the pool.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { PoolCard } from '@/components/PoolCard';
import { PoolDetail } from '@/components/PoolDetail';
import { fmtUsdK } from '@/primitives/format';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';
import { useAssetPricesUsd } from '@/hooks/usePrices';

export function PoolsPage() {
  const party = useCurrentParty();
  const { data: pools, isLoading } = useQuery({
    queryKey: ['pools'],
    queryFn: ledger.getPools,
  });
  const { data: holdings } = useQuery({
    queryKey: ['holdings', party],
    queryFn: () => ledger.getHoldings(party!),
    enabled: !!party,
  });

  const [selected, setSelected] = useState<string | null>(null);

  // Hoisted above early returns: hooks must run in the same order on
  // every render. `symbols` is empty when `pools` is undefined; the
  // fiat-price hook handles that case as a no-op.
  const symbols = (pools ?? []).flatMap((p) => [p.baseInstrumentId, p.quoteInstrumentId]);
  const { prices: priceUsd } = useAssetPricesUsd(symbols);

  if (isLoading) {
    return (
      <div className="text-text-muted text-center py-12">Loading pools...</div>
    );
  }
  if (!pools || pools.length === 0) {
    return (
      <div className="text-text-muted text-center py-12">
        No pools available. Create one in the Admin panel.
      </div>
    );
  }

  const selectedPool = pools.find((p) => p.contractId === selected);
  if (selectedPool) {
    // Sum the user's unlocked LP holdings for this pool, matching the full
    // (admin, id) identity rather than the textual id alone. LP positions can
    // be split across several holdings during normalization, and locked shards
    // from failed attempts must not be counted as still available to redeem.
    const lpHeld = (holdings ?? [])
      .filter(
        (h) =>
          !h.locked &&
          h.instrumentId === selectedPool.lpInstrumentId.id &&
          h.admin === selectedPool.lpInstrumentId.admin,
      )
      .reduce((sum, h) => sum + h.amount, 0);
    return (
      <PoolDetail
        pool={selectedPool}
        holdings={holdings ?? []}
        lpHeld={lpHeld}
        onBack={() => setSelected(null)}
      />
    );
  }

  // Aggregate TVL across pools, using live mid prices for fiat
  // estimates. Pools whose base or quote has no live price are
  // skipped (we don't fabricate dollars). `symbols` + `priceUsd`
  // are hoisted above the early returns (see useAssetPricesUsd
  // call earlier in the function).
  let priceableCount = 0;
  const tvl = pools.reduce((s, p) => {
    const bp = priceUsd[p.baseInstrumentId];
    const qp = priceUsd[p.quoteInstrumentId];
    if (bp == null || qp == null) return s;
    priceableCount += 1;
    return s + p.reserves.baseAmount * bp + p.reserves.quoteAmount * qp;
  }, 0);
  const allPriced = priceableCount === pools.length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Liquidity Pools</h1>
          <p className="page-sub">
            Provide liquidity to earn a share of swap fees. LP positions are
            minted as on-ledger LP tokens.
          </p>
        </div>
      </div>

      <div className="grid-3" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="stat-l">Total Value Locked</div>
          <div className="stat-v">{allPriced ? fmtUsdK(tvl) : '—'}</div>
          <div className="stat-d">
            {allPriced
              ? `${priceableCount} pools priced live`
              : `${priceableCount}/${pools.length} pools have live prices`}
          </div>
        </div>
        <div className="stat">
          <div className="stat-l">Active pools</div>
          <div className="stat-v">{pools.length}</div>
          <div className="stat-d">across {pools.length} pairs</div>
        </div>
        <div className="stat">
          <div className="stat-l">Pool fees (typical)</div>
          <div className="stat-v">0.30%</div>
          <div className="stat-d">distributed to LPs</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {pools.map((pool) => {
          const lp = holdings?.find(
            (h) =>
              h.instrumentId === pool.lpInstrumentId.id &&
              h.admin === pool.lpInstrumentId.admin,
          );
          return (
            <PoolCard
              key={pool.contractId}
              pool={pool}
              userLpBalance={lp?.amount ?? 0}
              onAddLiquidity={() => setSelected(pool.contractId)}
              onRemoveLiquidity={() => setSelected(pool.contractId)}
            />
          );
        })}
      </div>
    </div>
  );
}
