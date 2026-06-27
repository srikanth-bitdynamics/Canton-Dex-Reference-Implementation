// Toast context provider. Lets any component in the tree call
// `useToast()` to push a transaction-lifecycle toast without prop
// threading. Mounts the toast stack at the bottom of the viewport.
//
// The phase progression + onComplete callback semantics live in
// primitives/toasts.tsx (the useToasts hook); phases only ever move on
// real pipeline progress, never a timer. This file is just the
// React-context plumbing.

import { createContext, useContext, type ReactNode } from 'react';

import { TxToast, useToasts, type TxPhaseKind } from './toasts';

interface ToastApi {
  push: (label: string, kind?: TxPhaseKind, onComplete?: () => void) => number;
  dismiss: (id: number) => void;
  /** Drive a toast to a real pipeline phase reported by the calling flow. */
  setPhase: (id: number, phase: number) => void;
  /** Drive a toast to its terminal phase from a flow's success path. */
  complete: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const { toasts, push, dismiss, setPhase, complete } = useToasts();
  return (
    <Ctx.Provider value={{ push, dismiss, setPhase, complete }}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <TxToast key={t.id} tx={t} onDismiss={dismiss} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

/**
 * Push a transaction-lifecycle toast. Returns a no-op when called
 * outside a ToastProvider so unit tests that render a single component
 * don't need a provider boilerplate.
 */
export function useToast(): ToastApi {
  return (
    useContext(Ctx) ?? {
      push: () => {
        return 0;
      },
      dismiss: () => {
        /* no provider */
      },
      setPhase: () => {
        /* no provider */
      },
      complete: () => {
        /* no provider */
      },
    }
  );
}
