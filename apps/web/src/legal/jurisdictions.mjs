/**
 * Where ValueDesk may be used: ONE list, read by
 *   - the edge: deploy/vercel/package.mjs turns it into Vercel routes that answer
 *     451 for the whole site (the legal pages excepted) and into the /api
 *     function's own refusal (api-proxy.cjs);
 *   - the app: legal/geo.ts (the visitor's country as Vercel's edge reports it)
 *     and trading/legalGate.ts (no new position from a restricted place);
 *   - the texts: terms.ts and risk.ts name every entry, and legal/docs.test.ts
 *     fails when one is missing.
 * Plain JavaScript (types in jurisdictions.d.mts) because package.mjs runs under
 * plain Node on Vercel's build machine, without tsx.
 *
 * TWO LEVELS
 *   blocked     the whole site: the edge answers 451 Unavailable For Legal
 *               Reasons, the app shows only the legal pages. The same seven
 *               countries the copy rules block (packages/copy-engine/src/policy.ts
 *               SANCTIONED; why each, below) - and the regions
 *               of Ukraine under OFAC's and the EU's territorial sanctions,
 *               by Vercel's region header (x-vercel-ip-country-region: the
 *               ISO 3166-2 subdivision, without the country).
 *   close-only  the site works (data, the legal pages), but nothing that opens or
 *               increases a position: no new order, no algo, no copy, no deposit
 *               prompt. Closing, cancelling, reduce-only orders, transfers between
 *               the wallet's own accounts and withdrawals stay possible, so nobody
 *               is locked into a position. The United States and its territories,
 *               as for copy trading (owner's decision for copying, 2026-10-23).
 *               WHETHER THIS LEVEL APPLIES TO MANUAL TRADING, AND WHICH FURTHER
 *               COUNTRIES BELONG HERE (e.g. Canada / Ontario, the United Kingdom),
 *               IS THE OWNER'S DECISION: docs/legal/OWNER-DECISIONS.md.
 *
 * Changing a list changes the Terms of use (they name every entry): raise
 * SITE_TERMS_VERSION (legal/acceptance.ts) with it, so every wallet accepts the
 * new terms. The copy rules must stay at least as strict (docs.test.ts checks
 * that every country here is excluded from copy trading as well).
 */

/**
 * The whole site is unavailable. Russia and Belarus: EU Regulations 833/2014
 * Art. 5b and 765/2006 Art. 1u forbid crypto-asset services to persons there;
 * Cuba, Iran, North Korea: comprehensive US sanctions; Iran, North Korea and
 * Myanmar: FATF's call for action. SYRIA is kept although the US (July 2025, the
 * Caesar Act repealed in December 2025) and the EU (May 2025) lifted most of
 * their Syria sanctions: dropping it is the owner's decision, like every change
 * here (docs/legal/OWNER-DECISIONS.md).
 */
export const SANCTIONED_COUNTRIES = Object.freeze([
  Object.freeze({ code: 'CU', name: 'Cuba' }),
  Object.freeze({ code: 'IR', name: 'Iran' }),
  Object.freeze({ code: 'KP', name: 'North Korea' }),
  Object.freeze({ code: 'SY', name: 'Syria' }),
  Object.freeze({ code: 'RU', name: 'Russia' }),
  Object.freeze({ code: 'BY', name: 'Belarus' }),
  Object.freeze({ code: 'MM', name: 'Myanmar' }),
]);

/**
 * Regions under territorial sanctions (OFAC's Crimea and so-called DNR / LNR
 * programmes; EU Regulations 692/2014 and 2022/263). ISO 3166-2:UA codes.
 * Zaporizhzhia (23) and Kherson (65) are under EU sanctions only in the areas
 * not controlled by the Ukrainian government, which an IP address cannot tell
 * apart: they are not blocked (docs/legal/OWNER-DECISIONS.md).
 */
export const SANCTIONED_REGIONS = Object.freeze([
  Object.freeze({ country: 'UA', region: '43', name: 'Crimea' }),
  Object.freeze({ country: 'UA', region: '40', name: 'Sevastopol' }),
  Object.freeze({ country: 'UA', region: '14', name: 'Donetsk' }),
  Object.freeze({ country: 'UA', region: '09', name: 'Luhansk' }),
]);

