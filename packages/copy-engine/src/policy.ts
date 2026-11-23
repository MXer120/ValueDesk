/**
 * Who may copy, under which limits, and at which fee.
 *
 * REGIONS (owner's decision, 2026-10-23):
 *   - blocked: the United States and its territories, the United Kingdom and
 *     Canada (owner's decision, 2026-10-27), and the countries under
 *     comprehensive sanctions or on FATF's call-for-action list. Nobody there
 *     may start or keep a copy, in any mode;
 *   - everyone else, the EEA included: the follower's own leverage cap. The EEA
 *     2x cap (2026-10-23) is removed (owner 2026-11-10: "remove everywhere"):
 *     copies, algo orders and bots use the leverage the follower sets, up to the
 *     market's maximum. The region 'eea' is still told apart (records, tests).
 *
 * WHICH COUNTRY. The country the follower declares when accepting the terms,
 * and - where a server sees the request - the country of the IP address it
 * came from. The STRICTER of the two applies, and a mismatch is recorded.
 * Neither is proof (a VPN changes the second, a lie the first); the terms make
 * the declaration the follower's own responsibility.
 *
 * THE COPY FEE (owner's decision, 2026-10-23): the copy ladder of
 * docs/BUILDER-TIERS.md, by the follower's verified volume of the last 14
 * days, in tenths of a basis point. It is disclosed before copying starts and
 * every follower approves its ceiling on SoDEX themselves.
 */

/**
 * The copy-trading terms every follower accepts (by wallet signature) before copying.
 * Bump it with every change to the terms (apps/web/src/legal/copyTerms.ts): every
 * follower then accepts the new text before their next change. '.2': counter-trading.
 * 2026-10-27: algo orders on the executors, and keys the follower made themselves; '.2': keys live up to 180 days;
 * '.3': the United Kingdom and Canada excluded, sanctioned wallets screened by the executor, the domain www.valuedesk.so.
 * 2026-10-28: security incidents and the emergency brake, a hacked executor, rate limits, software errors named,
 * the follower's duties to report errors and limit what is at stake, the liability clause rewritten (BGB §§ 307-309).
 * 2026-11-10: the EEA 2x leverage cap removed (owner 2026-11-10).
 * 2026-11-02: bots (the Bots page) - what they do, that they can lose, no wash trading, no fills between different
 * users' bots, and their 0.5 bp fee in place of the normal one (owner, 2026-11-02; charged 0.1 bp since 2026-11-04, BOT_FEE).
 */
export const COPY_TERMS_VERSION = '2026-11-23';

/**
 * The oldest version whose signature still counts (owner 2026-11-23: "never need to sign it except once"). A new text
 * no longer asks anybody again: a wallet that signed this version or any later one is done. Raise it ONLY when the law
 * or a change that takes rights away really needs a new signature from everybody, and only on the owner's word:
 * terms-docs.test.ts pins it.
 */
export const COPY_TERMS_VALID_FROM = '2026-11-23';

/** A terms version as numbers: 2026-10-24.2 -> [2026, 10, 24, 2]. Null when it is not one. */
const versionParts = (v: string): number[] | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : null;
};
/** Whether a signed version is `from` or later. */
export function termsVersionSince(v: unknown, from: string): boolean {
  const a = typeof v === 'string' ? versionParts(v) : null;
  const b = versionParts(from);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}
/** A signature of this version of the copy and bot terms still counts. */
export const copyTermsValid = (v: unknown): boolean => termsVersionSince(v, COPY_TERMS_VALID_FROM);

/** US and its territories (US persons). */
export const US_REGIONS: readonly string[] = ['US', 'PR', 'VI', 'GU', 'AS', 'MP', 'UM'];

/**
 * The United Kingdom and Canada (owner's decision, 2026-10-27): excluded as the US is - from copying
 * here, close-only on the site (apps/web/src/legal/jurisdictions.mjs). The UK alone: not the Crown
 * Dependencies (Jersey, Guernsey, the Isle of Man) or the British Overseas Territories (Gibraltar,
 * Bermuda, ...), which have their own financial regulators and are outside the FCA's retail ban on
 * crypto derivatives. Canada as a whole, not only Ontario: an IP address does not reliably tell the
 * province, and the declaration asks for a country.
 */
export const UK_CA_REGIONS: readonly string[] = ['GB', 'CA'];

/** Close-only on the site and excluded from copying: the US and its territories, the UK, Canada. */
export const CLOSE_ONLY_REGIONS: readonly string[] = [...US_REGIONS, ...UK_CA_REGIONS];

/** Comprehensive sanctions (OFAC/EU/UN) and FATF's call-for-action list. */
export const SANCTIONED: readonly string[] = ['CU', 'IR', 'KP', 'SY', 'RU', 'BY', 'MM'];

