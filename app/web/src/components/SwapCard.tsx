import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Pool } from '@/types/contracts';
import { useSwapQuote } from '@/hooks/useSwapQuote';
import { ledger } from '@/services/ledger';
import { useCurrentParty } from '@/wallet/hooks';
import { useToast } from '@/primitives/ToastProvider';

interface SwapCardProps {
  pool: Pool;
  userBalances: Record<string, number>;
  onSwapComplete?: () => void;
}

const SLIPPAGE_PRESETS = [0.1, 0.5, 1.0];

export function SwapCard({ pool, userBalances, onSwapComplete }: SwapCardProps) {
  const party = useCurrentParty();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: context } = useQuery({
    queryKey: ['context'],
    queryFn: ledger.getContext,
  });
  const [direction, setDirection] = useState<'base-to-quote' | 'quote-to-base'>('base-to-quote');
  const [inputAmount, setInputAmount] = useState<string>('');
  const [slippagePct, setSlippagePct] = useState(0.5);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);

  const inputInstrumentId = direction === 'base-to-quote' ? pool.baseInstrumentId : pool.quoteInstrumentId;
  const outputInstrumentId = direction === 'base-to-quote' ? pool.quoteInstrumentId : pool.baseInstrumentId;
  const parsedInput = parseFloat(inputAmount) || 0;

  const { data: quote, isLoading: quoteLoading } = useSwapQuote(
    pool.contractId,
    inputInstrumentId,
    parsedInput > 0 ? parsedInput : null,
  );

  const outputAmount = quote?.outputAmount ?? 0;
  const minReceived = outputAmount * (1 - slippagePct / 100);
  const rate = parsedInput > 0 && outputAmount > 0 ? outputAmount / parsedInput : 0;
  const inputBalance = userBalances[inputInstrumentId] ?? 0;

  // Price impact: how far the executed rate is from the pool mid. Constant-
  // product slippage. Mid = reserveOut / reserveIn at the spot before the trade.
  const reserveIn =
    direction === 'base-to-quote' ? pool.reserves.baseAmount : pool.reserves.quoteAmount;
  const reserveOut =
    direction === 'base-to-quote' ? pool.reserves.quoteAmount : pool.reserves.baseAmount;
  const mid = reserveIn > 0 ? reserveOut / reserveIn : 0;
  const priceImpactPct =
    mid > 0 && rate > 0 ? Math.abs((rate - mid) / mid) * 100 : 0;
  const impactLevel: 'ok' | 'warn' | 'high' =
    priceImpactPct > 5 ? 'high' : priceImpactPct > 2 ? 'warn' : 'ok';
  const impactColor =
    impactLevel === 'high'
      ? 'var(--red)'
      : impactLevel === 'warn'
        ? 'var(--yellow)'
        : 'var(--text-secondary)';

  const flipDirection = useCallback(() => {
    setDirection(d => d === 'base-to-quote' ? 'quote-to-base' : 'base-to-quote');
    setInputAmount('');
    setSwapError(null);
  }, []);

  const handleSwap = useCallback(async () => {
    if (parsedInput <= 0 || outputAmount <= 0 || !context) return;
    setSwapError(null);
    setIsSubmitting(true);
    const label = `Swap ${parsedInput} ${inputInstrumentId} → ${outputInstrumentId}`;
    let toastId = 0;
    try {
      // Push the toast first so the user sees the lifecycle even while
      // the wallet round-trip is happening. The advance timer in
      // useToasts ticks independently; the actual ledger settle path
      // resolves the React Query caches when it completes.
      toastId = toast.push(label, 'swap', () => {
        void queryClient.invalidateQueries({ queryKey: ['pools'] });
        void queryClient.invalidateQueries({ queryKey: ['holdings'] });
      });
      await ledger.executeSwap({
        context,
        pool: {
          contractId: pool.contractId,
          baseInstrumentId: pool.baseInstrumentId,
          quoteInstrumentId: pool.quoteInstrumentId,
        },
        inputInstrumentId,
        inputAmount: parsedInput,
        minOutputAmount: minReceived,
        swapperParty: party ?? '',
      });
      setInputAmount('');
      onSwapComplete?.();
    } catch (error) {
      if (toastId) toast.dismiss(toastId);
      setSwapError(error instanceof Error ? error.message : 'Swap failed');
    } finally {
      setIsSubmitting(false);
    }
  }, [parsedInput, outputAmount, pool, context, inputInstrumentId, outputInstrumentId, minReceived, onSwapComplete, toast, queryClient]);

  return (
    <div className="bg-surface-card rounded-lg border border-surface-border p-6 max-w-md mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-text-primary text-lg font-sans font-semibold">Swap</h2>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="text-text-secondary hover:text-text-primary transition-colors"
          title="Swap settings"
        >
          ⚙
        </button>
      </div>

      {showSettings && (
        <div className="mb-4 p-3 bg-surface rounded-lg border border-surface-border">
          <label className="text-text-secondary text-sm font-sans block mb-2">
            Slippage tolerance
          </label>
          <div className="flex gap-2">
            {SLIPPAGE_PRESETS.map(pct => (
              <button
                key={pct}
                onClick={() => setSlippagePct(pct)}
                className={`px-3 py-1 rounded text-sm font-mono ${
                  slippagePct === pct
                    ? 'bg-accent-blue text-white'
                    : 'bg-surface-hover text-text-secondary hover:text-text-primary'
                }`}
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="mb-2">
        <label className="text-text-secondary text-sm font-sans block mb-1">You pay</label>
        <div className="flex gap-2">
          <input
            type="number"
            value={inputAmount}
            onChange={e => {
              setInputAmount(e.target.value);
              setSwapError(null);
            }}
            placeholder="0.00"
            className="flex-1 bg-surface border border-surface-border rounded-lg px-4 py-3 text-text-primary font-mono text-lg focus:outline-none focus:border-accent-blue"
          />
          <div className="bg-surface border border-surface-border rounded-lg px-4 py-3 text-text-primary font-mono font-semibold min-w-[100px] text-center">
            {inputInstrumentId}
          </div>
        </div>
        <div className="text-text-muted text-xs font-sans mt-1">
          Balance: {inputBalance.toLocaleString()} {inputInstrumentId}
        </div>
      </div>

      {/* Swap direction */}
      <div className="flex justify-center my-3">
        <button
          onClick={flipDirection}
          className="bg-surface-hover hover:bg-surface-border rounded-full w-8 h-8 flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors"
        >
          ↕
        </button>
      </div>

      {/* Output */}
      <div className="mb-4">
        <label className="text-text-secondary text-sm font-sans block mb-1">You receive</label>
        <div className="flex gap-2">
          <div className="flex-1 bg-surface border border-surface-border rounded-lg px-4 py-3 text-text-primary font-mono text-lg">
            {quoteLoading ? '...' : outputAmount > 0 ? `~${outputAmount.toFixed(6)}` : '0.00'}
          </div>
          <div className="bg-surface border border-surface-border rounded-lg px-4 py-3 text-text-primary font-mono font-semibold min-w-[100px] text-center">
            {outputInstrumentId}
          </div>
        </div>
      </div>

      {/* Details */}
      {parsedInput > 0 && outputAmount > 0 && (
        <div className="mb-4 space-y-1 text-sm font-sans">
          <div className="flex justify-between text-text-secondary">
            <span>Rate</span>
            <span className="font-mono">
              1 {inputInstrumentId} = {rate.toFixed(6)} {outputInstrumentId}
            </span>
          </div>
          <div className="flex justify-between text-text-secondary">
            <span>Fee</span>
            <span className="font-mono">{(pool.feeBps / 100).toFixed(2)}%</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-secondary)' }}>Price impact</span>
            <span className="font-mono" style={{ color: impactColor }}>
              {priceImpactPct.toFixed(2)}%
              {impactLevel === 'warn' && ' ⚠'}
              {impactLevel === 'high' && ' ⛔'}
            </span>
          </div>
          <div className="flex justify-between text-text-secondary">
            <span>Min received</span>
            <span className="font-mono">{minReceived.toFixed(6)} {outputInstrumentId}</span>
          </div>
          {impactLevel === 'high' && (
            <div
              className="mt-2 rounded border px-3 py-2 text-xs"
              style={{
                background: 'rgba(248, 81, 73, 0.08)',
                border: '1px solid var(--red)',
                color: 'var(--red)',
              }}
            >
              <strong>High price impact.</strong> Your trade moves the pool price
              by more than 5%. You may receive significantly less than the mid
              quote.
            </div>
          )}
        </div>
      )}

      {swapError && (
        <div
          className="mb-4 rounded px-3 py-2 text-sm"
          style={{
            background: 'rgba(248, 81, 73, 0.08)',
            border: '1px solid var(--red)',
            color: 'var(--red)',
          }}
        >
          {swapError}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={() => setReviewOpen(true)}
        disabled={
          isSubmitting ||
          !party ||
          !context ||
          parsedInput <= 0 ||
          parsedInput > inputBalance ||
          outputAmount <= 0
        }
        className={`w-full py-3 rounded-lg font-sans font-semibold text-base transition-colors ${
          isSubmitting || !party || !context || parsedInput <= 0 || parsedInput > inputBalance
            ? 'bg-surface-border text-text-muted cursor-not-allowed'
            : 'bg-accent-blue hover:bg-accent-blue/90 text-white cursor-pointer'
        }`}
      >
        {!party
          ? 'Connect wallet to swap'
          : isSubmitting
            ? 'Submitting...'
            : parsedInput > inputBalance
              ? 'Insufficient balance'
              : parsedInput <= 0
                ? 'Enter amount'
                : 'Review Swap'}
      </button>

      {/* Review confirmation modal */}
      {reviewOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setReviewOpen(false)}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 480 }}
          >
            <div className="card-head">
              <h3 className="card-title">Review swap</h3>
              <button
                className="toast-close"
                onClick={() => setReviewOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="card-body">
              <div
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 14,
                  marginBottom: 14,
                }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="stat-l">You pay</div>
                    <div
                      className="mono"
                      style={{ fontSize: 18, fontWeight: 600 }}
                    >
                      {parsedInput.toFixed(6)} {inputInstrumentId}
                    </div>
                  </div>
                  <span style={{ color: 'var(--text-2)' }}>→</span>
                  <div style={{ textAlign: 'right' }}>
                    <div className="stat-l">You receive</div>
                    <div
                      className="mono"
                      style={{ fontSize: 18, fontWeight: 600 }}
                    >
                      ~{outputAmount.toFixed(6)} {outputInstrumentId}
                    </div>
                  </div>
                </div>
              </div>

              <div className="section-h">On-ledger sequence</div>
              <div
                className="mono"
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 12,
                  fontSize: 12,
                  color: 'var(--text-2)',
                  lineHeight: 1.7,
                  marginBottom: 14,
                }}
              >
                <div>
                  ①{' '}
                  <span style={{ color: 'var(--text)' }}>Lock</span>{' '}
                  {parsedInput.toFixed(6)} {inputInstrumentId} in trader
                  Allocation{' '}
                  <span className="alloc-pill">prefunded</span>
                </div>
                <div>
                  ② Operator:{' '}
                  <span style={{ color: 'var(--text)' }}>
                    SettleBatch
                  </span>{' '}
                  with extra leg sides on pool + trader allocs
                </div>
                <div>
                  ③{' '}
                  <span style={{ color: 'var(--text)' }}>SettleBatch</span> on
                  3 allocations atomically
                </div>
                <div>
                  ④ Pool rolls forward →{' '}
                  <span style={{ color: 'var(--text)' }}>
                    nextIterationAllocationCid
                  </span>
                </div>
              </div>

              <div className="kv">
                <span className="k">Rate</span>
                <span className="v">
                  1 {inputInstrumentId} ={' '}
                  <span className="num">{rate.toFixed(6)}</span>{' '}
                  {outputInstrumentId}
                </span>
              </div>
              <div className="kv">
                <span className="k">Pool fee ({(pool.feeBps / 100).toFixed(2)}%)</span>
                <span className="v">
                  <span className="num">
                    {(parsedInput * (pool.feeBps / 10000)).toFixed(6)}
                  </span>{' '}
                  {inputInstrumentId}
                </span>
              </div>
              <div className="kv">
                <span className="k">Price impact</span>
                <span className="v" style={{ color: impactColor }}>
                  {priceImpactPct.toFixed(2)}%
                </span>
              </div>
              <div className="kv">
                <span className="k">Slippage tolerance</span>
                <span className="v">{slippagePct}%</span>
              </div>
              <div className="kv">
                <span className="k">Min received</span>
                <span className="v">
                  <span className="num">{minReceived.toFixed(6)}</span>{' '}
                  {outputInstrumentId}
                </span>
              </div>

              {impactLevel === 'high' && (
                <div
                  className="mt-3 rounded px-3 py-2 text-xs"
                  style={{
                    background: 'rgba(248, 81, 73, 0.08)',
                    border: '1px solid var(--red)',
                    color: 'var(--red)',
                  }}
                >
                  <strong>High price impact (&gt; 5%).</strong> You may receive
                  significantly less than the mid quote. Consider reducing the
                  trade size.
                </div>
              )}

              <div className="sp-16"></div>
              <button
                className="btn success block"
                disabled={isSubmitting}
                onClick={async () => {
                  setReviewOpen(false);
                  await handleSwap();
                }}
              >
                {isSubmitting ? 'Submitting…' : 'Approve & Submit'}
              </button>
              <div
                style={{
                  textAlign: 'center',
                  fontSize: 11,
                  color: 'var(--text-3)',
                  marginTop: 10,
                }}
              >
                By approving, your wallet locks the input in a single
                allocation; the operator then settles the swap on-ledger.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pool info */}
      <div className="mt-4 pt-4 border-t border-surface-border text-xs text-text-muted font-sans">
        <div>Pool reserves: {pool.reserves.baseAmount.toLocaleString()} {pool.baseInstrumentId} / {pool.reserves.quoteAmount.toLocaleString()} {pool.quoteInstrumentId}</div>
      </div>
    </div>
  );
}
