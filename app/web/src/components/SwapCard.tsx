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

  const flipDirection = useCallback(() => {
    setDirection(d => d === 'base-to-quote' ? 'quote-to-base' : 'base-to-quote');
    setInputAmount('');
  }, []);

  const handleSwap = useCallback(async () => {
    if (parsedInput <= 0 || outputAmount <= 0 || !context) return;
    setIsSubmitting(true);
    const label = `Swap ${parsedInput} ${inputInstrumentId} → ${outputInstrumentId}`;
    try {
      // Push the toast first so the user sees the lifecycle even while
      // the wallet round-trip is happening. The advance timer in
      // useToasts ticks independently; the actual ledger settle path
      // resolves the React Query caches when it completes.
      toast.push(label, 'swap', () => {
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
      });
      setInputAmount('');
      onSwapComplete?.();
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
            onChange={e => setInputAmount(e.target.value)}
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
          <div className="flex justify-between text-text-secondary">
            <span>Min received</span>
            <span className="font-mono">{minReceived.toFixed(6)} {outputInstrumentId}</span>
          </div>
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleSwap}
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

      {/* Pool info */}
      <div className="mt-4 pt-4 border-t border-surface-border text-xs text-text-muted font-sans">
        <div>Pool reserves: {pool.reserves.baseAmount.toLocaleString()} {pool.baseInstrumentId} / {pool.reserves.quoteAmount.toLocaleString()} {pool.quoteInstrumentId}</div>
      </div>
    </div>
  );
}
