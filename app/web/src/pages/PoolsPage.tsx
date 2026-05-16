// Pools page — list view with click-through to PoolDetail. Mirrors
// `cdex-pools.jsx PoolsView` (list ↔ detail switching by selected
// pool id). Add/remove liquidity flows live in PoolDetail; the list
// view's "Manage" button just selects the pool.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { PoolCard } from '@/components/PoolCard';
import { PoolDetail } from '@/components/PoolDetail';
import { fmtUsdK } from '@/primitives/format';
import { ASSETS } from '@/primitives/assets';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';

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
    // Find user's LP holding for this pool's lpInstrumentId.
    const lpHolding = holdings?.find(
      (h) => h.instrumentId === selectedPool.lpInstrumentId,
    );
    return (
      <PoolDetail
        pool={selectedPool}
        holdings={holdings ?? []}
        lpHeld={lpHolding?.amount ?? 0}
        onBack={() => setSelected(null)}
      />
    );
  }

  // Aggregate stats for the strip above the list.
  const tvl = pools.reduce((s, p) => {
    const baseUsd =
      p.reserves.baseAmount * (ASSETS[p.baseInstrumentId]?.price ?? 0);
    const quoteUsd =
      p.reserves.quoteAmount * (ASSETS[p.quoteInstrumentId]?.price ?? 0);
    return s + baseUsd + quoteUsd;
  }, 0);

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
          <div className="stat-v">{fmtUsdK(tvl)}</div>
          <div className="stat-d up">+2.4% 24h</div>
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
            (h) => h.instrumentId === pool.lpInstrumentId,
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
