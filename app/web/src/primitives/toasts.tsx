// Transaction toast + per-workflow phase progression. Phase templates
// describe the on-ledger sequence per workflow so the user sees what
// the operator backend is actually doing on their behalf.
//
// Each phase has a short status tag shown once the step completes.
// These are UI-only status badges, not real on-ledger contract ids.

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
    { label: 'Lock funds in trader Allocation', tag: 'Locked' },
    { label: 'Operator: finalize swap leg-sides', tag: 'Finalized' },
    { label: 'SettleBatch on 3 allocations', tag: 'Settled' },
    { label: 'Pool roll-forward → next iteration', tag: 'Updated' },
  ],
  addLp: [
    { label: 'DepositRequest created', tag: 'Requested' },
    { label: 'Allocations bound to pool legs', tag: 'Allocated' },
    { label: 'Pool refreshed → reserves updated', tag: 'Updated' },
    { label: 'LP tokens minted to your party', tag: 'Minted' },
  ],
  removeLp: [
    { label: 'Burn LP tokens', tag: 'Burned' },
    { label: 'Pool legs split → trader allocations', tag: 'Adjusted' },
    { label: 'SettleBatch on pool + trader', tag: 'Settled' },
    { label: 'Underlying assets returned', tag: 'Returned' },
  ],
  placeOrder: [
    { label: 'Submitted to operator', tag: 'Submitted' },
    { label: 'Bound: order + funding request issued', tag: 'Bound' },
    { label: 'Funding allocation locked', tag: 'Locked' },
    { label: 'In book — awaiting match', tag: 'Open' },
  ],
  cancelOrder: [
    { label: 'Cancel signal received', tag: 'Requested' },
    { label: 'Order archived', tag: 'Closed' },
    { label: 'Funding allocation released', tag: 'Released' },
    { label: 'Funds returned to available', tag: 'Returned' },
  ],
  rfqAccept: [
    { label: 'Trader signs MatchedTrade', tag: 'Signed' },
    { label: 'Both parties post Allocations', tag: 'Allocated' },
    { label: 'Operator validates: whitelist + expiry', tag: 'Validated' },
    { label: 'SettleBatch on 2 allocations', tag: 'Settled' },
    { label: 'Trade recorded → private to counterparties', tag: 'Recorded' },
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
  _dismissScheduled?: boolean;
  /**
   * Set once a caller drives this toast's phase explicitly (via `setPhase`).
   * The 900ms auto-advance timer then leaves this toast alone so its progress
   * reflects real pipeline step completion rather than a cosmetic timer.
   */
  _manual?: boolean;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const advance = useCallback(() => {
    setToasts((cur) =>
      cur.map((t) =>
        // Timer only nudges toasts that aren't being driven explicitly.
        t.phase < t.phaseCount && !t._manual ? { ...t, phase: t.phase + 1 } : t,
      ),
    );
  }, []);

  // Drive a specific toast to a real pipeline phase. Marks it `_manual` so the
  // cosmetic timer stops advancing it.
  const setPhase = useCallback((id: number, phase: number) => {
    setToasts((cur) =>
      cur.map((t) =>
        t.id === id
          ? { ...t, phase: Math.min(Math.max(phase, t.phase), t.phaseCount), _manual: true }
          : t,
      ),
    );
  }, []);

  useEffect(() => {
    if (!toasts.length) return;
    const stillRunning = toasts.some((t) => t.phase < t.phaseCount && !t._manual);
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
      return id;
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  // Fire onComplete once per toast when it reaches the end, then let the
  // finished card clear itself after a short dwell so successful actions
  // don't leave stale cards behind.
  useEffect(() => {
    const completed = toasts.filter(
      (t) => t.phase === t.phaseCount && !t._dismissScheduled,
    );
    if (completed.length === 0) return;

    completed.forEach((t) => {
      if (!t._notified) t.onComplete?.();
    });
    setToasts((cur) =>
      cur.map((t) =>
        t.phase === t.phaseCount && !t._dismissScheduled
          ? { ...t, _notified: true, _dismissScheduled: true }
          : t,
      ),
    );

    const timers = completed.map((t) =>
      setTimeout(() => dismiss(t.id), 1800),
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [dismiss, toasts]);

  return { toasts, push, dismiss, setPhase };
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
                {p.tag}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