/** Close-only: no new or larger positions through ValueDesk. */
export const CLOSE_ONLY_COUNTRIES = Object.freeze([
  Object.freeze({ code: 'US', name: 'United States' }),
  Object.freeze({ code: 'PR', name: 'Puerto Rico' }),
  Object.freeze({ code: 'VI', name: 'US Virgin Islands' }),
  Object.freeze({ code: 'GU', name: 'Guam' }),
  Object.freeze({ code: 'AS', name: 'American Samoa' }),
  Object.freeze({ code: 'MP', name: 'Northern Mariana Islands' }),
  Object.freeze({ code: 'UM', name: 'US Minor Outlying Islands' }),
]);

/**
 * The legal pages (router.ts LEGAL_PAGES - docs.test.ts checks the two agree): the
 * edge serves them even where the rest of the site is blocked, so who runs the site,
 * what it does with data and why it is blocked can be read from anywhere.
 */
export const LEGAL_PATHS = Object.freeze(['impressum', 'privacy', 'terms', 'risk', 'cookies', 'copy-terms']);

const codes = (list) => list.map((c) => c.code);
export const SANCTIONED_CODES = Object.freeze(codes(SANCTIONED_COUNTRIES));
export const CLOSE_ONLY_CODES = Object.freeze(codes(CLOSE_ONLY_COUNTRIES));

/** 'de' / ' DE ' -> 'DE'; not two letters, 'XX' (unknown), 'T1' (Tor) -> null. As policy.ts normaliseCountry. */
export function normaliseCountry(c) {
  if (typeof c !== 'string') return null;
  const t = c.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(t) || t === 'XX' || t === 'ZZ') return null;
  return t;
}

/** A region code as Vercel sends it: one to three letters or digits, else null. */
export function normaliseRegion(r) {
  if (typeof r !== 'string') return null;
  const t = r.trim().toUpperCase();
  return /^[A-Z0-9]{1,3}$/.test(t) ? t : null;
}

const nameOf = (code) =>
  [...SANCTIONED_COUNTRIES, ...CLOSE_ONLY_COUNTRIES].find((c) => c.code === code)?.name ?? code;

/**
 * The access a visitor has, from where the edge saw the request (`country`,
 * `region`) and, once a wallet has accepted the terms, the country of residence
 * it declared (`declared`). The stricter answer wins, like the copy rules.
 * Unknown (null) observations restrict nothing: the declaration still counts.
 *
 * @returns {{ level: 'open' | 'close-only' | 'blocked', country: string | null, place: string | null, reason: string | null, source: 'observed' | 'declared' | null }}
 */
export function siteAccess({ country, region, declared } = {}) {
  const seen = normaliseCountry(country);
  const where = normaliseRegion(region);
  const said = normaliseCountry(declared);
  const blockedRegion = seen && where ? SANCTIONED_REGIONS.find((r) => r.country === seen && r.region === where) : undefined;
  if (blockedRegion) return blocked(seen, blockedRegion.name, 'observed');
  if (seen && SANCTIONED_CODES.includes(seen)) return blocked(seen, nameOf(seen), 'observed');
  if (said && SANCTIONED_CODES.includes(said)) return blocked(said, nameOf(said), 'declared');
  if (seen && CLOSE_ONLY_CODES.includes(seen)) return closeOnly(seen, 'observed');
  if (said && CLOSE_ONLY_CODES.includes(said)) return closeOnly(said, 'declared');
  return { level: 'open', country: said ?? seen, place: null, reason: null, source: null };
}

function blocked(country, place, source) {
  return {
    level: 'blocked',
    country,
    place,
    reason: `ValueDesk is not available in ${place}: the sanctions and legal restrictions that apply there do not allow us to offer it.`,
    source,
  };
}

function closeOnly(country, source) {
  return {
    level: 'close-only',
    country,
    place: nameOf(country),
    reason: 'Trading through ValueDesk is not available to residents of the United States or its territories, or to anyone connecting from there. You can still close positions, cancel orders and withdraw.',
    source,
  };
}

/** For the edge: the routes' `has` lists. */
export function edgeBlockList() {
  return {
    countries: [...SANCTIONED_CODES],
    regions: SANCTIONED_REGIONS.map((r) => ({ country: r.country, region: r.region })),
  };
}
