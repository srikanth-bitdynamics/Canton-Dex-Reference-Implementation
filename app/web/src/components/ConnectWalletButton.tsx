// Connect Wallet UI affordance for the top bar.
//
// Behaviour:
//   - Disconnected: button reads "Connect wallet". Clicking opens the wallet
//     picker, which auto-detects the wallets available in this deployment
//     (dapp-sdk gateway + injected/announced browser wallets, PartyLayer's
//     catalog) and the remaining providers, then routes the chosen wallet to
//     its owning provider.
//   - Connecting: spinner state.
//   - Connected: shows truncated party id + provider label, click to
//     disconnect.
//   - Error: surfaces the message inline so config issues (missing project id,
//     unreachable gateway) are visible.

import { useState } from "react";

import { useWalletStore } from "@/wallet/store";
import { discoverWallets, type PickerRow } from "@/wallet/detection";
import { WalletPickerModal } from "./WalletPickerModal";

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

  const [pickerOpen, setPickerOpen] = useState(false);
  const [rows, setRows] = useState<PickerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const openPicker = async () => {
    setConnectError(null);
    setConnectingId(null);
    setPickerOpen(true);
    setLoading(true);
    try {
      setRows(await discoverWallets());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[wallet discovery]", e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const handleChoose = async (row: PickerRow) => {
    // Keep the picker open through the connect attempt so its error surfaces in
    // the modal; only close on success. Otherwise the modal unmounts before the
    // connect rejection arrives and the error is never shown.
    setConnectError(null);
    setConnectingId(row.id);
    try {
      await connect(row.providerId, row.walletId);
      setPickerOpen(false);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnectingId(null);
    }
  };

  const closePicker = () => {
    setPickerOpen(false);
    setConnectError(null);
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
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => {
          // A still-active provider (rare in the disconnected state) reconnects
          // directly; otherwise open the auto-detect picker.
          if (activeProviderId) {
            void connect(activeProviderId);
          } else {
            void openPicker();
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
        Connect wallet
      </button>
      {status.kind === "error" && !pickerOpen && (
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
      <WalletPickerModal
        open={pickerOpen}
        loading={loading}
        rows={rows}
        onChoose={handleChoose}
        onCancel={closePicker}
        error={connectError}
        connectingId={connectingId}
      />
    </div>
  );
}
