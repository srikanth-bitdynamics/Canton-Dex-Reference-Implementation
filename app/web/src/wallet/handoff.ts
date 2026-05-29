// Wallet handoff dispatcher.
//
// Public API kept for backward compatibility with the rest of the dApp:
//   - `handToWallet(intent, opts?)` returns a Promise<WalletResult>
//   - intent shapes re-exported from `./types`
//
// What changed: dispatch now goes through the active WalletProvider from
// `./store`. The first provider is `WalletConnectProvider`; future
// providers (CIP-0103 native HTTP gateway, Dfns, Fireblocks, embedded
// internal wallet, ...) plug into the same interface and the rest of
// the dApp does not change.
//
// If no wallet is connected when an intent is submitted, the call
// rejects with a typed error the calling component can surface as
// "please connect a wallet" instead of an opaque failure.

import { getProvider } from "./registry";
import { useWalletStore } from "./store";
import type {
  WalletIntent,
  WalletResult,
} from "./types";

export type {
  AcceptAllocationRequestIntent,
  RemoveLiquidityIntent,
  AcceptRfqIntent,
  AddLiquidityIntent,
  PlaceOrderIntent,
  PostRfqQuoteIntent,
  RequestSwapIntent,
  WalletIntent,
  WalletResult,
  WalletAccount,
  WalletConnectionStatus,
  WalletProvider,
  Party,
  ContractId,
} from "./types";

export class WalletNotConnectedError extends Error {
  constructor() {
    super("No wallet connected. Open Connect Wallet to authorise this action.");
    this.name = "WalletNotConnectedError";
  }
}

/**
 * Hand the intent to the connected wallet. The legacy `opts` argument
 * (preferPostMessage / walletBaseUrl / targetWindow) is accepted but
 * ignored: provider selection now lives in the wallet store. Callers
 * that previously passed `{ preferPostMessage: true }` continue to work
 * without changes; the active provider decides the actual transport.
 */
export async function handToWallet(
  intent: WalletIntent,
  _opts: Record<string, unknown> = {},
): Promise<WalletResult> {
  const providerId = useWalletStore.getState().activeProviderId;
  if (!providerId) throw new WalletNotConnectedError();
  return getProvider(providerId).submit(intent);
}
