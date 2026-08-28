/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  /** Published documentation URL opened by the app navigation. */
  readonly VITE_DOCS_URL?: string;
  /** Reown / WalletConnect Cloud project id. Get one at cloud.reown.com. */
  readonly VITE_WC_PROJECT_ID?: string;
  /** CAIP network id for the target Canton network, e.g. canton:devnet. */
  readonly VITE_CANTON_NETWORK_ID?: string;
  readonly VITE_CANTON_SYNCHRONIZER?: string;
  readonly VITE_CANTON_DEX_PACKAGE_ID?: string;
  readonly VITE_CANTON_DEFAULT_PARTY?: string;
  readonly VITE_CANTON_USER_ID?: string;
  readonly VITE_ENABLE_SDK?: string;
  readonly VITE_WALLET_GATEWAY_URL?: string;
  readonly VITE_WALLET_GATEWAY_NAME?: string;
  readonly VITE_WALLET_SHOW_FULL_CATALOG?: string;
  readonly VITE_ENABLE_PARTYLAYER?: string;
  /** Enable the explicitly custodial RFQ write UI in a production build. */
  readonly VITE_ENABLE_HOSTED_RFQ?: string;
  readonly VITE_PARTYLAYER_APP_NAME?: string;
  readonly VITE_PARTYLAYER_NETWORK?: string;
  readonly VITE_PARTYLAYER_WALLET_IDS?: string;
  readonly VITE_PARTYLAYER_REGISTRY_URL?: string;
  readonly VITE_PARTYLAYER_REGISTRY_CHANNEL?: string;
  readonly VITE_PARTYLAYER_CONNECT_TIMEOUT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