export const BLOCKED_COUNTRIES: readonly string[] = [...CLOSE_ONLY_REGIONS, ...SANCTIONED];

/** Why a follower from a close-only place cannot copy, by place. */
const CLOSE_ONLY_NAMES: Readonly<Record<string, string>> = { GB: 'the United Kingdom', CA: 'Canada' };

/**
 * The EU's 27 plus Iceland, Liechtenstein and Norway, and the parts of the EU with their
 * own ISO country code: the outermost regions Reunion, Guadeloupe, Martinique, French
 * Guiana, Mayotte and Saint-Martin, and Aland (Finland). They are EU territory, so the
 * EU's retail rules (and the 2x cap) apply there too.
 */
export const EEA_COUNTRIES: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
  'RE', 'GP', 'MQ', 'GF', 'YT', 'MF', 'AX',
];

/** ESMA's retail leverage limit for crypto CFDs (50% initial margin). No longer applied (owner 2026-11-10); kept for the records of copies made under it. */
export const EEA_MAX_LEVERAGE = 2;

/** The highest leverage the copier ever sets, whatever the market allows. */
export const ABSOLUTE_MAX_LEVERAGE = 50;

export type Region = 'blocked' | 'eea' | 'other';

export interface RegionPolicy {
  region: Region;
  allowed: boolean;
  /** Leverage ceiling for this follower; null = the follower's own cap only. */
  maxLeverage: number | null;
  /** Why copying is refused or limited, in plain words. */
  reason: string | null;
  /** The country the policy was decided on (the stricter one). */
  country: string | null;
  /** Declared and observed differ. */
  mismatch: boolean;
  /**
   * Refused, but closing is still allowed: a close-only place (the US and its territories, the UK, Canada),
   * and neither the declared nor the seen country sanctioned. Reduce-only algos run there (algo/spec.ts
   * algoClosesOnly); copies stay refused. Absent: false.
   */
  closeOnly?: boolean;
}

const ISO2 = /^[A-Z]{2}$/;

/**
 * 'de' / ' DE ' -> 'DE'; anything that is not two letters -> null. 'XX' / 'T1' (unknown, Tor) -> null.
 * 'UK' (reserved in ISO 3166-1 for the United Kingdom, whose code is GB) -> 'GB', so it cannot slip past the UK's rule.
 */
export function normaliseCountry(c: string | null | undefined): string | null {
  if (typeof c !== 'string') return null;
  const t = c.trim().toUpperCase();
  if (!ISO2.test(t) || t === 'XX' || t === 'ZZ') return null;
  return t === 'UK' ? 'GB' : t;
}

export const regionOf = (country: string | null): Region =>
  country === null ? 'other' : BLOCKED_COUNTRIES.includes(country) ? 'blocked' : EEA_COUNTRIES.includes(country) ? 'eea' : 'other';

const RANK: Record<Region, number> = { blocked: 2, eea: 1, other: 0 };

/**
 * The policy for a follower who DECLARED `declared` and was SEEN at `observed`
 * (null where no server saw the request). A follower who declares nothing may
 * not copy: the declaration is part of accepting the terms.
 */
export function regionPolicy(declared: string | null | undefined, observed?: string | null): RegionPolicy {
  const d = normaliseCountry(declared);
  const o = normaliseCountry(observed ?? null);
  const mismatch = d !== null && o !== null && d !== o;
  if (d === null) {
    return { region: 'blocked', allowed: false, maxLeverage: null, reason: 'Choose your country of residence to copy trades.', country: null, mismatch };
  }
  const rd = regionOf(d);
  const ro = o === null ? 'other' : regionOf(o);
  const region = RANK[ro] > RANK[rd] ? ro : rd;
  const country = RANK[ro] > RANK[rd] ? o : d;
  if (region === 'blocked') {
    const us = country !== null && US_REGIONS.includes(country);
    const named = country !== null ? CLOSE_ONLY_NAMES[country] : undefined;
    // Close-only, not sanctioned: either country on the sanctions list (declared or seen) closes that door too.
    const sanctioned = [d, o].some((c) => c !== null && SANCTIONED.includes(c));
    return {
      region,
      allowed: false,
      closeOnly: !sanctioned && country !== null && CLOSE_ONLY_REGIONS.includes(country),
      maxLeverage: null,
      reason: us
        ? 'Copy trading is not available to residents of the United States or its territories, or to anyone connecting from there.'
        : named
          ? `Copy trading is not available to residents of ${named}, or to anyone connecting from there.`
          : 'Copy trading is not available in your country or from where you are connecting.',
      country,
      mismatch,
    };
  }
  return { region, allowed: true, maxLeverage: null, reason: null, country, mismatch };
}

