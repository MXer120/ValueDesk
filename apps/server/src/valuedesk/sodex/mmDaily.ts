/**
 * The big accounts the SoPoints difficulty takes out of SoDEX's platform figures (owner 2026-11-16: "general platform
 * difficulty but this excludes the 2 big mm accounts oi and vol"; on the question which accounts: "All four"):
 *
 *  - SoDEX's internal pair (internalWallets.ts): ~98% of SoDEX's open interest, a delta-neutral book opened 2026-05-15
 *    and held since. Its open interest per day = its sizes now (oiExcluded.ts, read from SoDEX) x that day's mark close.
 *    That assumes the sizes did not change, which is what the pair has done since it opened.
 *  - Accounts 1002 and 23342, the big takers / makers: their traded volume per UTC day from our index (activity_day,
 *    both sides of every SoDEX print). Our streams lost most prints before 2026-11-06 (walletHistory.ts), so their
 *    volume is only given from MM_VOLUME_FROM on; earlier days answer null, never a partial figure.
 *    A print between 1002 and 23342 counts in both accounts' volume; the sum is capped at the venue's own figure by the
 *    page, so it can take out more than their share but never more than the venue traded.
 */
import { reader } from '../../indexer/reader.js';
import { priceKlines } from '../../sodex/priceKlines.js';
import { sodexOiExcluded } from './oiExcluded.js';

export const MM_ACCOUNTS = ['1002', '23342'] as const;
/** The first UTC day our index holds SoDEX's prints nearly whole. */
export const MM_VOLUME_FROM = '2026-11-06';
const DAY = 86_400_000;
/** Markets under this share of the pair's USD are left out of the price reads (one read each). */
const MIN_SHARE = 0.002;

export interface MmDay {
  date: string;
  /** 1002 + 23342 traded volume, USD; null before MM_VOLUME_FROM or without the index. */
  volume: number | null;
  /** The internal pair's open interest at that day's mark close, USD; null when a price is missing. */
  internalOi: number | null;
}

export interface MmDaily {
  days: MmDay[];
  volumeFrom: string;
}

let cache: { at: number; key: string; value: Promise<MmDaily> } | null = null;

export function mmDaily(fromMs: number, now = Date.now()): Promise<MmDaily> {
  const from = Math.floor(fromMs / DAY);
  const key = String(from);
  if (cache && cache.key === key && now - cache.at < 3_600_000) return cache.value;
  const value = build(from, Math.floor(now / DAY));
  cache = { at: now, key, value };
  value.catch(() => { cache = null; });
  return value;
}

async function build(fromDay: number, toDay: number): Promise<MmDaily> {
  const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
  const volFrom = Math.floor(Date.parse(`${MM_VOLUME_FROM}T00:00:00Z`) / DAY);

  // Volume of the two accounts, per day.
  const vol = new Map<number, number>();
  const store = reader();
  if (store) for (const r of store.accountDays('sodex', MM_ACCOUNTS, Math.max(fromDay, volFrom))) vol.set(r.day, (vol.get(r.day) ?? 0) + r.volume);

  // The internal pair's sizes now, priced at each day's mark close.
  const { sizes } = await sodexOiExcluded();
  const close = new Map<string, Map<number, number>>();
  const nowUsd = new Map<string, number>();
  const symbols = Object.keys(sizes);
  const last = await Promise.all(symbols.map((s) => priceKlines({ symbol: s, source: 'mark', interval: '1d', limit: 1 }).catch(() => [])));
  symbols.forEach((s, i) => {
    const c = Number((last[i]?.[0] as { c?: string } | undefined)?.c);
    if (Number.isFinite(c)) nowUsd.set(s, Math.abs(sizes[s]!) * c);
  });
  const total = [...nowUsd.values()].reduce((a, b) => a + b, 0);
  const priced = symbols.filter((s) => (nowUsd.get(s) ?? 0) >= total * MIN_SHARE);
  const days = toDay - fromDay + 1;
  const rows = await Promise.all(priced.map((s) => priceKlines({ symbol: s, source: 'mark', interval: '1d', limit: Math.min(400, days + 2), startTime: fromDay * DAY, endTime: (toDay + 1) * DAY })));
  priced.forEach((s, i) => {
    const m = new Map<number, number>();
    for (const r of rows[i] as Array<{ t: number; c: string }>) m.set(Math.floor(Number(r.t) / DAY), Number(r.c));
    close.set(s, m);
  });

  const out: MmDay[] = [];
  for (let d = fromDay; d <= toDay; d++) {
    let oi = 0;
    let ok = priced.length > 0;
    for (const s of priced) {
      const c = close.get(s)?.get(d);
      if (!c) { ok = false; break; }
      oi += Math.abs(sizes[s]!) * c;
    }
    out.push({ date: iso(d), volume: d >= volFrom && store ? vol.get(d) ?? 0 : null, internalOi: ok ? oi : null });
  }
  return { days: out, volumeFrom: MM_VOLUME_FROM };
}
