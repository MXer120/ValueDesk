/**
 * Wallets the Hyperliquid fills archive found holding positions, for the cohort tracker to read.
 *
 * The streams only show a wallet once it trades, and the leaderboard ranks ~47k accounts; the archive
 * (s3://hl-mainnet-node-data, replayed from 2025-07-27 into hl-positions.tsv.gz: address, coin, size,
 * last fill time, last price) names every wallet that held a perp when it ended, ~140k of them. Its
 * sizes are hours old by the time they load, so they only decide WHO to read and in what order (the
 * largest first); the read itself is what the books, the cohorts and the liquidation map use.
 * Coins `xyz:NAME` are trade.xyz's dex (that venue); other HIP-3 dexes are not venues here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { Venue } from '../valuedesk/types.js';

export const ARCHIVE_DIR = process.env.VALUESCAN_HL_ARCHIVE_DIR || '/var/lib/valuescan/archive';

/** venue -> address -> notional at its last fills (USD). */
export type Seeds = Map<Venue, Map<string, number>>;

/** Pure: one archive line into its venue, address and notional (null when it is no position of ours). */
export function seedLine(line: string): { venue: Venue; address: string; notional: number } | null {
  const [address, coin, szi, , px] = line.split('\t');
  if (!address?.startsWith('0x') || !coin) return null;
  const n = Math.abs(Number(szi)) * Number(px);
  if (!Number.isFinite(n) || n <= 0) return null;
  const dex = coin.includes(':') ? coin.slice(0, coin.indexOf(':')) : '';
  if (dex && dex !== 'xyz') return null;
  return { venue: dex ? 'tradexyz' : 'hyperliquid', address: address.toLowerCase(), notional: n };
}

/**
 * The archive's holders; an empty map when there is no archive. `hl-positions.tsv.gz` first, then every
 * `hl-positions-<name>.tsv.gz` beside it in name order: replays of older archives, whose wallets made no
 * perp fill in the later one (so their positions there still stand). A wallet a file before already
 * names, for that venue, keeps that file's figures: the main file is the newest. `at` is the newest file's
 * time. Each file is one blocking read and inflate (~14 MB, well under a second), then parsed in slices
 * that hand the loop back: inside the indexer a streamed read never finished (2026-10-27), its zlib and
 * fs work queued behind the thread pool the indexer keeps busy.
 */
export async function loadSeeds(dir = ARCHIVE_DIR): Promise<{ seeds: Seeds; at: number | null }> {
  const seeds: Seeds = new Map();
  let at: number | null = null;
  let extra: string[] = [];
  try { extra = readdirSync(dir).filter((f) => /^hl-positions-[\w.-]+\.tsv\.gz$/.test(f)).sort(); } catch { /* no archive */ }
  for (const name of ['hl-positions.tsv.gz', ...extra]) {
    const file = `${dir}/${name}`;
    let t: number;
    try { t = statSync(file).mtimeMs; } catch { continue; }
    at = Math.max(at ?? 0, t);
    // Wallets the files before this one named, per venue: they keep those figures.
    const before = new Map([...seeds].map(([v, m]) => [v, new Set(m.keys())]));
    const text = gunzipSync(readFileSync(file)).toString('utf8');
    let i = text.indexOf('\n') + 1;
    let t0 = Date.now();
    while (i > 0 && i < text.length) {
      const j = text.indexOf('\n', i);
      const line = text.slice(i, j < 0 ? text.length : j);
      i = j < 0 ? text.length : j + 1;
      const s = seedLine(line);
      if (s && !before.get(s.venue)?.has(s.address)) {
        const m = seeds.get(s.venue) ?? seeds.set(s.venue, new Map()).get(s.venue)!;
        m.set(s.address, (m.get(s.address) ?? 0) + s.notional);
      }
      if (Date.now() - t0 > 20) {
        await new Promise<void>((r) => setImmediate(r));
        t0 = Date.now();
      }
    }
  }
  return { seeds, at };
}

/**
 * Hyperliquid wallets to read once, with no position named: every `hl-read-<name>.tsv.gz` in the archive,
 * in name order, its first column the address (a header line is skipped). An older archive's traders
 * (2025-03-22 .. 2025-07-27) the index held no book for: a position untouched since, which no stream and
 * no later archive shows, is only found by reading the wallet - and the read is what counts, never a
 * guess from the archive. In the files' order, each address once; none when there are no files.
 */
export async function loadReadList(dir = ARCHIVE_DIR): Promise<string[]> {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /^hl-read-[\w.-]+\.tsv\.gz$/.test(f)).sort(); } catch { return []; }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of files) {
    const text = gunzipSync(readFileSync(`${dir}/${name}`)).toString('utf8');
    let i = 0;
    let t0 = Date.now();
    while (i < text.length) {
      const j = text.indexOf('\n', i);
      const line = text.slice(i, j < 0 ? text.length : j);
      i = j < 0 ? text.length : j + 1;
      const a = readListLine(line);
      if (a && !seen.has(a)) { seen.add(a); out.push(a); }
      if (Date.now() - t0 > 20) {
        await new Promise<void>((r) => setImmediate(r));
        t0 = Date.now();
      }
    }
  }
  return out;
}

/** Pure: a read list line's address (lower case), or null (a header, a blank line, no address). */
export function readListLine(line: string): string | null {
  const a = line.split('\t', 1)[0]!.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
}

/** Pure: the read list's wallets still to read, in its order - those `known` (a book, a member, queued, a seed) are left out. */
export function* readListDue(list: readonly string[], known: (address: string) => boolean): Generator<string> {
  for (const a of list) if (!known(a)) yield a;
}
