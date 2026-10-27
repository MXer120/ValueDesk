/** Network + runtime configuration. */

export type Network = 'mainnet' | 'testnet';
export type Engine = 'spot' | 'perps';

export interface NetworkConfig {
  network: Network;
  chainId: number;
  restBase: string;
  wsBase: string;
}

export const NETWORKS: Record<Network, NetworkConfig> = {
  mainnet: {
    network: 'mainnet',
    chainId: 286623,
    restBase: 'https://mainnet-gw.sodex.dev',
    wsBase: 'wss://mainnet-gw.sodex.dev',
  },
  testnet: {
    network: 'testnet',
    chainId: 138565,
    restBase: 'https://testnet-gw.sodex.dev',
    wsBase: 'wss://testnet-gw.sodex.dev',
  },
};

import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { hostedConfigFromEnv, siteOriginsFrom, type HostedConfig } from './hosted.js';

/**
 * Load the repo-root `.env` before anything reads process.env.
 *
 * Without this the documented "copy .env.example to .env" flow silently does
 * nothing - the backend would keep using defaults while the user believed their
 * settings had applied. Uses Node's built-in loader (>= 20.6), so no dependency.
 * Real environment variables still win: loadEnvFile does not overwrite them.
 */
export const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));
export const ENV_FILE_LOADED = (() => {
  if (!existsSync(ENV_FILE)) return false;
  try {
    process.loadEnvFile(ENV_FILE);
    return true;
  } catch {
    return false;
  }
})();

const env = (k: string, fallback = ''): string => process.env[k]?.trim() || fallback;

/**
 * HOSTED MODE (VALUESCAN_HOSTED=1): this process as the public, read-only
 * index API - a route allow-list, no local token, per-client rate limits behind
 * the configured proxy, CORS for the site origins only, no WebSocket hub, and
 * nothing custodial whatever else the environment says. See hosted.ts.
 * Unset (the default), local dev behaves exactly as before.
 */
export const HOSTED_CONFIG: HostedConfig = hostedConfigFromEnv(process.env);
export const HOSTED = HOSTED_CONFIG.enabled;

/**
 * Mainnet is the default. Set SODEX_TESTNET=1 to work against testnet instead.
 *
 * This means real funds: orders placed here are real, and the UI shows a
 * standing mainnet warning plus a per-order confirmation.
 */
export const NETWORK: Network = env('SODEX_TESTNET', '0') === '1' ? 'testnet' : 'mainnet';
export const NET: NetworkConfig = NETWORKS[NETWORK];

export const PORT = Number.parseInt(env('PORT', '8787'), 10);
/** Bind to loopback only. This app is deliberately not exposed to a network. */
export const HOST = env('HOST', '127.0.0.1');

/** Where the encrypted API key lives. */
// fileURLToPath, not URL.pathname - the latter percent-encodes spaces, which
// breaks on any path like "C:\Users\me\My Documents\...".
export const KEYSTORE_PATH = env(
  'VALUETRADE_KEYSTORE',
  fileURLToPath(new URL('../.keystore.json', import.meta.url)),
);

/**
 * Optional bootstrap credentials for a headless run.
 *
 * DISABLED BY DEFAULT, and deliberately so. `SODEX_PRIVATE_KEY` puts a raw,
 * unencrypted signing key in `.env` - a plaintext file inside this project
 * folder, which is cloud-synced. That is strictly worse than the encrypted
 * keystore this app no longer writes, so it cannot be the path of least
 * resistance. Set VALUETRADE_ALLOW_ENV_KEY=1 to opt in, and only for a headless
 * or CI setup where no browser can approve a signature.
 *
 * The interactive flow needs none of this: it mints a key in memory from one
 * wallet signature.
 */
export const ALLOW_ENV_KEY = !HOSTED && env('VALUETRADE_ALLOW_ENV_KEY', '0') === '1';

