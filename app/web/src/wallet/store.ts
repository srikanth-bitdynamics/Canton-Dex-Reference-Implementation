// Wallet connection store. Single source of truth for "is a wallet
// connected, which provider, which party". UI components subscribe via
// the zustand hook; the rest of the codebase calls submit() through
// `handToWallet`.

import { create } from "zustand";

import {
  getProvider,
  getProviders,
  type WalletProviderId,
} from "./registry";
import type {
  WalletAccount,
  WalletConnectionStatus,
} from "./types";

interface WalletStore {
  activeProviderId: WalletProviderId | null;
  status: WalletConnectionStatus;
  account: WalletAccount | null;

  connect(providerId: WalletProviderId, walletId?: string): Promise<void>;
  disconnect(): Promise<void>;
  listProviders(): { id: WalletProviderId; label: string }[];
}

// Single active status subscription. `connect` previously subscribed per
// attempt and only unsubscribed on a `disconnected` status, so repeated
// connects / provider switches / errors leaked listeners. We keep one
// handle here and tear down the previous subscription before installing a new
// one (and on error).
let activeUnsubscribe: (() => void) | null = null;

function clearActiveSubscription(): void {
  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = null;
  }
}

export const useWalletStore = create<WalletStore>((set, get) => ({
  activeProviderId: null,
  status: { kind: "disconnected" },
  account: null,

  async connect(providerId: WalletProviderId, walletId?: string) {
    // Tear down any previous session + its status subscription before swapping
    // providers (or re-connecting the same one).
    const current = get().activeProviderId;
    if (current && current !== providerId) {
      await getProvider(current).disconnect();
    }
    clearActiveSubscription();

    const provider = getProvider(providerId);
    activeUnsubscribe = provider.onStatusChange((status) => {
      set({
        status,
        account: status.kind === "connected" ? status.account : null,
      });
      if (status.kind === "disconnected" || status.kind === "error") {
        // Drop the subscription once the provider reaches a terminal state so
        // we never accumulate stale listeners.
        clearActiveSubscription();
        if (get().activeProviderId === providerId) {
          set({ activeProviderId: null });
        }
      }
    });
    set({ activeProviderId: providerId });
    try {
      // `walletId` routes multi-wallet providers (dapp-sdk gateway vs injected;
      // PartyLayer's catalog) to the exact wallet the picker chose.
      const account = await provider.connect(walletId);
      set({ account, status: provider.getStatus() });
    } catch (e) {
      // Status was already set to `error` by the provider (which also fired the
      // subscription above, clearing it). Make sure it's gone and unwind the
      // activeProviderId so the UI offers reconnection.
      clearActiveSubscription();
      set({ activeProviderId: null });
      throw e;
    }
  },

  async disconnect() {
    const id = get().activeProviderId;
    clearActiveSubscription();
    if (!id) return;
    await getProvider(id).disconnect();
    set({ activeProviderId: null, status: { kind: "disconnected" }, account: null });
  },

  listProviders() {
    return [...getProviders().values()].map((p) => ({
      id: p.id as WalletProviderId,
      label: p.label,
    }));
  },
}));
