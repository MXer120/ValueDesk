/**
 * The Copy page's cards, read ahead of visitors (GET /api/vs/copy/cards, routes/valuedesk.ts).
 *
 * A card draws the trader's PnL curve for the grid's window and the time of their newest trade
 * (web copy/TraderCard.tsx). The browser read those from each venue itself, four cards at a time:
 * 6.2 s for a page of 24 SoDEX cards and 68 s for Hyperliquid, whose `portfolio` reads (20 weight
 * each) ran into the browser's ~1,000 weight a minute. Here the API process reads the same peeks with
 * the same code (hyperliquid/trader.ts hlPeek, sodex/traderCore.ts sodexPeek, the other venues'
 * profiles; cardPeek.ts cardShown), for every leader of the page - the 'any' boards of the page's
 * windows, top and worst, as the index built them - and serves a page of them in one request.
 *
 * WHAT IS SERVED. Only what a venue answered, with its age: each card carries when it was read and
 * whether that is within its venue's refresh interval. An older one is shown with its age while the
 * browser reads the venue as before; a leader not read yet is the browser's own read, unchanged.
 *
 * BUDGETS. Each venue group is a lane (indexer/lanes.ts) paced to a share of what this process may
 * spend from the server's address, below the indexer's lanes on the same address:
 *   hl       Hyperliquid and trade.xyz  170 of the API process's 200 /info weight a minute
 *            (info.ts HL_WEIGHT_API_ONLY; the indexer's lanes keep their 500 + 400), background
 *            priority, so a profile someone opened goes first. A wallet with no fill since the
 *            newest one Hyperliquid answered (the index's complete span says so) costs its
 *            `portfolio` only (20); otherwise hlPeek's one fill read from the index's hint as well.
 *   sodex    320 gateway weight a minute (account state 5, closed positions 30 per wallet, one data-
 *            host chart per window) of the 6,000 SoDEX reports per address; /trades is never read.
 *   lighter  15 requests a minute of this process's 20 (lighter.ts; ~10 a profile).
 *   arcus    170 of this process's 300 weight a minute (arcus.ts; 42 a profile).
 * The interval each venue's leaders are refreshed at follows from that (REFRESH_MS); leaders a
 * visitor has on screen go first. Arcus and Lighter cards are their venues' own profile reads, never
 * the index's fills (which still hold stream rows beside REST rows for those two).
 *
 * The cards are written to a file every few minutes and read back at the start, so a release does
 * not start cold; a second API on the same server (the beta channel) only reads that file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Lane } from '../indexer/lanes.js';
import { reader } from '../indexer/reader.js';
import { heldSpan, lastTrades } from '../indexer/walletFills.js';
import { cardShown, PROFILE_WINDOW, type CardShown, type PeekLike } from './cardPeek.js';
import { baseWeight, itemWeight, type InfoLike } from './hyperliquid/info.js';
import { hlInfo } from './hyperliquid/client.js';
import { hlPeek } from './hyperliquid/trader.js';
import { peek as sodexPeek, trader as sodexTrader } from './sodex/trader.js';
import { arcusProvider, lighterProvider, tradexyzProvider } from './extra/providers.js';
import type { Venue } from './types.js';

/** The Copy page's windows (web copy/gridModel.ts GRID_WINDOWS). */
export const CARD_WINDOWS = ['7d', '30d', 'all'] as const;
export type CardWindow = (typeof CARD_WINDOWS)[number];
export const isCardWindow = (w: unknown): w is CardWindow => (CARD_WINDOWS as readonly unknown[]).includes(w);
/** The venues whose boards the page shows (web copy/gridModel.ts GRID_VENUES). */
export const CARD_VENUES: readonly Venue[] = ['sodex', 'hyperliquid', 'tradexyz', 'lighter', 'arcus'];
/** Cards one request answers (a page is 24). */
export const CARDS_PER_REQUEST = 50;

const MIN = 60_000;
type Group = 'hl' | 'sodex' | 'lighter' | 'arcus';
const GROUP: Record<Venue, Group> = { hyperliquid: 'hl', tradexyz: 'hl', sodex: 'sodex', lighter: 'lighter', arcus: 'arcus' };
/** Each lane's spend a minute, in its venue's units (see the header). */
export const LANE_PER_MIN: Record<Group, number> = { hl: 170, sodex: 320, lighter: 15, arcus: 170 };

/**
 * How often a leader is read again: [on a 30D board, only on 7D / All]. Sized so each lane's leaders fit
 * its spend (production 2026-11-07: Hyperliquid 430 leaders, 200 of them on 30D, at ~25 weight is ~140
 * a minute of 170; SoDEX 400 at ~40 gateway weight ~330 of 320 at full refresh; Lighter 420 at ~10
 * requests ~16 of 15; Arcus 303 at 42 ~130 of 170; trade.xyz 38 at ~80 ~17 on the Hyperliquid lane).
 * A curve between two reads differs only in its last point: Hyperliquid's own week series has a point
 * every ~2.3 h, its month series every ~22 h, each ending at the moment it is read.
 */
