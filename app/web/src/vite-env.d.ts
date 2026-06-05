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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
