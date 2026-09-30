/**
 * Hyperliquid markets for the palette's Assets tab (`view=assets`).
 *
 * The browser never calls Hyperliquid. This asks HL's `metaAndAssetCtxs` - one
 * request per dex, weight 20 each - for the default dex and the HIP-3 dex
 * "xyz" (stocks, gold, indexes; about a quarter of HL volume), through the
 * provider's shared HlInfoClient so it spends the same weight budget as every
 * other HL read, at background priority. The answer is cached for
 * ASSETS_TTL_MS and served stale while it refreshes, so an open palette costs
 * at most 40 weight a minute.
 */
import type { InfoLike } from '../hyperliquid/info.js';
import type { HlAsset } from './model.js';

export type { HlAsset };

export const ASSETS_TTL_MS = 60_000;
export const HL_ASSET_DEXES = ['', 'xyz'] as const;

interface RawUniverse {
  name?: unknown;
  maxLeverage?: unknown;
  isDelisted?: unknown;
}
interface RawCtx {
  markPx?: unknown;
  midPx?: unknown;
  prevDayPx?: unknown;
  dayNtlVlm?: unknown;
  openInterest?: unknown;
  funding?: unknown;
}

const n = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(x) ? x : null;
};

/** metaAndAssetCtxs -> assets. Delisted coins and rows without a name are dropped. Pure. */
export function mapAssetCtxs(raw: unknown, dex: string): HlAsset[] {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const meta = raw[0] as { universe?: RawUniverse[] } | null;
  const ctxs = raw[1] as RawCtx[] | null;
  const universe = Array.isArray(meta?.universe) ? meta!.universe : [];
  const out: HlAsset[] = [];
  universe.forEach((u, i) => {
    if (!u || typeof u.name !== 'string' || !u.name || u.isDelisted === true) return;
    const c = (Array.isArray(ctxs) ? ctxs[i] : undefined) ?? {};
    const price = n(c.markPx) ?? n(c.midPx);
    const prev = n(c.prevDayPx);
    const oi = n(c.openInterest);
    const symbol = dex && !u.name.includes(':') ? `${dex}:${u.name}` : u.name;
    out.push({
      venue: 'hyperliquid',
      symbol,
      dex,
      price,
      changePct: price !== null && prev !== null && prev > 0 ? ((price - prev) / prev) * 100 : null,
      volume24h: n(c.dayNtlVlm),
      openInterestUsd: oi !== null && price !== null ? oi * price : null,
      funding: n(c.funding),
      maxLeverage: n(u.maxLeverage),
    });
  });
  return out;
}

let cached: { at: number; rows: HlAsset[] } | null = null;
let pending: Promise<HlAsset[]> | null = null;

/** Tests only. */
export function resetAssetsCache(): void {
  cached = null;
  pending = null;
}

async function fetchAll(info: InfoLike): Promise<HlAsset[]> {
  const got = await Promise.allSettled(
    HL_ASSET_DEXES.map((dex) =>
      info.post<unknown>(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, {
        ttlMs: ASSETS_TTL_MS,
        background: true,
      }),
    ),
  );
  const rows = got.flatMap((g, i) => (g.status === 'fulfilled' ? mapAssetCtxs(g.value, HL_ASSET_DEXES[i]!) : []));
  if (!rows.length) {
    const err = got.find((g): g is PromiseRejectedResult => g.status === 'rejected');
    throw err ? err.reason : new Error('Hyperliquid markets: empty answer');
  }
  return rows.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
}

export async function hlAssets(info: InfoLike, now: () => number = Date.now): Promise<HlAsset[]> {
  if (cached && now() - cached.at < ASSETS_TTL_MS) return cached.rows;
  if (!pending) {
    pending = fetchAll(info)
      .then((rows) => {
        cached = { at: now(), rows };
        return rows;
      })
      .finally(() => {
        pending = null;
      });
  }
  if (cached) {
    pending.catch(() => { /* keep serving the last answer */ });
    return cached.rows;
  }
  return pending;
}
