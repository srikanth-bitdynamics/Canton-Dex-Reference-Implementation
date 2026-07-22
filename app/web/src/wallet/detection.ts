// Combined wallet discovery.
//
// Queries every detection-capable provider's `listWallets()` (dapp-sdk:
// gateway + injected + announced; PartyLayer: its catalog with install
// detection), merges them into one ordered list, and appends the remaining
// providers (WalletConnect, the dev relay, mock) as single rows — so the
// Connect picker shows exactly the wallets available in this deployment and
// routes each pick back to its owning provider.

import { getProviders, DEFAULT_PROVIDER_ID, type WalletProviderId } from "./registry";
import { capabilityFor } from "./capabilities";
import type { DetectedWallet, WalletProvider } from "./types";

/** A single row rendered by the wallet picker. */
export interface PickerRow {
  /** Unique row id. */
  readonly id: string;
  /** Owning provider — passed to `store.connect(providerId, walletId)`. */
  readonly providerId: WalletProviderId;
  /** Sub-wallet id within the provider, if any. */
  readonly walletId?: string;
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly badge?: string;
  /** From detection: true installed, false not-installed, undefined unknown. */
  readonly installed?: boolean;
  readonly installUrl?: string;
  /** Not-installed catalog entry: greyed out; clicking opens `installUrl`. */
  readonly disabled?: boolean;
  /** Dev-only relay / mock — labelled and de-emphasised. */
  readonly devOnly?: boolean;
  /** The real-wallet default for this deployment (see registry). */
  readonly recommended?: boolean;
}

/** Include PartyLayer catalog entries that report not-installed (greyed rows
 * with an install link) instead of hiding them. Off by default so the picker
 * only lists wallets that actually work here. */
const SHOW_FULL_CATALOG =
  ((import.meta.env.VITE_WALLET_SHOW_FULL_CATALOG ?? "") as string) === "1";

async function safeList(
  p: WalletProvider,
): Promise<readonly DetectedWallet[]> {
  try {
    return p.listWallets ? await p.listWallets() : [];
  } catch {
    // A provider whose discovery throws (SDK load failure, gateway unreachable)
    // must not sink the whole picker — it just contributes no rows.
    return [];
  }
}

/**
 * Discover every connectable wallet in this deployment, as ordered picker rows.
 * Detection-capable providers run concurrently; a provider that fails discovery
 * is skipped, not fatal.
 */
export async function discoverWallets(): Promise<PickerRow[]> {
  const providers = [...getProviders().values()];
  const detectionCapable = providers.filter(
    (p) => typeof p.listWallets === "function",
  );
  const others = providers.filter((p) => typeof p.listWallets !== "function");

  const detected = await Promise.all(detectionCapable.map(safeList));

  const rows: PickerRow[] = [];
  const seen = new Set<string>();
  // "recommended" marks a SINGLE wallet — the first connectable row of the
  // default provider — not every row that provider owns (a multi-wallet
  // provider like PartyLayer would otherwise tag its whole catalog).
  let recommendedAssigned = false;
  const claimRecommended = (providerId: WalletProviderId, eligible: boolean): boolean => {
    if (recommendedAssigned || providerId !== DEFAULT_PROVIDER_ID || !eligible) {
      return false;
    }
    recommendedAssigned = true;
    return true;
  };

  for (const list of detected) {
    for (const w of list) {
      const notInstalled = w.installed === false;
      if (notInstalled && !SHOW_FULL_CATALOG) continue;
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      const providerId = w.providerId as WalletProviderId;
      rows.push({
        id: w.id,
        providerId,
        walletId: w.walletId,
        name: w.name,
        description: w.description,
        icon: w.icon,
        badge: w.badge,
        installed: w.installed,
        installUrl: w.installUrl,
        disabled: notInstalled,
        // Don't recommend a not-installed wallet.
        recommended: claimRecommended(providerId, !notInstalled),
      });
    }
  }

  // Providers without discovery (WalletConnect, dev relay, mock) each become a
  // single row, carrying their capability note so the picker stays informative.
  for (const p of others) {
    const providerId = p.id as WalletProviderId;
    const cap = capabilityFor(providerId);
    const devOnly = cap.dvp === "dev-only";
    rows.push({
      id: `provider:${providerId}`,
      providerId,
      name: p.label,
      description: cap.note,
      badge: devOnly ? "Dev" : undefined,
      devOnly,
      // A dev-only relay is never "recommended" even if it's the dev default.
      recommended: claimRecommended(providerId, !devOnly),
    });
  }

  return rows;
}