export const REFRESH_MS: Record<Venue, readonly [number, number]> = {
  hyperliquid: [60 * MIN, 180 * MIN],
  tradexyz: [180 * MIN, 180 * MIN],
  sodex: [45 * MIN, 120 * MIN],
  lighter: [180 * MIN, 360 * MIN],
  arcus: [60 * MIN, 180 * MIN],
};
/** A read that failed is not tried again sooner. */
const RETRY_MS = 10 * MIN;
/** A card asked for this recently counts as on screen. */
const ON_SCREEN_MS = 10 * MIN;
const PLAN_MS = MIN;
const SAVE_MS = 3 * MIN;
const FOLLOW_MS = MIN;

export interface Leader {
  venue: Venue;
  address: string;
  window: CardWindow;
  side: 'top' | 'worst';
  /** 0-based place on its board. */
  i: number;
}

export interface Entry {
  /** When the venue answered (ms). */
  at: number;
  /** The card per window; null: the venue has no account, or nothing to draw. */
  cards: Partial<Record<CardWindow, CardShown | null>>;
}

export interface ReadResult {
  cards: Partial<Record<CardWindow, CardShown | null>>;
  /** What the read spent, in its lane's units. */
  cost: number;
}

export interface CopyCardsDeps {
  now: () => number;
  /** Every leader of the page, from the index's boards. */
  leaders: () => Leader[];
  /** One wallet's cards for these windows, read from its venue. */
  read: (venue: Venue, address: string, windows: readonly CardWindow[], prev: Entry | undefined) => Promise<ReadResult>;
  /** Where the cards are kept between starts (null: nowhere). */
  file: string | null;
  /** Only read the file another process writes (no venue reads). */
  follower?: boolean;
  /** The lanes' sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** One card as the route answers it. */
export type CardAnswer =
  | { age: number; fresh: boolean; spark: number[] | null; lastActive: number | null }
  | { age: number; fresh: boolean; none: true };

const keyOf = (venue: Venue, address: string) => `${venue}:${address}`;

export class CopyCards {
  readonly entries = new Map<string, Entry>();
  /** venue:address -> the refresh interval its boards give it, and its lane priority (from the last plan). */
  private plan = new Map<string, { interval: number; prio: number; windows: CardWindow[] }>();
  private asked = new Map<string, number>();
  private tried = new Map<string, number>();
  readonly lanes: Record<Group, Lane>;
  private timers: NodeJS.Timeout[] = [];
  private dirty = false;

  constructor(private readonly d: CopyCardsDeps) {
    const sleep = d.sleep;
    this.lanes = {
      hl: new Lane({ name: 'cards-hl', perMin: LANE_PER_MIN.hl, rateLimitPauseMs: 5 * MIN, creditTaskTime: true, ...(sleep ? { sleep } : {}) }),
      sodex: new Lane({ name: 'cards-sodex', perMin: LANE_PER_MIN.sodex, rateLimitPauseMs: 15 * MIN, creditTaskTime: true, ...(sleep ? { sleep } : {}) }),
      lighter: new Lane({ name: 'cards-lighter', perMin: LANE_PER_MIN.lighter, rateLimitPauseMs: 5 * MIN, creditTaskTime: true, ...(sleep ? { sleep } : {}) }),
      arcus: new Lane({ name: 'cards-arcus', perMin: LANE_PER_MIN.arcus, rateLimitPauseMs: 5 * MIN, creditTaskTime: true, ...(sleep ? { sleep } : {}) }),
    };
  }

  start(): void {
    this.load();
    if (this.d.follower) {
      const t = setInterval(() => this.load(), FOLLOW_MS);
      t.unref?.();
      this.timers.push(t);
      return;
    }
    for (const lane of Object.values(this.lanes)) lane.start();
    this.replan();
    const plan = setInterval(() => this.replan(), PLAN_MS);
    const save = setInterval(() => this.save(), SAVE_MS);
    plan.unref?.();
    save.unref?.();
    this.timers.push(plan, save);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const lane of Object.values(this.lanes)) lane.stop();
    this.save();
  }