export const BOOTSTRAP = {
  privateKey: env('SODEX_PRIVATE_KEY'),
  apiKeyName: env('SODEX_API_KEY'),
  accountId: env('SODEX_ACCOUNT_ID'),
  address: env('SODEX_ADDRESS'),
};

/**
 * Mainnet writes are enabled by default now that mainnet is the default network
 * - blocking them would make the app read-only out of the box. Set
 * VALUETRADE_ALLOW_MAINNET=0 to re-arm the guard (useful for a read-only setup).
 *
 * The remaining protections against an accidental real trade are the per-order
 * confirmation in the UI and the restricted (trade-only) signing key - see
 * PERMISSIONS_VERIFIED below for how far that restriction is established.
 */
export const ALLOW_MAINNET_WRITES = env('VALUETRADE_ALLOW_MAINNET', '1') !== '0';

/**
 * SERVER-SIDE SIGNING - Opentrade's model, where this process mints, holds and
 * uses a user's trading key - is OFF unless turned on for a local, single-user
 * setup. ValueDesk trades from the browser: the trading key is created, kept
 * and used there (apps/web/src/trading) and orders go straight to SoDEX, so a
 * hosted server holds nothing that can trade or move funds, and sees no order.
 * While this is off, every custodial route answers 410 (hosted.ts,
 * SERVER_SIGNING_PATHS) and no key session can exist in this process.
 * Hosted mode forces it off, whatever the variable says.
 */
export const SERVER_SIGNING = !HOSTED && env('VALUETRADE_SERVER_SIGNING', '0') === '1';

/**
 * Browser origins, besides loopback, allowed to call the write routes -
 * a hosted deployment's own site, e.g. `https://app.valuedesk.example`.
 * Comma-separated, exact origins. VALUESCAN_ALLOWED_ORIGINS, or the older
 * VALUETRADE_ALLOWED_ORIGINS.
 */
export const ALLOWED_ORIGINS: readonly string[] = env('VALUESCAN_ALLOWED_ORIGINS', env('VALUETRADE_ALLOWED_ORIGINS', ''))
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/**
 * Hosted mode's site origins, normalised: the ONLY origins its CORS answers
 * and the only Origin a state-changing request may carry (no loopback there).
 * A malformed entry stops the process at boot rather than silently opening or
 * closing the API.
 */
export const SITE_ORIGINS: readonly string[] = HOSTED ? siteOriginsFrom(ALLOWED_ORIGINS) : [];

/**
 * Whether the permission-mask semantics have been observed end to end.
 *
 * Every key this app mints carries a mask whose meaning comes from SoDEX's docs
 * and SDKs (a set bit DISABLES a permission) but has never been watched working:
 * no key from this codebase has placed an order or been refused a withdrawal.
 * The first version read the bits the other way round, and its "trade-only" key
 * was, per the docs, a withdraw-and-transfer key. So minting stays OFF on
 * mainnet until the testnet plan in docs/PERMISSION-MASK.md has passed and the
 * owner sets VALUETRADE_PERMISSIONS_VERIFIED=1. Testnet is unaffected - that is
 * where the plan runs.
 */
export const PERMISSIONS_VERIFIED = env('VALUETRADE_PERMISSIONS_VERIFIED', '0') === '1';

/** Why minting is refused, or null if it is allowed on this network. */
export const mintingBlockedReason = (
  network: Network = NETWORK,
  verified: boolean = PERMISSIONS_VERIFIED,
): string | null =>
  network === 'mainnet' && !verified
    ? 'Creating SoDEX API keys on mainnet is paused. What a permission mask actually allows has ' +
      'not been verified end to end yet (docs/PERMISSION-MASK.md). Run the testnet plan, then set ' +
      'VALUETRADE_PERMISSIONS_VERIFIED=1.'
    : null;

export const enginePath = (engine: Engine): string => `/api/v1/${engine}`;
export const wsPath = (engine: Engine): string => `/ws/${engine}`;
