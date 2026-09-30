/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WalletConnect Cloud / Reown project id. Required for QR pairing. */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
