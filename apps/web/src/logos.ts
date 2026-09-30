/**
 * Coin and chain icons, served from our own origin.
 *
 * The files live in public/logos/ and are written by tools/fetch-logos.mjs
 * (sodex.com's icon set plus the listings it has no icon for); the app never
 * asks SoDEX or anyone else for an image at runtime. Anything without an icon
 * gets a letter avatar from the component, so a brand-new listing still renders.
 */
import { BRAND_LOGOS, CHAIN_LOGOS, COIN_LOGOS } from './logoManifest';
import { VENUE_BRAND_LOGOS, VENUE_COIN_LOGOS } from './logoManifestVenues';
import { resolveKey } from './logoKey';

const BASE = (() => {
  const b = import.meta.env?.BASE_URL;
  return typeof b === 'string' && b ? (b.endsWith('/') ? b : `${b}/`) : '/';
})();

const url = (rel: string | undefined): string | null => (rel ? `${BASE}logos/${rel}` : null);

/** The icon for any SoDEX spelling of a coin or market: vBTC, BTC-USD, vBTC_vUSDC, BTC/USDC, vsMAG7.ssi... */
export function coinLogo(name: string | null | undefined): string | null {
  // SoDEX's set first (sodex.com's own icons), then the other venues' (Hyperliquid, Lighter, Arcus).
  return url(resolveKey(name, COIN_LOGOS) ?? resolveKey(name, VENUE_COIN_LOGOS));
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

/**
 * The letter avatar's disc colour: deterministic per name, for listings newer
 * than the icon set.
 *
 * NO --warn IN HERE, and no warm greys. The first entry used to be #ffb547,
 * which IS `--warn` - so a coin disc could render in the one hue this app
 * reserves for "something needs your attention", 18px from the loudest number
 * on the page. Three more were leftovers from the warm scheme; #996d2b lands
 * 2.6:1 ink and is unreadable.
 */
const COIN_COLORS = ['#00b481', '#ef4a3c', '#bcbcbc', '#7b7b7b', '#d4d4d4', '#f7f7f7'];
export function coinColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COIN_COLORS[h % COIN_COLORS.length]!;
}

/** A venue's own mark (SODEX, HYPERLIQUID, TRADEXYZ, LIGHTER, ARCUS), or null. */
export function brandLogo(key: string): string | null {
  const k = key.toUpperCase();
  return url(BRAND_LOGOS[k] ?? VENUE_BRAND_LOGOS[k]);
}

/** The letter a letter-avatar shows for a coin: the asset's own first letter, not the v/a/vs prefix. */
export function coinInitial(name: string | null | undefined): string {
  const n = (name ?? '').trim().replace(/^vs(?=[A-Z0-9])/, '').replace(/^[va](?=[A-Z0-9])/, '');
  return n.charAt(0).toUpperCase() || '?';
}
