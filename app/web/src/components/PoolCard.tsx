import type { Pool } from '@/types/contracts';

interface PoolCardProps {
  pool: Pool;
  userLpBalance: number;
  onAddLiquidity: (pool: Pool) => void;
  onRemoveLiquidity: (pool: Pool) => void;
}

export function PoolCard({ pool, userLpBalance, onAddLiquidity, onRemoveLiquidity }: PoolCardProps) {
  const userShare = pool.totalLpSupply > 0 ? (userLpBalance / pool.totalLpSupply) * 100 : 0;
  const userBaseValue = pool.reserves.baseAmount * (userShare / 100);
  const userQuoteValue = pool.reserves.quoteAmount * (userShare / 100);

  return (
    <div className="bg-surface-card rounded-lg border border-surface-border p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-text-primary font-sans font-semibold text-base">
            {pool.baseInstrumentId} / {pool.quoteInstrumentId}
          </h3>
          <span className={`text-xs font-sans px-2 py-0.5 rounded ${
            pool.status === 'Active'
              ? 'bg-accent-green/20 text-accent-green'
              : pool.status === 'Paused'
                ? 'bg-accent-yellow/20 text-accent-yellow'
                : 'bg-surface-border text-text-muted'
          }`}>
            {pool.status}
          </span>
        </div>
        <div className="text-right">
          <div className="text-text-secondary text-xs font-sans">Fee</div>
          <div className="text-text-primary font-mono text-sm">{(pool.feeBps / 100).toFixed(2)}%</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <div className="text-text-muted text-xs font-sans">{pool.baseInstrumentId}</div>
          <div className="text-text-primary font-mono text-sm">{pool.reserves.baseAmount.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-text-muted text-xs font-sans">{pool.quoteInstrumentId}</div>
          <div className="text-text-primary font-mono text-sm">{pool.reserves.quoteAmount.toLocaleString()}</div>
        </div>
      </div>

      {userLpBalance > 0 && (
        <div className="mb-4 p-3 bg-surface rounded-lg border border-surface-border">
          <div className="text-text-secondary text-xs font-sans mb-1">Your position</div>
          <div className="flex justify-between text-sm">
            <span className="text-text-primary font-mono">{userLpBalance.toFixed(4)} LP</span>
            <span className="text-text-secondary font-mono">{userShare.toFixed(2)}%</span>
          </div>
          <div className="text-text-muted text-xs font-mono mt-1">
            {userBaseValue.toFixed(4)} {pool.baseInstrumentId} / {userQuoteValue.toFixed(2)} {pool.quoteInstrumentId}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => onAddLiquidity(pool)}
          disabled={pool.status !== 'Active' && pool.status !== 'Unfunded'}
          className="flex-1 py-2 rounded-lg text-sm font-sans font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          + Add
        </button>
        <button
          onClick={() => onRemoveLiquidity(pool)}
          disabled={userLpBalance <= 0}
          className="flex-1 py-2 rounded-lg text-sm font-sans font-medium bg-accent-red/20 text-accent-red hover:bg-accent-red/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          - Remove
        </button>
      </div>
    </div>
  );
}