  /** The leaders now, each with its refresh interval and place; due ones queued, on-screen first. */
  replan(): void {
    const now = this.d.now();
    let leaders: Leader[];
    try {
      leaders = this.d.leaders();
    } catch {
      return;
    }
    const plan = new Map<string, { interval: number; prio: number; windows: CardWindow[] }>();
    for (const l of leaders) {
      const key = keyOf(l.venue, l.address);
      const [first, rest] = REFRESH_MS[l.venue];
      const interval = l.window === '30d' ? first : rest;
      // The page opens on 30D, top traders: those first, then 30D worst, 7D, All.
      const prio = (l.window === '30d' ? 3_000 : l.window === '7d' ? 2_000 : 1_000) + (l.side === 'top' ? 500 : 0) + Math.max(0, 100 - l.i);
      const p = plan.get(key);
      if (!p) plan.set(key, { interval, prio, windows: [l.window] });
      else {
        p.interval = Math.min(p.interval, interval);
        p.prio = Math.max(p.prio, prio);
        if (!p.windows.includes(l.window)) p.windows.push(l.window);
      }
    }
    this.plan = plan;
    for (const [k, at] of this.asked) if (now - at > ON_SCREEN_MS) this.asked.delete(k);
    for (const [k, at] of this.tried) if (now - at > RETRY_MS) this.tried.delete(k);
    for (const [key, p] of plan) this.queue(key, p, now);
    for (const lane of Object.values(this.lanes)) lane.retain((k) => plan.has(k));
  }

  private queue(key: string, p: { interval: number; prio: number; windows: CardWindow[] }, now: number): void {
    const e = this.entries.get(key);
    const missing = !e || p.windows.some((w) => !(w in e.cards));
    if (!missing && now - e!.at < p.interval) return;
    if (this.tried.has(key)) return;
    const i = key.indexOf(':');
    const venue = key.slice(0, i) as Venue;
    const address = key.slice(i + 1);
    const onScreen = this.asked.has(key) ? 10_000 : 0;
    this.lanes[GROUP[venue]].add({
      key,
      prio: p.prio + onScreen + (missing ? 0 : -500),
      replace: true,
      run: async () => {
        this.tried.set(key, this.d.now());
        const windows = this.plan.get(key)?.windows ?? p.windows;
        const r = await this.d.read(venue, address, windows, this.entries.get(key));
        this.entries.set(key, { at: this.d.now(), cards: r.cards });
        this.tried.delete(key);
        this.dirty = true;
        return r.cost;
      },
    });
  }

  /** The interval a leader's card is due again after (the longest when it is no leader now). */
  intervalOf(venue: Venue, address: string): number {
    return this.plan.get(keyOf(venue, address))?.interval ?? REFRESH_MS[venue][1];
  }

  /**
   * The cards held for these wallets in window `w`; a wallet without one (not read yet, or no leader) is
   * left out. Asking marks them on screen: a due one is read next.
   */
  answer(w: CardWindow, wallets: ReadonlyArray<{ venue: Venue; address: string }>): Record<string, CardAnswer> {
    const now = this.d.now();
    const out: Record<string, CardAnswer> = {};
    for (const { venue, address } of wallets) {
      const key = keyOf(venue, address);
      if (!this.d.follower) {
        const fresh = !this.asked.has(key);
        this.asked.set(key, now);
        const p = this.plan.get(key);
        if (fresh && p) this.queue(key, p, now);
      }
      const e = this.entries.get(key);
      if (!e || !(w in e.cards)) continue;
      const card = e.cards[w];
      const age = Math.max(0, now - e.at);
      const fresh = age <= this.intervalOf(venue, address);
      out[key] = card ? { age, fresh, spark: card.spark, lastActive: card.lastActive } : { age, fresh, none: true };
    }
    return out;
  }

  /** Counts for the status: cards held, leaders, lanes. */
  status(): { held: number; leaders: number; lanes: Record<string, { queued: number; done: number; failed: number; spent: number }> } {
    const lanes: Record<string, { queued: number; done: number; failed: number; spent: number }> = {};
    for (const [g, l] of Object.entries(this.lanes)) lanes[g] = { queued: l.size, done: l.done, failed: l.failed, spent: Math.round(l.spent) };
    return { held: this.entries.size, leaders: this.plan.size, lanes };
  }

