/**
 * Hyperliquid's history for "Who traded": its public node archive replayed into the flow store
 * (store.ts), the same chunks, hours and days the live recorder writes.
 *
 *   s3://hl-mainnet-node-data/node_fills_by_block/hourly/YYYYMMDD/H.lz4   (from 2025-07-27;
 *   requester pays, in ap-northeast-1 - see the 2025-10-25 import in docs/memory hl-archive-import)
 *
 * Each line is a block: `events` is [user, fill] per party, so a print appears twice under one `tid`
 * - the buyer's fill (side B) and the seller's (side A); `crossed` marks the taker. trade.xyz is the
 * same archive's `xyz:` coins; spot (`@N`, `A/B`) is left out like the live recorder does.
 *
 * Run ON SERVER 1 (the laptop's bandwidth cap; ~38 MB lz4 an hour, ~0.9 TB over the archive):
 *   tsx src/flow/backfillHl.ts --from=20251001 --to=20251031 [--dir=/path/with/YYYYMMDD/H.lz4] [--s3]
 * `--s3` fetches each hour with `aws s3 cp --request-payer requester` (credentials in the env);
 * `--dir` reads hours already on disk. Hours are written only before the live recorder's first
 * start (meta `since`), so the archive never overwrites what the streams recorded. Rerunning an
 * hour rewrites it whole (idempotent). Needs `lz4` on PATH for .lz4 files; .jsonl is read as is.
 * NOTHING is deleted: the downloaded hour file is removed after import only with --s3.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coinOf } from '../valuedesk/cohorts/model.js';
import type { Venue } from '../valuedesk/types.js';
import {
  CHUNK_MS, DAY_MS, HOUR_MS, TAKER_BUYER, TAKER_NONE, TAKER_SELLER,
  addPrints, decodeChunk, decodeSums, encodeChunk, encodeSums, mergeSums,
  type FlowPrint, type WalletSums,
} from './codec.js';
import { FlowStore, defaultFlowPath } from './store.js';

/** One party's side of a print as the archive lists it. */
interface ArchiveFill {
  coin?: string;
  px?: string;
  sz?: string;
  side?: 'A' | 'B';
  time?: number;
  tid?: number | string;
  crossed?: boolean;
}

/** Meta key: the span [from, to) of Hyperliquid hours imported from the archive. */
export const BACKFILL_KEY = 'backfill:hyperliquid';

const isSpot = (coin: string) => coin.startsWith('@') || coin.includes('/');

/** Collects one hour's prints from archive lines (both parties of a tid make one print). */
export class HourBuilder {
  private half = new Map<string, { coin: string; t: number; px: number; sz: number; buyer?: string; seller?: string; taker?: 'buyer' | 'seller' }>();
  /** Lines that would not parse, fills with no tid or no party pair. */
  bad = 0;

  line(text: string): void {
    if (!text) return;
    let b: { events?: Array<[string, ArchiveFill]> };
    try { b = JSON.parse(text) as typeof b; } catch { this.bad++; return; }
    for (const ev of b.events ?? []) {
      const [user, f] = ev;
      if (!user || !f?.coin || isSpot(f.coin) || f.tid === undefined) continue;
      const k = `${f.coin}|${f.tid}`;
      let p = this.half.get(k);
      if (!p) {
        p = { coin: f.coin, t: Number(f.time), px: Number(f.px), sz: Number(f.sz) };
        this.half.set(k, p);
      }
      const buys = f.side === 'B';
      if (buys) p.buyer = user.toLowerCase(); else p.seller = user.toLowerCase();
      if (f.crossed) p.taker = buys ? 'buyer' : 'seller';
    }
  }

  /** The hour's prints: market (venue, symbol) -> prints with party keys. */
  prints(): Map<string, Array<{ t: number; px: number; sz: number; buyer: string; seller: string; taker: number }>> {
    const out = new Map<string, Array<{ t: number; px: number; sz: number; buyer: string; seller: string; taker: number }>>();
    for (const p of this.half.values()) {
      if (!p.buyer || !p.seller || !(p.px > 0) || !(p.sz > 0) || !Number.isFinite(p.t)) { this.bad++; continue; }
      const venue: Venue = p.coin.startsWith('xyz:') ? 'tradexyz' : 'hyperliquid';
      const k = `${venue}|${p.coin}`;
      let l = out.get(k);
      if (!l) { l = []; out.set(k, l); }
      l.push({ t: p.t, px: p.px, sz: p.sz, buyer: p.buyer, seller: p.seller, taker: p.taker === 'buyer' ? TAKER_BUYER : p.taker === 'seller' ? TAKER_SELLER : TAKER_NONE });
    }
    return out;
  }
}

