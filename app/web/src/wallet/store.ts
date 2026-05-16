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

  connect(providerId: WalletProviderId): Promise<void>;
  disconnect(): Promise<void>;
  listProviders(): { id: WalletProviderId; label: string }[];
}

export const useWalletStore = create<WalletStore>((set, get) => ({
  activeProviderId: null,
  status: { kind: "disconnected" },
  account: null,

  async connect(providerId: WalletProviderId) {
    // Tear down any previous session before swapping providers.
    const current = get().activeProviderId;
    if (current && current !== providerId) {
      await getProvider(current).disconnect();
    }
    const provider = getProvider(providerId);
    const unsubscribe = provider.onStatusChange((status) => {
      set({
        status,
        account: status.kind === "connected" ? status.account : null,
      });
      if (status.kind === "disconnected") {
        unsubscribe();
        if (get().activeProviderId === providerId) {
          set({ activeProviderId: null });
        }
      }
    });
    set({ activeProviderId: providerId });
    try {
      const account = await provider.connect();
      set({ account, status: provider.getStatus() });
    } catch (e) {
      // Status was already set to `error` by the provider; just
      // unwind the activeProviderId so the UI offers reconnection.
      set({ activeProviderId: null });
      throw e;
    }
  },

  async disconnect() {
    const id = get().activeProviderId;
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
