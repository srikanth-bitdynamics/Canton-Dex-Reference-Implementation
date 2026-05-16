// Transaction toast + per-workflow phase progression. Direct port of
// cdex-primitives.jsx TX_PHASES + TxToast + useToasts. Phase templates
// describe the on-ledger sequence per workflow so the user sees what
// the operator backend is actually doing on their behalf.
//
// Each phase has a `tag` that becomes the alloc-pill prefix for
// completed steps -- e.g., "Alloc#a1c4". CIDs in production come from
// the ledger event stream; in the demo they're synthesized from the
// toast id.

import { useCallback, useEffect, useState } from 'react';

export type TxPhaseKind =
  | 'swap'
  | 'addLp'
  | 'removeLp'
  | 'placeOrder'
  | 'cancelOrder'
  | 'rfqAccept';

interface PhaseSpec {
  label: string;
  tag: string;
}

export const TX_PHASES: Record<TxPhaseKind, PhaseSpec[]> = {
  swap: [
    { label: 'Lock funds in trader Allocation', tag: 'Alloc' },
    { label: 'Operator: Allocation_Adjust + swap legs', tag: 'AdjustCID' },
    { label: 'SettleBatch on 3 allocations', tag: 'Settle' },
    { label: 'Pool roll-forward → next iteration', tag: 'PoolAlloc·next' },
  ],
  addLp: [
    { label: 'DepositRequest created', tag: 'DepReq' },
    { label: 'Allocations bound to pool legs', tag: 'Alloc' },
    { label: 'Pool refreshed → reserves updated', tag: 'PoolAlloc·next' },
    { label: 'LP tokens minted to your party', tag: 'LPToken' },
  ],
  removeLp: [
    { label: 'Burn LP tokens', tag: 'LPBurn' },
    { label: 'Pool legs split → trader allocations', tag: 'AdjustCID' },
    { label: 'SettleBatch on pool + trader', tag: 'Settle' },
    { label: 'Underlying assets returned', tag: 'Alloc' },
  ],
  placeOrder: [
    { label: 'Submitted to operator', tag: 'OrderReq' },
    { label: 'Bound: TradeAllocationRequest issued', tag: 'BindCID' },
    { label: 'Funding allocation locked', tag: 'OrderAlloc' },
    { label: 'In book — awaiting match', tag: 'Order' },
  ],
  cancelOrder: [
    { label: 'Cancel signal received', tag: 'CancelReq' },
    { label: 'Order archived', tag: 'Order·closed' },
    { label: 'Funding allocation released', tag: 'Alloc·release' },
    { label: 'Funds returned to available', tag: 'Settle' },
  ],
  rfqAccept: [
    { label: 'Trader signs MatchedTrade', tag: 'Match' },
    { label: 'Both parties post Allocations', tag: 'Alloc' },
    { label: 'Operator validates: whitelist + expiry', tag: 'PolicyOK' },
    { label: 'SettleBatch on 2 allocations', tag: 'Settle' },
    { label: 'Trade recorded → private to counterparties', tag: 'TradeCID' },
  ],
};

export interface Toast {
  id: number;
  label: string;
  kind: TxPhaseKind;
  phase: number;
  phaseCount: number;
  onComplete?: () => void;
  _notified?: boolean;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const advance = useCallback(() => {
    setToasts((cur) =>
      cur.map((t) => (t.phase < t.phaseCount ? { ...t, phase: t.phase + 1 } : t)),
    );
  }, []);

  useEffect(() => {
    if (!toasts.length) return;
    const stillRunning = toasts.some((t) => t.phase < t.phaseCount);
    if (!stillRunning) return;
    const id = setTimeout(advance, 900);
    return () => clearTimeout(id);
  }, [toasts, advance]);

  const push = useCallback(
    (label: string, kind: TxPhaseKind = 'swap', onComplete?: () => void) => {
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const phaseCount = TX_PHASES[kind].length;
      setToasts((cur) => [
        ...cur,
        { id, label, kind, phase: 0, phaseCount, onComplete },
      ]);
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  // Fire onComplete once per toast when it reaches the end.
  useEffect(() => {
    toasts.forEach((t) => {
      if (t.phase === t.phaseCount && !t._notified) {
        t._notified = true;
        t.onComplete?.();
      }
    });
  }, [toasts]);

  return { toasts, push, dismiss };
}

interface TxToastProps {
  tx: Toast;
  onDismiss: (id: number) => void;
  showAllocations?: boolean;
}

export function TxToast({
  tx,
  onDismiss,
  showAllocations = true,
}: TxToastProps) {
  const phases = TX_PHASES[tx.kind];
  return (
    <div className="toast">
      <div className="toast-head">
        <span>{tx.label}</span>
        <button
          className="toast-close"
          onClick={() => onDismiss(tx.id)}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
      {phases.map((p, i) => {
        const st = i < tx.phase ? 'done' : i === tx.phase ? 'active' : '';
        return (
          <div key={i} className={`phase ${st}`}>
            <span className="phase-dot"></span>
            <span>{p.label}</span>
            {st === 'done' && showAllocations && (
              <span
                className="alloc-pill"
                style={{ marginLeft: 'auto' }}
              >
                {p.tag}#
                {(0xa1c4 + i * 17 + Math.floor(tx.id))
                  .toString(16)
                  .padStart(4, '0')
                  .slice(-4)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