/** Write one hour (from its builder) as chunks and hour sums. Returns the prints written. */
export function writeHour(store: FlowStore, hourT: number, b: HourBuilder, parties = new Map<string, number>()): number {
  let n = 0;
  const pid = (venue: Venue, a: string) => {
    const k = `${venue}|${a}`;
    let id = parties.get(k);
    if (id === undefined) { id = store.partyId(venue, a, a); parties.set(k, id); }
    return id;
  };
  store.db.exec('BEGIN');
  try {
    for (const [k, list] of b.prints()) {
      const [venue, symbol] = [k.slice(0, k.indexOf('|')) as Venue, k.slice(k.indexOf('|') + 1)];
      const mid = store.marketId(venue, symbol, coinOf(symbol), hourT);
      store.db.prepare('UPDATE flow_market SET first_t = MIN(first_t, ?) WHERE id = ?').run(hourT, mid);
      const byChunk = new Map<number, FlowPrint[]>();
      for (const p of list) {
        if (p.t < hourT || p.t >= hourT + HOUR_MS) continue;
        const ct = Math.floor(p.t / CHUNK_MS) * CHUNK_MS;
        let c = byChunk.get(ct);
        if (!c) { c = []; byChunk.set(ct, c); }
        c.push({ t: p.t, px: p.px, sz: p.sz, buyer: pid(venue, p.buyer), seller: pid(venue, p.seller), taker: p.taker });
      }
      const sums: WalletSums = new Map();
      let prints = 0;
      for (const [ct, c] of byChunk) {
        const blob = encodeChunk(ct, c);
        store.putChunk(mid, ct, c.length, blob);
        prints += addPrints(sums, decodeChunk(blob));
      }
      if (sums.size) store.putSums('hour', mid, hourT, sums.size, prints, encodeSums(sums, prints));
      n += prints;
    }
    store.db.exec('COMMIT');
  } catch (e) {
    try { store.db.exec('ROLLBACK'); } catch { /* not open */ }
    throw e;
  }
  return n;
}

/** A day's sums from its hour rows, for every market that has any. */
export function writeDay(store: FlowStore, dayT: number): void {
  const mids = (store.db.prepare('SELECT DISTINCT mid FROM flow_hour WHERE t >= ? AND t < ?').all(dayT, dayT + DAY_MS) as Array<{ mid: number }>).map((r) => r.mid);
  for (const mid of mids) {
    const sums: WalletSums = new Map();
    let prints = 0;
    for (let h = dayT; h < dayT + DAY_MS; h += HOUR_MS) {
      const blob = store.sums('hour', mid, h);
      if (!blob) continue;
      const d = decodeSums(blob);
      mergeSums(sums, d.sums);
      prints += d.prints;
    }
    if (sums.size) store.putSums('day', mid, dayT, sums.size, prints, encodeSums(sums, prints));
  }
}

/** Widen meta BACKFILL_KEY to hold [from, to). */
export function noteBackfill(store: FlowStore, from: number, to: number): void {
  let cur: [number, number] | null = null;
  try { cur = JSON.parse(store.getMeta(BACKFILL_KEY) ?? 'null') as [number, number] | null; } catch { cur = null; }
  store.setMeta(BACKFILL_KEY, JSON.stringify(cur ? [Math.min(cur[0], from), Math.max(cur[1], to)] : [from, to]));
}

// --- the command line ---------------------------------------------------------------------------

function lines(file: string): AsyncIterable<string> {
  if (file.endsWith('.lz4')) {
    const lz = spawn('lz4', ['-dc', file], { stdio: ['ignore', 'pipe', 'inherit'] });
    return createInterface({ input: lz.stdout, crlfDelay: Infinity });
  }
  return createInterface({ input: createReadStream(file), crlfDelay: Infinity });
}

function fetchS3(day: string, h: number, to: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('aws', ['s3', 'cp', '--only-show-errors', '--request-payer', 'requester', `s3://hl-mainnet-node-data/node_fills_by_block/hourly/${day}/${h}.lz4`, to], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.on('close', (code) => resolve(code === 0));
  });
}

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const dayOf = (k: string) => Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));

async function main(): Promise<void> {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const from = arg('from');
  const to = arg('to') ?? from;
  const dir = arg('dir');
  const s3 = process.argv.includes('--s3');
  if (!from || !/^\d{8}$/.test(from) || !to || !/^\d{8}$/.test(to) || (!dir && !s3)) {
    console.error('usage: backfillHl.ts --from=YYYYMMDD [--to=YYYYMMDD] (--dir=<dir> | --s3)');
    process.exit(2);
  }
  const store = new FlowStore(arg('db') ?? defaultFlowPath());
  // Never over the live recording: hours from its first start on are the streams'.
  const live = Number(store.getMeta('since')) || Infinity;
  const parties = new Map<string, number>();
  for (const p of store.parties()) parties.set(`${p.venue}|${p.key}`, p.id);
  for (let d = dayOf(from); d <= dayOf(to); d += DAY_MS) {
    const day = dayKey(d);
    let wrote = 0;
    for (let h = 0; h < 24; h++) {
      const hourT = d + h * HOUR_MS;
      if (hourT + HOUR_MS > live) break;
      let file = dir ? join(dir, day, `${h}.lz4`) : join(tmpdir(), `hlfill-${day}-${h}.lz4`);
      if (dir && !existsSync(file) && existsSync(join(dir, day, `${h}.jsonl`))) file = join(dir, day, `${h}.jsonl`);
      if (s3 && !(await fetchS3(day, h, file))) { console.error(`${day}/${h}: not fetched`); continue; }
      if (!existsSync(file)) { console.error(`${day}/${h}: missing`); continue; }
      const b = new HourBuilder();
      for await (const l of lines(file)) b.line(l);
      const n = writeHour(store, hourT, b, parties);
      if (s3) rmSync(file, { force: true });
      noteBackfill(store, hourT, hourT + HOUR_MS);
      wrote += n;
      console.log(`${day}/${h}: ${n} prints${b.bad ? `, ${b.bad} unpaired` : ''}`);
    }
    if (d + DAY_MS <= live) writeDay(store, d);
    console.log(`${day}: ${wrote} prints`);
  }
  store.close();
}

if (process.argv[1] && /backfillHl\.[tj]s$/.test(process.argv[1])) void main();
