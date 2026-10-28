/**
 * Wallets someone filtered the liquidation heatmap by: the indexer keeps their positions in
 * the history whatever their size (cohortTracker.ts recordLiq), from the first look on.
 *
 * The API thread may not write the index (the indexer is its only writer), so the list is a
 * small file beside it: address -> when it was last asked for. A wallet not asked for in
 * WATCH_TTL_MS drops out; at most WATCH_MAX are kept (the oldest asks go first). Public
 * addresses only - nothing about who asked.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultDbPath } from './store.js';

export const WATCH_TTL_MS = 30 * 24 * 60 * 60_000;
export const WATCH_MAX = 5_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;

const watchPath = (): string => join(dirname(defaultDbPath()), 'liq-watch.json');

function read(): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(watchPath(), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [a, t] of Object.entries(raw as Record<string, unknown>)) if (ADDRESS.test(a) && Number.isFinite(t)) out[a] = t as number;
    return out;
  } catch {
    return {};
  }
}

/** Remember that `addresses` were asked for (API thread). A write that fails leaves the list as it was. */
export function noteWatched(addresses: readonly string[], now = Date.now()): void {
  const want = addresses.map((a) => a.toLowerCase()).filter((a) => ADDRESS.test(a));
  if (!want.length) return;
  const cur = read();
  // Re-asked within the hour: no write.
  if (want.every((a) => cur[a] !== undefined && now - cur[a]! < 60 * 60_000)) return;
  for (const a of want) cur[a] = now;
  const kept = Object.entries(cur).filter(([, t]) => now - t < WATCH_TTL_MS).sort((x, y) => y[1] - x[1]).slice(0, WATCH_MAX);
  try {
    const p = watchPath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)));
    renameSync(tmp, p);
  } catch { /* the history keeps the large wallets either way */ }
}

let cache: { mtime: number; set: Set<string> } | null = null;

/** The wallets asked for lately (indexer thread): read again only when the file changed. */
export function watchedWallets(now = Date.now()): Set<string> {
  let mtime = 0;
  try { mtime = statSync(watchPath()).mtimeMs; } catch { return new Set(); }
  if (cache && cache.mtime === mtime) return cache.set;
  const set = new Set(Object.entries(read()).filter(([, t]) => now - t < WATCH_TTL_MS).map(([a]) => a));
  cache = { mtime, set };
  return set;
}
