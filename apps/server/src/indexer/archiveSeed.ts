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
import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { Venue } from '../valuescan/types.js';

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

/** The archive's holders; an empty map when there is no archive. Yields to the loop as it reads. */
export async function loadSeeds(dir = ARCHIVE_DIR): Promise<{ seeds: Seeds; at: number | null }> {
  const seeds: Seeds = new Map();
  const file = `${dir}/hl-positions.tsv.gz`;
  let at: number | null = null;
  try { at = statSync(file).mtimeMs; } catch { return { seeds, at }; }
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; }
    const s = seedLine(line);
    if (!s) continue;
    const m = seeds.get(s.venue) ?? seeds.set(s.venue, new Map()).get(s.venue)!;
    m.set(s.address, (m.get(s.address) ?? 0) + s.notional);
  }
  return { seeds, at };
}
