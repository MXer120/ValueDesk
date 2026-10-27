/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WalletConnect Cloud / Reown project id. Required for QR pairing. */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Where "Send feedback" goes (a Discord invite, https). Unset: the built-in form (src/feedback). */
  readonly VITE_FEEDBACK_URL?: string;
}

/** The build's name (vite.config.ts buildId); read through src/buildInfo.ts. */
declare const __VS_BUILD__: string | undefined;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
