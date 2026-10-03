/**
 * Nothing secret reaches the screen, a log or the summary. Pure.
 *
 * Two independent layers:
 *   1. the exact key the guide holds in memory is replaced wherever it shows up
 *      (any case, with or without 0x) - makeKeyRedactor;
 *   2. the summary files are scrubbed of EVERYTHING that is the size of a key:
 *      any run of 64 or more hex characters, unless it is a transaction hash
 *      that came from a known tx-hash field of a report - scrubText / scrubJson.
 */

/** 64 or more hex characters in a row, with or without 0x: a private key, a tx hash, a signature, calldata. */
const HEX_RUN = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g;
const TX_HASH = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const KEY_LIKE = /^(?:0x)?[0-9a-fA-F]{64}$/;

/** Property names whose values are transaction hashes (or links that carry one). */
export const TX_HASH_FIELDS: ReadonlySet<string> = new Set(['hash', 'txHash', 'txhash', 'transactionHash', 'explorer', 'ref', 'txs']);

export const REDACTED = '[redacted]';

const norm = (hex: string): string => hex.replace(/^0x/i, '').toLowerCase();

export const looksLikeKey = (s: string): boolean => KEY_LIKE.test(s.trim());

/**
 * Every transaction hash found under a known tx-hash field, normalised (no 0x,
 * lower case). `exclude` is never collected (pass the key: a key in a hash
 * field stays a key).
 */
export function collectTxHashes(value: unknown, exclude: string | null = null): Set<string> {
  const out = new Set<string>();
  const skip = exclude ? norm(exclude) : null;
  const take = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(TX_HASH)) {
        const h = norm(m[0]);
        if (h !== skip) out.add(h);
      }
    } else if (Array.isArray(v)) v.forEach(take);
    else if (v && typeof v === 'object') Object.values(v).forEach(take);
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (TX_HASH_FIELDS.has(k)) take(x);
        else walk(x);
      }
    }
  };
  walk(value);
  return out;
}

/** `text` without anything key-sized, except the hashes in `allow` (normalised, as collectTxHashes returns them). */
export function scrubText(text: string, allow: ReadonlySet<string> = new Set()): string {
  return text.replace(HEX_RUN, (m) => (allow.has(norm(m)) ? m : REDACTED));
}

/** A deep copy with every string (and property name) scrubbed. */
export function scrubJson<T>(value: T, allow: ReadonlySet<string> = new Set()): T {
  const go = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubText(v, allow);
    if (Array.isArray(v)) return v.map(go);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrubText(k, allow), go(x)]));
    return v;
  };
  return go(value) as T;
}

/**
 * Replaces the exact key - any case, with or without its 0x - in whatever text
 * it is given. With no key (or something that is not one) it changes nothing.
 */
export function makeKeyRedactor(key: string | null | undefined): (text: string) => string {
  if (!key || !KEY_LIKE.test(key.trim())) return (t) => t;
  const re = new RegExp(`(?:0x)?${norm(key.trim())}`, 'gi');
  return (t) => t.replace(re, '[redacted key]');
}

/**
 * JSON paths of strings (or property names) that hold something key-sized - a
 * config file must have none. The paths never repeat the value itself.
 */
export function findKeyLike(value: unknown, path = ''): string[] {
  const hit = (s: string): boolean => {
    HEX_RUN.lastIndex = 0;
    return HEX_RUN.test(s);
  };
  if (typeof value === 'string') return hit(value) ? [path || '(root)'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findKeyLike(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const named = hit(k);
      const p = `${path ? `${path}.` : ''}${named ? '<a key-sized property name>' : k}`;
      return [...(named ? [p] : []), ...findKeyLike(v, p)];
    });
  }
  return [];
}
