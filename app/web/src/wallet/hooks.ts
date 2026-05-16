// React hooks over the wallet store. Pages import `useCurrentParty()`
// rather than reading the store directly so the "no wallet connected"
// path is uniform (returns null; the page is responsible for skipping
// queries / disabling buttons).

import { useWalletStore } from "./store";
import type { Party } from "./types";

/**
 * The connected wallet party, or null when disconnected. Pages should
 * gate trader-scoped queries on this (react-query `enabled: !!party`)
 * so we never query the ledger for a fake "current-user".
 */
export function useCurrentParty(): Party | null {
  return useWalletStore((s) => s.account?.party ?? null);
}

/** True when a wallet is connected and queries can act in the user's name. */
export function useIsWalletConnected(): boolean {
  return useWalletStore((s) => s.status.kind === "connected");
}