/** The leverage a copy may use: the follower's cap, the region's, the market's, and the absolute ceiling. */
export function effectiveLeverage(settingsMax: number, policy: Pick<RegionPolicy, 'maxLeverage'>, marketMax?: number): number {
  let lev = Math.min(settingsMax, ABSOLUTE_MAX_LEVERAGE);
  if (policy.maxLeverage !== null) lev = Math.min(lev, policy.maxLeverage);
  if (marketMax !== undefined && Number.isFinite(marketMax) && marketMax > 0) lev = Math.min(lev, marketMax);
  return Math.max(1, Math.floor(lev));
}

/* ------------------------------------------------------------- the fee ----- */

/** One step of the copy ladder: from `fromUsd` of 14-day volume, `fee` tenths of a bp. */
export interface CopyFeeStep {
  fromUsd: number;
  fee: number;
}

/** docs/BUILDER-TIERS.md, "Copy trades" (owner, 2026-10-04; charged from 2026-10-23). */
export const COPY_FEE_LADDER: readonly CopyFeeStep[] = [
  { fromUsd: 0, fee: 25 },
  { fromUsd: 100_000, fee: 20 },
  { fromUsd: 500_000, fee: 15 },
  { fromUsd: 2_000_000, fee: 12 },
  { fromUsd: 10_000_000, fee: 10 },
];

/** The volume window the ladder counts. */
export const COPY_FEE_WINDOW_DAYS = 14;

/** The highest copy fee: what a follower's SoDEX approval must cover. */
export const COPY_FEE_MAX = COPY_FEE_LADDER[0]!.fee;

/** The copy fee for a follower with `volumeUsd` of verified 14-day volume (null = unknown: the default). */
export function copyFeeFor(volumeUsd: number | null | undefined, ladder: readonly CopyFeeStep[] = COPY_FEE_LADDER): number {
  let fee = ladder[0]!.fee;
  if (typeof volumeUsd !== 'number' || !Number.isFinite(volumeUsd)) return fee;
  for (const step of ladder) if (volumeUsd >= step.fromUsd) fee = step.fee;
  return fee;
}

/**
 * THE BOT FEE: every order of a bot (the Bots page: the volume maker, the Binance-led maker, the grid) carries
 * 1 tenth of a bp (0.1 bp), whatever the volume - not the copy ladder. Owner 2026-11-02: "Builder fee needs to be
 * low - probably 0.5bps"; lowered to 0.1 bp on 2026-11-04 ("change builder fee to 0.1bps") to beat a rival's all-in cost
 * (SoDEX's 1.2 bp maker fee + 0.1 bp = a 1.3 bp floor). SoDEX charges each order the fee it names, up to the
 * follower's approved ceiling, so the copy approval (COPY_FEE_MAX) covers it and a follower approves nothing new.
 * The terms of 2026-11-02 name 0.5 bp: a bot is charged less than they say, until their next version.
 */
export const BOT_FEE = 1;

/**
 * THE BOT FEE LADDER (owner 2026-11-08, replacing the flat BOT_FEE): tenths of a bp by 14-day volume, from 0.5 bp
 * down to 0.1 bp in steps SoDEX can carry (a builder fee is a whole number of tenths), most users at 0.2 bp. VIP pays
 * the lowest step; a wallet on the beta list is VIP for its first 30 days (BETA_VIP_DAYS, from its first bot).
 * The terms name 0.5 bp: the top step stays within them. Not live until the executor that uses it ships.
 */
export const BOT_FEE_LADDER: readonly CopyFeeStep[] = [
  // Owner 2026-11-10: every step 0.1 bp (0.001%) higher than 2026-11-09's 0.3 / 0.2 bp, and a third step from $1M;
  // the lowest fee (0.1 bp) is VIP's only, from $5M (server builder/service.ts VIP_MIN_USD). Within the terms' 0.5 bp.
  { fromUsd: 0, fee: 4 },
  { fromUsd: 100_000, fee: 3 },
  { fromUsd: 1_000_000, fee: 2 },
];
export const BOT_FEE_VIP = 1;
export const BETA_VIP_DAYS = 30;

/** The bot fee for a wallet: VIP (or beta in its first 30 days) the lowest step, else by its 14-day volume. */
export function botFeeFor(volumeUsd: number | null | undefined, o: { vip?: boolean } = {}): number {
  return o.vip ? BOT_FEE_VIP : copyFeeFor(volumeUsd, BOT_FEE_LADDER);
}

/** Tenths of a bp -> '0.025%'. */
export const feePercent = (tenthsBps: number): string => `${(tenthsBps / 1000).toFixed(tenthsBps % 10 === 0 ? 2 : 3)}%`;
