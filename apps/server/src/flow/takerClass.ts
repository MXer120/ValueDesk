/**
 * WHO IS INFORMED (owner 2026-11-10: "classify if they're informed or uninformed flow in our market conditions element
 * and assign them"). Besides SoDEX's two known takers - 1002 (uninformed) and 23342 (informed) - every other taker
 * account is measured by what it costs the maker it fills: the board's own markout (botMarkets.ts analyzeMarket, the
 * mid 25-35 s after the fill against the fill price, from the maker's side), volume-weighted over the 7 d window.
 *
 * INFORMED: the makers it fills lose on average, beyond two standard errors (its trades lead the price).
 * UNINFORMED: the makers it fills gain on average, beyond two standard errors.
 * Neither (too few fills, or no clear sign either way): it stays unidentified.
 *
 * Classes are made by each full compute (every 5 min) and used from then on: by the next compute's minute series, by
 * the tail passes and by the board's own tape (which reads SoDEX's account ids, not the flow's party ids). Written to a
 * small file beside the flow, so a restart starts with the last classes instead of none.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultFlowPath } from './store.js';

/** Fills an account needs before it is classed at all. */
export const CLASS_MIN_FILLS = 30;
/** Standard errors the mean must clear zero by. */
export const CLASS_Z = 2;
/** One fill's markout counts at most this far either way (bp): a bad tick does not class an account. */
export const CLASS_CLIP_BPS = 50;

export interface TakerClasses {
  /** When made (ms); 0: none yet. */
  at: number;
  /** flow_party ids. */
  inf: Set<number>;
  uni: Set<number>;
  /** The same accounts as SoDEX account ids (the board's tape reads those). */
  infKeys: Set<string>;
  uniKeys: Set<string>;
}

export const noClasses = (): TakerClasses => ({ at: 0, inf: new Set(), uni: new Set(), infKeys: new Set(), uniKeys: new Set() });

/** Per taker: fills, volume, volume x markout, volume x markout^2 (the maker's side, bp). */
export class TakerTally {
  private by = new Map<number, Float64Array>();

  add(taker: number, usd: number, makerBps: number): void {
    if (!(usd > 0) || !Number.isFinite(makerBps)) return;
    const x = Math.max(-CLASS_CLIP_BPS, Math.min(CLASS_CLIP_BPS, makerBps));
    let r = this.by.get(taker);
    if (!r) this.by.set(taker, (r = new Float64Array(4)));
    r[0]! += 1; r[1]! += usd; r[2]! += usd * x; r[3]! += usd * x * x;
  }

  /** One account's figures: the makers' mean markout (bp, volume-weighted) and its standard error; null: no fills. */
  stats(taker: number): { n: number; usd: number; meanBps: number; seBps: number } | null {
    const r = this.by.get(taker);
    if (!r || !(r[1]! > 0)) return null;
    const mean = r[2]! / r[1]!;
    const varW = Math.max(0, r[3]! / r[1]! - mean * mean);
    return { n: r[0]!, usd: r[1]!, meanBps: mean, seBps: Math.sqrt(varW / r[0]!) };
  }

  /** The classes (party ids); keys are added by the caller. */
  classify(): { inf: Set<number>; uni: Set<number> } {
    const inf = new Set<number>(), uni = new Set<number>();
    for (const id of this.by.keys()) {
      const s = this.stats(id)!;
      if (s.n < CLASS_MIN_FILLS) continue;
      if (s.meanBps + CLASS_Z * s.seBps < 0) inf.add(id);
      else if (s.meanBps - CLASS_Z * s.seBps > 0) uni.add(id);
    }
    return { inf, uni };
  }
}

let current: TakerClasses | null = null;

function file(): string | null {
  try {
    return join(dirname(defaultFlowPath()), 'valuescan-taker-classes.json');
  } catch {
    return null;
  }
}

/** The classes in use (the last compute's, else the file's, else none). */
export function takerClasses(): TakerClasses {
  if (current) return current;
  current = noClasses();
  const f = file();
  if (!f) return current;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as { v?: number; at?: number; inf?: Array<[number, string]>; uni?: Array<[number, string]> };
    if (j.v === 1) {
      current = {
        at: j.at ?? 0,
        inf: new Set((j.inf ?? []).map((x) => x[0])),
        uni: new Set((j.uni ?? []).map((x) => x[0])),
        infKeys: new Set((j.inf ?? []).map((x) => x[1])),
        uniKeys: new Set((j.uni ?? []).map((x) => x[1])),
      };
    }
  } catch { /* none yet */ }
  return current;
}

/** Use these from now on (and keep them on disk). `keyOf`: a party's SoDEX account id. */
export function setTakerClasses(c: { inf: Set<number>; uni: Set<number> }, keyOf: (id: number) => string | null, at = Date.now(), persist = true): TakerClasses {
  const pair = (ids: Set<number>) => [...ids].flatMap((id) => { const k = keyOf(id); return k ? [[id, k] as [number, string]] : []; });
  const inf = pair(c.inf), uni = pair(c.uni);
  current = { at, inf: new Set(c.inf), uni: new Set(c.uni), infKeys: new Set(inf.map((x) => x[1])), uniKeys: new Set(uni.map((x) => x[1])) };
  const f = persist ? file() : null;
  if (f) {
    try {
      writeFileSync(`${f}.tmp`, JSON.stringify({ v: 1, at, inf, uni }));
      renameSync(`${f}.tmp`, f);
    } catch { /* memory only */ }
  }
  return current;
}

/** Tests: forget. */
export function clearTakerClasses(): void {
  current = null;
}
