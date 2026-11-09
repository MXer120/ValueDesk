/**
 * WHAT THE FLOW ALREADY HOLDS, asked of a print: the catch-ups' `missing` / `missingNear` and the restart dedupe
 * `repeatOfHeld` (recorder.ts says why each matches the way it does). One implementation for both askers: the recorder on
 * its own thread looks at its open chunks and the file; the indexer's thread, while the recorder runs on a thread of its
 * own (thread.ts), looks at the file through a read-only connection plus the prints it handed over that the file does not
 * hold yet. The view says where a slot's prints come from; the matching is the same.
 */
import type { Venue } from '../valuedesk/types.js';
import type { Print } from '../indexer/streams.js';
import { CHUNK_MS, type FlowPrint } from './codec.js';

/** Venues whose prints name account ids, not addresses (the address comes from the index). */
export const ID_VENUES: ReadonlySet<Venue> = new Set(['sodex', 'lighter']);

/** A party's key as flow_party keeps it: an account id as given, an address in lower case. */
export const partyKey = (venue: Venue, acct: string): string => (ID_VENUES.has(venue) ? acct : acct.toLowerCase());

export interface HeldView {
  /** The market's id, or undefined: nothing of it is held. */
  market(venue: Venue, symbol: string): number | undefined;
  /** The party's id; an id no slot holds (-1) when it is not known. */
  party(venue: Venue, acct: string): number;
  /** Every print the slot holds. Throws when it cannot be read. */
  slot(mid: number, ct: number): readonly FlowPrint[];
}

const printKey = (f: { t: number; px: number; sz: number; buyer: number; seller: number }): string => `${f.t}|${f.px}|${f.sz}|${f.buyer}|${f.seller}`;

/** recorder.ts `missing`: exact on time, price, size and both parties, and counted. Throws when a slot cannot be read. */
export function missingOf(view: HeldView, prints: readonly Print[]): Print[] {
  const out: Print[] = [];
  const held = new Map<string, Map<string, number>>();
  for (const p of prints) {
    const mid = view.market(p.venue, p.symbol);
    if (mid === undefined) { out.push(p); continue; }
    const ct = Math.floor(p.t / CHUNK_MS) * CHUNK_MS;
    const k = `${mid}|${ct}`;
    let counts = held.get(k);
    if (!counts) {
      counts = new Map();
      for (const f of view.slot(mid, ct)) {
        const key = printKey(f);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      held.set(k, counts);
    }
    const key = `${p.t}|${p.px}|${p.sz}|${view.party(p.venue, p.buyer)}|${view.party(p.venue, p.seller)}`;
    const n = counts.get(key) ?? 0;
    if (n > 0) counts.set(key, n - 1);
    else out.push(p);
  }
  return out;
}

/** recorder.ts `missingNear`: price, size and both parties exact, the time within `nearMs`, one held print per row. */
export function missingNearOf(view: HeldView, prints: readonly Print[], nearMs: number): Print[] {
  const out: Print[] = [];
  const held = new Map<string, number[]>();
  const read = new Set<string>();
  for (const p of [...prints].sort((a, b) => a.t - b.t)) {
    const mid = view.market(p.venue, p.symbol);
    if (mid === undefined) { out.push(p); continue; }
    for (let ct = Math.floor((p.t - nearMs) / CHUNK_MS) * CHUNK_MS; ct <= p.t + nearMs; ct += CHUNK_MS) {
      const k = `${mid}|${ct}`;
      if (read.has(k)) continue;
      read.add(k);
      for (const f of view.slot(mid, ct)) {
        const key = `${mid}|${f.px}|${f.sz}|${f.buyer}|${f.seller}`;
        const times = held.get(key);
        if (times) times.push(f.t);
        else held.set(key, [f.t]);
      }
    }
    const times = held.get(`${mid}|${p.px}|${p.sz}|${view.party(p.venue, p.buyer)}|${view.party(p.venue, p.seller)}`);
    let best = -1;
    let bestBy = nearMs;
    for (let i = 0; times && i < times.length; i++) {
      const by = Math.abs(times[i]! - p.t);
      if (by <= bestBy) { best = i; bestBy = by; }
    }
    if (best >= 0) times!.splice(best, 1);
    else out.push(p);
  }
  return out;
}

const REPEATS_MS = 10 * 60_000;

/** recorder.ts `repeatOfHeld`: the counts per slot, read once and kept REPEATS_MS. */
export class Repeats {
  private counts = new Map<string, Map<string, number>>();
  private at: number;

  constructor(readonly runStart: number, private readonly now: () => number) {
    this.at = runStart;
  }

  /** Throws when a slot cannot be read. */
  check(view: HeldView, p: Print): boolean {
    if (p.t >= this.runStart) return false;
    const venue: Venue = p.venue === 'hyperliquid' && p.symbol.startsWith('xyz:') ? 'tradexyz' : p.venue;
    const mid = view.market(venue, p.symbol);
    if (mid === undefined) return false;
    if (this.now() - this.at > REPEATS_MS) { this.counts.clear(); this.at = this.now(); }
    const ct = Math.floor(p.t / CHUNK_MS) * CHUNK_MS;
    const k = `${mid}|${ct}`;
    let counts = this.counts.get(k);
    if (!counts) {
      counts = new Map();
      for (const f of view.slot(mid, ct)) {
        const key = printKey(f);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      this.counts.set(k, counts);
    }
    const key = `${p.t}|${p.px}|${p.sz}|${view.party(venue, p.buyer)}|${view.party(venue, p.seller)}`;
    const n = counts.get(key) ?? 0;
    if (n > 0) counts.set(key, n - 1);
    return n > 0;
  }
}