  save(): void {
    if (!this.d.file || this.d.follower || !this.dirty) return;
    try {
      mkdirSync(dirname(this.d.file), { recursive: true });
      const tmp = `${this.d.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, entries: [...this.entries] }));
      renameSync(tmp, this.d.file);
      this.dirty = false;
    } catch {
      /* kept in memory; the next save tries again */
    }
  }

  load(): void {
    if (!this.d.file) return;
    let body: { v?: number; entries?: Array<[string, Entry]> };
    try {
      body = JSON.parse(readFileSync(this.d.file, 'utf8'));
    } catch {
      return;
    }
    if (body.v !== 1 || !Array.isArray(body.entries)) return;
    for (const [k, e] of body.entries) {
      if (typeof k !== 'string' || !e || typeof e.at !== 'number' || !e.cards || typeof e.cards !== 'object') continue;
      const cur = this.entries.get(k);
      if (!cur || cur.at < e.at) this.entries.set(k, e);
    }
  }
}

/* ------------------------------------------------------------------ the server's binding ---- */

/** The page's leaders from the index this process reads: the 'any' boards of CARD_WINDOWS, top and worst. */
export function indexLeaders(): Leader[] {
  const store = reader();
  if (!store) return [];
  const out: Leader[] = [];
  for (const venue of CARD_VENUES) {
    for (const window of CARD_WINDOWS) {
      for (const side of ['top', 'worst'] as const) {
        const b = store.readBoard(venue, window, side, 'any');
        b?.rows.slice(0, 100).forEach((r, i) => out.push({ venue, address: r.address.toLowerCase(), window, side, i }));
      }
    }
  }
  return out;
}

/** hlInfo at background priority, counting the weight of every answer (an answer from its cache counted too: never under). */
function countingInfo(): { info: InfoLike; spent: () => number } {
  let spent = 0;
  return {
    info: {
      async post<T>(body: Parameters<InfoLike['post']>[0], o: Parameters<InfoLike['post']>[1] = {}): Promise<T> {
        const r = await hlInfo.post<T>(body, { ...o, background: true });
        spent += baseWeight(body.type) + itemWeight(body.type, r);
        return r;
      },
    },
    spent: () => spent,
  };
}

/** A held span reaching this close to now is the index's whole answer up to now (walletFills / indexFills TAIL_SLACK_MS). */
const HELD_SLACK_MS = 90_000;
/** Estimated costs where the read is not counted (units of each lane). */
const COST = { sodexWallet: 40, sodexProfile: 150, tradexyz: 80, lighter: 10, arcus: 42 };

const every = (windows: readonly CardWindow[], p: PeekLike | null): Partial<Record<CardWindow, CardShown | null>> =>
  Object.fromEntries(windows.map((w) => [w, p ? cardShown(p, w) : null]));

/** One wallet's cards from its venue: the browser's own reads (web exchange/venues.ts peek), on this server's clients. */
export async function readCards(venue: Venue, address: string, windows: readonly CardWindow[], prev: Entry | undefined, now = Date.now()): Promise<ReadResult> {
  switch (venue) {
    case 'hyperliquid': {
      const store = reader();
      const hint = store ? (lastTrades('hyperliquid', [address], now, store)[address] ?? null) : null;
      const span = store ? heldSpan(store, 'hyperliquid', address) : null;
      // The newest fill Hyperliquid answered last time still stands when the index, complete to now, has none after it.
      const before = prev ? Object.values(prev.cards).find((c) => c?.lastActive != null)?.lastActive ?? null : null;
      const known = before !== null && hint === before && span !== null && span.hi >= now - HELD_SLACK_MS ? before : null;
      const c = countingInfo();
      const p = await hlPeek(address, c.info, now, hint, known);
      return { cards: every(windows, p), cost: c.spent() };
    }
    case 'sodex': {
      const cards: Partial<Record<CardWindow, CardShown | null>> = {};
      let cost = COST.sodexWallet;
      let profile: PeekLike | null | undefined;
      for (const w of windows) {
        const p = await sodexPeek(address, PROFILE_WINDOW[w]);
        if (p === undefined) {
          // Only the profile says it the same way (web venues.ts peek does the same).
          if (profile === undefined) {
            profile = await sodexTrader(address);
            cost += COST.sodexProfile;
          }
          cards[w] = profile ? cardShown(profile, w) : null;
        } else cards[w] = p ? cardShown(p, w) : null;
      }
      return { cards, cost };
    }
    case 'tradexyz':
      return { cards: every(windows, await tradexyzProvider.trader(address)), cost: COST.tradexyz };
    case 'lighter':
      return { cards: every(windows, await lighterProvider.trader(address)), cost: COST.lighter };
    case 'arcus':
      return { cards: every(windows, await arcusProvider.trader(address)), cost: COST.arcus };
  }
}

let running: CopyCards | null = null;

/** The process's card cache, once started (index.ts). */
export function copyCards(): CopyCards | null {
  return running;
}

/**
 * Start reading the cards (the API's start). VALUESCAN_COPY_CARDS=0: off; `follow`, or the beta channel's
 * API: only the file the main API writes.
 */
export function startCopyCards(file: string | null): CopyCards | null {
  const mode = process.env.VALUESCAN_COPY_CARDS?.trim();
  if (mode === '0' || running) return running;
  const follower = mode === 'follow' || process.env.VALUESCAN_CHANNEL === 'beta';
  running = new CopyCards({ now: Date.now, leaders: indexLeaders, read: (v, a, w, prev) => readCards(v, a, w, prev), file, follower });
  running.start();
  return running;
}
