/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  /** Reown / WalletConnect Cloud project id. Get one at cloud.reown.com. */
  readonly VITE_WC_PROJECT_ID?: string;
  /** CAIP network id for the target Canton network, e.g. canton:devnet. */
  readonly VITE_CANTON_NETWORK_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
