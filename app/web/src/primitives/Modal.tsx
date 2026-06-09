// Modal shell used by form sheets and detail dialogs. Closes on Escape
// and backdrop click. Width is fixed by the caller via inline style.

import { useEffect, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  open?: boolean;
}

export function Modal({
  title,
  onClose,
  children,
  width = 520,
  open = true,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-head">
          <h3 className="card-title">{title}</h3>
          <button
            className="toast-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}
