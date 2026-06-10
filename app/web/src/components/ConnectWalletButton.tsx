// Connect Wallet UI affordance for the top bar.
//
// Behaviour:
//   - Disconnected: button reads "Connect Wallet". Clicking opens a tiny
//     provider picker (WalletConnect / Mock) and starts a connection.
//   - Connecting: spinner state.
//   - Connected: shows truncated party id + provider label, click to
//     disconnect.
//   - Error: surfaces the message inline so config issues (missing
//     project id) are visible.

import { useEffect, useRef, useState } from "react";

import { DEFAULT_PROVIDER_ID } from "@/wallet/registry";
import { useWalletStore } from "@/wallet/store";
import { capabilityFor, dvpBadge } from "@/wallet/capabilities";
import type { WalletProviderId } from "@/wallet/registry";

const BADGE_TONE: Record<"ok" | "warn" | "muted", string> = {
  ok: "var(--green, #22c55e)",
  warn: "var(--amber, #f59e0b)",
  muted: "var(--text-2)",
};

function truncate(s: string | null | undefined, head = 6, tail = 4): string {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function prettyParty(party: string | null | undefined): string {
  if (!party) return "—";
  const [hint] = party.split("::");
  if (hint && hint.length > 0) return hint;
  return truncate(party);
}

export function ConnectWalletButton() {
  const status = useWalletStore((s) => s.status);
  const activeProviderId = useWalletStore((s) => s.activeProviderId);
  const connect = useWalletStore((s) => s.connect);
  const disconnect = useWalletStore((s) => s.disconnect);
  const listProviders = useWalletStore((s) => s.listProviders);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Click-outside to close the menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const handleConnect = async (id: WalletProviderId) => {
    setMenuOpen(false);
    try {
      await connect(id);
    } catch (e) {
      // The store keeps the error in `status`; no extra UI needed here.
      // eslint-disable-next-line no-console
      console.error("[wallet connect]", e);
    }
  };

  if (status.kind === "connected") {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        title={`Disconnect ${status.account.party} (${status.account.label ?? status.providerId})`}
        className="row"
        style={{
          gap: 8,
          padding: "6px 10px",
          borderRadius: 8,
          background: "var(--bg-3)",
          border: "1px solid var(--border)",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: "var(--green, #22c55e)",
            display: "inline-block",
          }}
        />
        <div className="leading-tight" style={{ textAlign: "left" }}>
          <div className="text-xs">{prettyParty(status.account.party)}</div>
          <div
            className="mono text-[10px]"
            style={{ color: "var(--text-2)" }}
          >
            {status.account.label ?? status.providerId}
          </div>
        </div>
      </button>
    );
  }

  if (status.kind === "connecting") {
    return (
      <button
        type="button"
        disabled
        className="row"
        style={{
          gap: 8,
          padding: "6px 10px",
          borderRadius: 8,
          background: "var(--bg-3)",
          border: "1px solid var(--border)",
          opacity: 0.7,
        }}
      >
        <span className="text-xs">Connecting…</span>
      </button>
    );
  }

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => {
          if (activeProviderId) {
            handleConnect(activeProviderId);
          } else {
            setMenuOpen((v) => !v);
          }
        }}
        title="Connect a wallet to authorise trader actions"
        style={{
          padding: "6px 12px",
          borderRadius: 8,
          background: "var(--bg-3)",
          border: "1px solid var(--border)",
          cursor: "pointer",
          fontSize: "0.85rem",
        }}
      >
        Connect Wallet
      </button>
      {status.kind === "error" && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 50,
            maxWidth: 420,
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
          {status.message}
        </div>
      )}
      {menuOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 40,
            minWidth: 200,
            padding: 4,
            borderRadius: 8,
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          <div
            style={{
              padding: "6px 10px 8px",
              fontSize: 11,
              lineHeight: 1.4,
              color: "var(--text-2)",
              borderBottom: "1px solid var(--border)",
              marginBottom: 4,
            }}
          >
            You approve the prepared DEX action in your wallet — you never build
            allocations by hand.
          </div>
          {listProviders().map((p) => {
            const cap = capabilityFor(p.id);
            const badge = dvpBadge(cap.dvp);
            const isDefault = p.id === DEFAULT_PROVIDER_ID;
            const isDevOnly = cap.dvp === "dev-only";
            // Only a real-wallet default earns the "recommended" tag. A dev-only
            // relay is never recommended even if it happens to be the dev
            // default (DEX-97).
            const showRecommended = isDefault && !isDevOnly;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handleConnect(p.id)}
                title={cap.note}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: showRecommended
                    ? "var(--bg-3)"
                    : "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <span>{p.label}</span>
                  <span
                    className="mono text-[10px]"
                    style={{
                      marginLeft: "auto",
                      color: BADGE_TONE[badge.tone],
                      border: `1px solid ${BADGE_TONE[badge.tone]}`,
                      borderRadius: 4,
                      padding: "0 4px",
                    }}
                    title={cap.note}
                  >
                    {badge.label}
                  </span>
                  {showRecommended && (
                    <span
                      className="mono text-[10px]"
                      style={{ color: "var(--text-2)" }}
                    >
                      recommended
                    </span>
                  )}
                  {isDevOnly && (
                    <span
                      className="mono text-[10px]"
                      style={{ color: BADGE_TONE.warn }}
                    >
                      dev only
                    </span>
                  )}
                </div>
                <div
                  className="text-[10px]"
                  style={{ color: "var(--text-2)", marginTop: 2 }}
                >
                  {cap.note}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
