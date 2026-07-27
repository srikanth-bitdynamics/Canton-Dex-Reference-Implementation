// Wallet picker modal.
//
// Shows the auto-detected wallets (dapp-sdk gateway + injected/announced
// browser wallets, PartyLayer's catalog) merged with the remaining providers,
// and resolves the user's choice. Rendered in the dashboard DOM (not a popup)
// so it inherits the app theme and CSP. `onChoose` fires synchronously in the
// row-click gesture, so providers can open gesture-bound popups (a gateway
// login) without the browser blocking them.
//
// Accessibility: on open, focus moves into the dialog, Tab is trapped within
// it, Escape/backdrop cancels, and focus is restored to the opener on close.

import { useEffect, useRef } from "react";

import type { PickerRow } from "@/wallet/detection";

const BADGE_TONE: Record<string, string> = {
  Gateway: "var(--green, #22c55e)",
  Loop: "var(--green, #22c55e)",
  Extension: "var(--blue, #3b82f6)",
  Injected: "var(--blue, #3b82f6)",
  Hosted: "var(--text-2)",
  Dev: "var(--amber, #f59e0b)",
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface WalletPickerModalProps {
  open: boolean;
  loading: boolean;
  rows: readonly PickerRow[];
  onChoose: (row: PickerRow) => void;
  onCancel: () => void;
  error?: string | null;
  /** id of the row currently being connected, if any (shows a spinner + locks
   * the list against a second pick). */
  connectingId?: string | null;
}

export function WalletPickerModal({
  open,
  loading,
  rows,
  onChoose,
  onCancel,
  error,
  connectingId,
}: WalletPickerModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Move focus into the dialog on open; restore it to the opener on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;
    const first = cardRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Escape to cancel; Tab trapped within the dialog (aria-modal promises the
  // rest of the page is inert, so focus must not escape).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = Array.from(
        card.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const busy = connectingId != null;

  const handleRow = (row: PickerRow) => {
    if (busy) return;
    if (row.disabled) {
      if (row.installUrl) {
        window.open(row.installUrl, "_blank", "noopener,noreferrer");
      }
      return;
    }
    onChoose(row);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect a wallet"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        background: "rgba(4,8,10,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        ref={cardRef}
        style={{
          width: "min(420px, 100%)",
          maxHeight: "80vh",
          overflow: "auto",
          background: "var(--bg-2)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          boxShadow: "0 24px 70px rgba(0,0,0,0.6)",
          padding: 20,
        }}
      >
        <div
          className="row"
          style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}
        >
          <div style={{ fontSize: 17, fontWeight: 650 }}>Connect a wallet</div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-2)",
              cursor: busy ? "default" : "pointer",
              fontSize: 18,
              lineHeight: 1,
              padding: 4,
              opacity: busy ? 0.5 : 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.4, marginBottom: 14 }}>
          You approve the prepared DEX action in your wallet — you never build
          allocations by hand.
        </div>

        {loading && (
          <div style={{ padding: "16px 4px", fontSize: 13, color: "var(--text-2)" }}>
            Detecting available wallets…
          </div>
        )}

        {!loading && rows.length === 0 && (
          <div style={{ padding: "16px 4px", fontSize: 13, color: "var(--text-2)" }}>
            No wallets available. Enable a wallet provider (see the Connect
            wallet docs) and reload.
          </div>
        )}

        {!loading &&
          rows.map((row) => {
            const tone = row.badge ? BADGE_TONE[row.badge] ?? "var(--text-2)" : null;
            const connecting = connectingId === row.id;
            const dimmed = row.disabled || (busy && !connecting);
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => handleRow(row)}
                disabled={busy && !row.disabled}
                title={row.description}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  textAlign: "left",
                  background: "var(--bg-3)",
                  color: "inherit",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  padding: 14,
                  margin: "0 0 10px 0",
                  cursor: row.disabled && !row.installUrl ? "default" : busy ? "default" : "pointer",
                  opacity: dimmed ? 0.55 : 1,
                  font: "inherit",
                }}
              >
                {row.icon && (
                  <img
                    src={row.icon}
                    alt=""
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      flex: "0 0 auto",
                      objectFit: "contain",
                    }}
                  />
                )}
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 600 }}>
                    {row.name}
                    {row.disabled ? " — not installed" : ""}
                  </span>
                  {row.description && (
                    <span style={{ fontSize: 11, color: "var(--text-2)" }}>
                      {row.description}
                    </span>
                  )}
                </span>
                {connecting && (
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-2)" }}>
                    connecting…
                  </span>
                )}
                {!connecting && row.recommended && (
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-2)" }}>
                    recommended
                  </span>
                )}
                {row.badge && tone && (
                  <span
                    className="mono"
                    style={{
                      flex: "0 0 auto",
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.02em",
                      textTransform: "uppercase",
                      color: tone,
                      border: `1px solid ${tone}`,
                      borderRadius: 999,
                      padding: "2px 8px",
                    }}
                  >
                    {row.badge}
                  </span>
                )}
              </button>
            );
          })}

        {error && (
          <div
            role="alert"
            style={{
              marginTop: 4,
              padding: "8px 10px",
              borderRadius: 6,
              background: "var(--bg-3)",
              border: "1px solid var(--red, #ef4444)",
              color: "var(--text-2)",
              fontSize: 12,
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
