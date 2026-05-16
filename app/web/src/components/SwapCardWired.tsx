// Worked example: the swap card wired to the real operator backend.
//
// Shape of the flow (matches docs/wallet-vs-dapp-boundary.md):
//
//   1. dApp fetches active pools from operator backend.
//   2. dApp computes quotes via operator backend's /v1/swaps/quote
//      (cheap; off-chain mirror of Pool_ComputeSwapOut).
//   3. User reviews + clicks Approve.
//   4. dApp builds a `RequestSwapIntent` and hands it to the wallet.
//   5. Wallet creates the swap allocation (factory call) under
//      trader's authority.
//   6. dApp calls operator backend /v1/pools/swap with the new
//      allocation CID; backend submits Pool_Swap.
//   7. Toast tracks the workflow phases via ledger events.
//
// This component intentionally has no business logic of its own --
// every market-state read goes through the operator API, every
// trader-authority action goes through the wallet handoff.

import { useEffect, useMemo, useState } from 'react';

import {
  OperatorApi,
  type Pool,
  type Decimal as DecimalText,
  type Party,
} from '@/services/operator-api';
import { handToWallet, type RequestSwapIntent } from '@/wallet/handoff';

interface Props {
  api: OperatorApi;
  /** Trader's party id; obtained from session. */
  trader: Party;
  /** Operator party id; configured per deployment. */
  operatorParty: Party;
  /** Holdings the wallet should consider for funding. */
  candidateHoldingCids: string[];
  /** Allocation factory CID for the asset admin (from registry-client cache). */
  allocationFactoryCid: string;
}

export function SwapCardWired({
  api,
  trader,
  operatorParty,
  candidateHoldingCids,
  allocationFactoryCid,
}: Props) {
  const [pools, setPools] = useState<Pool[]>([]);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [direction, setDirection] = useState<'base-to-quote' | 'quote-to-base'>(
    'base-to-quote',
  );
  const [inputAmount, setInputAmount] = useState('');
  const [quote, setQuote] = useState<DecimalText | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial pool load.
  useEffect(() => {
    let cancelled = false;
    api.listPools().then((ps) => {
      if (cancelled) return;
      setPools(ps);
      if (ps.length > 0) setSelectedPoolId(ps[0]!.contractId);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const selectedPool = useMemo(
    () => pools.find((p) => p.contractId === selectedPoolId) ?? null,
    [pools, selectedPoolId],
  );

  const inputInstrumentId = selectedPool
    ? direction === 'base-to-quote'
      ? selectedPool.baseInstrumentId
      : selectedPool.quoteInstrumentId
    : null;
  const outputInstrumentId = selectedPool
    ? direction === 'base-to-quote'
      ? selectedPool.quoteInstrumentId
      : selectedPool.baseInstrumentId
    : null;

  // Quote refresh when input changes.
  useEffect(() => {
    if (!selectedPool || !inputInstrumentId || !inputAmount) {
      setQuote(null);
      return;
    }
    const amount = parseFloat(inputAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    api
      .computeSwapQuote({
        poolId: selectedPool.contractId,
        inputInstrumentId,
        inputAmount: inputAmount,
      })
      .then((q) => {
        if (!cancelled) setQuote(q.outputAmount);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedPool, inputInstrumentId, inputAmount]);

  const onSubmit = async () => {
    if (!selectedPool || !inputInstrumentId || !outputInstrumentId || !quote) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      // Slippage tolerance: 0.5% default. Production lets the user set it.
      const slippagePct = 0.5;
      const minOutputAmount = (
        parseFloat(quote) *
        (1 - slippagePct / 100)
      ).toFixed(8);

      // Step 1: hand the swap intent off to the trader's wallet. The
      // wallet creates the allocation under trader authority.
      const intent: RequestSwapIntent = {
        kind: 'request-swap',
        poolId: selectedPool.contractId,
        inputInstrumentId,
        inputAmount,
        outputInstrumentId,
        minOutputAmount,
        inputHoldingCids: candidateHoldingCids,
        factoryCid: allocationFactoryCid,
        operator: operatorParty,
        admin: selectedPool.admin,
      };

      const walletResult = await handToWallet(intent, {
        preferPostMessage: true,
      });

      // Step 2: tell the operator to drive Pool_Swap with the
      // trader-created allocation.
      await api.swap({
        poolCid: selectedPool.contractId,
        swapperAccount: { owner: trader, provider: null, id: '' },
        inputInstrumentId,
        inputAmount,
        minOutputAmount,
        swapperAllocationCid: walletResult.primaryCid,
      });

      // Refresh pool state after swap.
      const refreshed = await api.listPools();
      setPools(refreshed);
      setInputAmount('');
      setQuote(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!selectedPool) {
    return (
      <div className="bg-surface-card rounded-lg border border-surface-border p-6 text-text-muted">
        Loading pools...
      </div>
    );
  }

  return (
    <div className="bg-surface-card rounded-lg border border-surface-border p-6 max-w-md mx-auto">
      <h2 className="text-text-primary text-lg font-sans font-semibold mb-4">
        Swap (wired)
      </h2>

      <select
        value={selectedPool.contractId}
        onChange={(e) => setSelectedPoolId(e.target.value)}
        className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 mb-3 text-text-primary"
      >
        {pools.map((p) => (
          <option key={p.contractId} value={p.contractId}>
            {p.baseInstrumentId} / {p.quoteInstrumentId}
          </option>
        ))}
      </select>

      <div className="space-y-2">
        <label className="text-text-secondary text-sm font-sans">
          You pay ({inputInstrumentId})
        </label>
        <input
          type="number"
          value={inputAmount}
          onChange={(e) => setInputAmount(e.target.value)}
          placeholder="0.00"
          className="w-full bg-surface border border-surface-border rounded-lg px-4 py-3 text-text-primary font-mono text-lg"
        />

        <button
          onClick={() =>
            setDirection((d) =>
              d === 'base-to-quote' ? 'quote-to-base' : 'base-to-quote',
            )
          }
          className="block mx-auto w-8 h-8 bg-surface-hover rounded-full text-text-secondary"
        >
          ↕
        </button>

        <label className="text-text-secondary text-sm font-sans">
          You receive ({outputInstrumentId})
        </label>
        <div className="bg-surface border border-surface-border rounded-lg px-4 py-3 text-text-primary font-mono">
          {quote ? `~${quote}` : '0.00'}
        </div>
      </div>

      <button
        onClick={onSubmit}
        disabled={
          isSubmitting || !quote || !inputAmount || parseFloat(inputAmount) <= 0
        }
        className="w-full mt-4 py-3 rounded-lg bg-accent-blue text-white font-semibold disabled:opacity-40"
      >
        {isSubmitting ? 'Submitting...' : 'Review Swap'}
      </button>

      {error && (
        <div className="mt-3 text-sm text-accent-red font-mono">{error}</div>
      )}

      <div className="mt-4 pt-4 border-t border-surface-border text-xs text-text-muted">
        <div>Pool: {selectedPool.contractId}</div>
        <div>Reserves: {selectedPool.reserves.baseAmount} / {selectedPool.reserves.quoteAmount}</div>
      </div>
    </div>
  );
}
