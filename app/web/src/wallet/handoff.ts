// Dispatch wallet intents through the provider selected in the wallet store.

import { getProvider } from "./registry";
import { useWalletStore } from "./store";
import type {
  WalletIntent,
  WalletResult,
} from "./types";

export type {
  FundOrderIntent,
  RemoveLiquidityIntent,
  AddLiquidityIntent,
  PlaceOrderIntent,
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

/** Hand an intent to the connected wallet. */
export async function handToWallet(intent: WalletIntent): Promise<WalletResult> {
  const providerId = useWalletStore.getState().activeProviderId;
  if (!providerId) throw new WalletNotConnectedError();
  return getProvider(providerId).submit(intent);
}
