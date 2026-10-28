/**
 * Coin and chain icons, served from our own origin.
 *
 * The files live in public/logos/ and are written by tools/fetch-logos.mjs
 * (sodex.com's icon set), tools/fetch-site-logos.mjs (the owners' own icons from
 * their own sites, and CC0 icons, for what SoDEX's set lacks) and
 * tools/fetch-venue-logos.mjs (Hyperliquid's set); the app never asks SoDEX or
 * anyone else for an image at runtime. No TradingView, CoinGecko or DefiLlama
 * image is used (licence review 2026-10-28). No letter is ever drawn (owner,
 * 2026-10-28): a coin no allowed source has an icon for carries the mark of the
 * venue it trades on (fetch-venue-logos.mjs writes that into the manifest), and
 * CoinIcon falls back to venueMark() for a brand-new listing or a broken file.
 */
import { BRAND_LOGOS, CHAIN_LOGOS, COIN_LOGOS } from './logoManifest';
import { VENUE_BRAND_LOGOS, VENUE_COIN_LOGOS } from './logoManifestVenues';
import { SITE_COIN_LOGOS } from './logoManifestSites';
import { resolveKey } from './logoKey';

const BASE = (() => {
  const b = import.meta.env?.BASE_URL;
  return typeof b === 'string' && b ? (b.endsWith('/') ? b : `${b}/`) : '/';
})();

const url = (rel: string | undefined): string | null => (rel ? `${BASE}logos/${rel}` : null);

/** The icon for any SoDEX spelling of a coin or market: vBTC, BTC-USD, vBTC_vUSDC, BTC/USDC, vsMAG7.ssi... */
export function coinLogo(name: string | null | undefined): string | null {
  // SoDEX's set first (sodex.com's own icons), then the owners' own (fetch-site-logos.mjs), then the other venues' (Hyperliquid's set).
  return url(resolveKey(name, COIN_LOGOS) ?? resolveKey(name, SITE_COIN_LOGOS) ?? resolveKey(name, VENUE_COIN_LOGOS));
}

/**
 * The icon for a SoDEX chain key (BASE_ETH, ARBITRUM_ETH, VALUECHAIN, SOL...).
 * Falls back to the coin of the same name, so a chain added later that is
 * named after its gas token (e.g. a new L1) still gets that coin's icon.
 */
export function chainLogo(chain: string | null | undefined): string | null {
  const key = (chain ?? '').trim().toUpperCase();
  if (!key) return null;
  return url(CHAIN_LOGOS[key] ?? CHAIN_LOGOS[key.replace(/[\s-]+/g, '_')] ?? resolveKey(key, COIN_LOGOS));
}

/** A venue's own mark (SODEX, HYPERLIQUID, TRADEXYZ, LIGHTER, ARCUS), or null. */
export function brandLogo(key: string): string | null {
  const k = key.toUpperCase();
  return url(BRAND_LOGOS[k] ?? VENUE_BRAND_LOGOS[k]);
}

/**
 * The mark CoinIcon falls back to: the venue's own (SoDEX's when the venue is
 * not known - this is a SoDEX front end), so a listing newer than the icon set
 * or a file that fails to load still shows a logo, never a letter.
 */
export function venueMark(venue: string | null | undefined): string | null {
  const k = (venue ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (k && brandLogo(k)) || brandLogo('SODEX');
}
