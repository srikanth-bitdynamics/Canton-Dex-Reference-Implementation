/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  /** Reown / WalletConnect Cloud project id. Get one at cloud.reown.com. */
  readonly VITE_WC_PROJECT_ID?: string;
  /** CAIP network id for the target Canton network, e.g. canton:devnet. */
  readonly VITE_CANTON_NETWORK_ID?: string;
  readonly VITE_ENABLE_PARTYLAYER?: string;
  readonly VITE_PARTYLAYER_APP_NAME?: string;
  readonly VITE_PARTYLAYER_NETWORK?: string;
  readonly VITE_PARTYLAYER_WALLET_IDS?: string;
  readonly VITE_PARTYLAYER_REGISTRY_URL?: string;
  readonly VITE_PARTYLAYER_REGISTRY_CHANNEL?: string;
  /**
   * Testnet builds only: offer the hosted-party option ("Create testnet
   * party") and the not-hosted-here notice. Requires the backend to run with
   * DEX_TESTNET_ONBOARDING=1.
   */
  readonly VITE_ENABLE_TESTNET_PARTY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
