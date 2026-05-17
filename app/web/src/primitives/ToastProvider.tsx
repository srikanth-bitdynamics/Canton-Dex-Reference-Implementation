// Toast context provider. Lets any component in the tree call
// `useToast()` to push a transaction-lifecycle toast without prop
// threading. Mounts the toast stack at the bottom of the viewport.
//
// The phase advance + onComplete callback semantics live in
// primitives/toasts.tsx (the useToasts hook). This file is just the
// React-context plumbing.

import { createContext, useContext, type ReactNode } from 'react';

import { TxToast, useToasts, type TxPhaseKind } from './toasts';

interface ToastApi {
  push: (label: string, kind?: TxPhaseKind, onComplete?: () => void) => void;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const { toasts, push, dismiss } = useToasts();
  return (
    <Ctx.Provider value={{ push, dismiss }}>
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
        /* no provider */
      },
      dismiss: () => {
        /* no provider */
      },
    }
  );
}
