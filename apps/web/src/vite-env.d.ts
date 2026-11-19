/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WalletConnect Cloud / Reown project id. Required for QR pairing. */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Where "Send feedback" goes (a Discord invite, https). Unset: the built-in form (src/feedback). */
  readonly VITE_FEEDBACK_URL?: string;
  /** `beta` for beta.valuedesk.so (deploy/vercel/beta.settings): the beta list's door first (src/beta/). */
  readonly VITE_CHANNEL?: string;
}

/** The build's name (vite.config.ts buildId); read through src/buildInfo.ts. */
declare const __VS_BUILD__: string | undefined;
/** True in a build: the catalogues come in parts, one per chunk (tools/i18n-parts.mjs, src/i18n/store.ts). */
declare const __VS_I18N_PARTS__: boolean | undefined;

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
