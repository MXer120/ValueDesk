/**
 * Arcus in the index.
 *
 * Who trades: the public `trades` channel names the maker AND the taker of
 * every fill, so the stream sees every Arcus trader. The venue's own top-100
 * lists (24h / 30d / all, by PnL and by volume) seed the set before the
 * stream has history.
 *
 * PnL: each known trader's portfolio (one read, 20 weight) gives total PnL -
 * realised and open - for 24h, 7d, 30d and all time, plus equity. Arcus's own
 * leaderboard is realised-only, so it is used for discovery, not ranking.
 *
 * Trades: `/v1/fills` newest first answers the trade check with one read,
 * and reads a board member's fills back to the window start.
 *
 * Budget: Arcus allows 1,500 weight / minute per IP; the worker takes
 * VALUESCAN_INDEX_ARCUS (default 600).
 */
import type { BoardWindow } from '../../valuedesk/types.js';
import { Pacer } from '../../valuedesk/extra/http.js';
import {
  ARCUS_WS,
  arcusFills,
  arcusLeaderboard,
  arcusMarkets,
  arcusPortfolio,
  type ArcusFill,
  type ArcusLbWindow,
} from '../../valuedesk/extra/arcus.js';
import { Lane } from '../lanes.js';
import { MIN_ROW_T, type FillRow } from '../store.js';
import { ArcusStream } from '../streams.js';
import { dayOf, DAY_MS } from '../windows.js';
import type { ExtContext, ExtVenue } from './types.js';

// 450 of Arcus's 1,500 / minute: the Scan pages and the stream's market reads share the IP.
const WEIGHT_PER_MIN = Number(process.env.VALUESCAN_INDEX_ARCUS) || 450;
const LIST_EVERY_MS = 30 * 60_000;
const PORTFOLIO_TTL_MS = 3 * 60 * 60_000;
const MAX_TRADERS = 3_000;
const FILLS_PAGE = 1_000;
const HISTORY_PAGES = 5;

const WINDOWS_WITH_PNL: readonly BoardWindow[] = ['1d', '7d', '30d', 'all'];

/**
 * Arcus has answered `createdAt: 0` for fills (seen 2026-10-02: 13 fills of
 * one burst, trade ids 188803-188820, between two fills 265 ms apart). Such
 * a fill takes the time of the nearest fill in the page that has one (the
 * page is in trade order, newest first; the older neighbour wins a tie). A
 * page with no usable time at all drops them. Left as they came, they sat on
 * 1 January 1970 - and, worse, a zero as a page's oldest time ended the
 * paging there with the whole window claimed as read.
 */
export function fixFillTimes(list: readonly ArcusFill[], now = Date.now()): ArcusFill[] {
  const ok = (t: number): boolean => t >= MIN_ROW_T && t <= now + DAY_MS;
  if (list.every((f) => ok(f.t))) return [...list];
  const out: ArcusFill[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i]!;
    if (ok(f.t)) {
      out.push(f);
      continue;
    }
    let t: number | null = null;
    for (let d = 1; d < list.length && t === null; d++) {
      const older = list[i + d];
      const newer = list[i - d];
      if (older && ok(older.t)) t = older.t;
      else if (newer && ok(newer.t)) t = newer.t;
    }
    if (t !== null) out.push({ ...f, t });
  }
  return out;
}

export class ArcusVenue implements ExtVenue {
  readonly venue = 'arcus' as const;
  // Portfolios (PnL for every trader) and the cohorts' position reads each keep
  // a share; trade checks take the rest.
  readonly lane = new Lane({ name: 'arcus', perMin: 100_000, shares: [{ prefix: 'pf:', share: 0.35 }, { prefix: 'coh:', share: 0.25 }] });
  readonly pacer = new Pacer('Arcus index', WEIGHT_PER_MIN);
  private ctx!: ExtContext;
  private stream: ArcusStream | null = null;
  private listAt = 0;
  private listed = new Set<string>();
  /** Window volume from the venue's own lists (its top 100s), where it publishes one. */
  private listVolume = new Map<BoardWindow, Map<string, number>>();
  private portfolioAt = new Map<string, number>();
  private portfolios = 0;

  start(ctx: ExtContext): void {
    this.ctx = ctx;
    this.lane.start();
    if (process.env.VALUESCAN_INDEX_STREAMS !== '0') {
      this.stream = new ArcusStream(ctx.onPrint, () => arcusMarkets(this.pacer), ARCUS_WS);
      this.stream.start();
    }
  }

  stop(): void {
    this.lane.stop();
    this.stream?.stop();
  }

  socketSince(): number | null {
    return this.stream?.since ?? null;
  }

  maxAgeMs(): number {
    return 12 * 60 * 60_000;
  }

  sourceReady(window: BoardWindow): boolean {
    return WINDOWS_WITH_PNL.includes(window) && this.listAt > 0 && this.portfolios > 0 && this.lane.countPrefix('pf:') === 0;
  }

  refresh(now: number): void {
    if (now - this.listAt >= LIST_EVERY_MS) {
      this.listAt = now;
      for (const w of ['24h', '30d', 'all'] as ArcusLbWindow[]) {
        for (const by of ['pnl', 'volume'] as const) {
          this.lane.add({
            key: `lb:${w}:${by}`,
            prio: 9_000,
            run: async () => {
              const bw: BoardWindow = w === '24h' ? '1d' : w;
              const vols = this.listVolume.get(bw) ?? new Map<string, number>();
              for (const r of await arcusLeaderboard(w, by, this.pacer)) {
                this.listed.add(r.address);
                vols.set(r.address, r.volume);
              }
              this.listVolume.set(bw, vols);
              return 1;
            },
          });
        }
      }
    }
    // Everyone the stream saw in the last 30 days, most volume first, plus the lists.
    const active = this.ctx.store.activeAccounts('arcus', { day: dayOf(now - 30 * DAY_MS) }, 1, MAX_TRADERS).map((a) => a.acct);
    const traders = [...new Set([...this.listed, ...active])].slice(0, MAX_TRADERS);
    traders.forEach((address, i) => {
      if (now - (this.portfolioAt.get(address) ?? 0) < PORTFOLIO_TTL_MS) return;
      this.lane.add({ key: `pf:${address}`, prio: 2_000 - Math.min(1_900, i), run: () => this.portfolio(address) });
    });
  }

  private async portfolio(address: string): Promise<number> {
    const p = await arcusPortfolio(address, this.pacer);
    const now = this.ctx.now();
    this.portfolioAt.set(address, now);
    this.portfolios++;
    const store = this.ctx.store;
    store.tx(() => {
      for (const w of WINDOWS_WITH_PNL) {
        const pnl = p.pnl[w as keyof typeof p.pnl];
        if (typeof pnl === 'number') store.putPnl('arcus', w, [{ address, pnl, volume: this.listVolume.get(w)?.get(address) ?? null }], now, now);
      }
      if (p.accountValue !== null) store.setAccountValue('arcus', address, p.accountValue, now);
    });
    return 20;
  }

  private rows(address: string, list: ArcusFill[]): FillRow[] {
    return list.map((f): FillRow => ({
      venue: 'arcus',
      address,
      id: f.id,
      t: f.t,
      symbol: f.symbol,
      side: f.side === 'SELL' ? -1 : 1,
      px: f.price,
      sz: f.size,
      fee: f.fee,
      closedPnl: f.closedPnl,
      oid: f.orderId,
      src: 1,
    }));
  }

  /** Fills since `from`, newest first, `limit` a page, up to `maxPages`. */
  private async read(address: string, from: number, limit: number, maxPages: number): Promise<number> {
    const store = this.ctx.store;
    const now = this.ctx.now();
    let to: number | undefined;
    let oldest = now;
    let spent = 0;
    for (let p = 0; p < maxPages; p++) {
      const page = await arcusFills(address, { from, to, limit }, this.pacer);
      spent += 20;
      // Fills with no usable time take their neighbour's before anything is stored or paged on.
      const list = fixFillTimes(page, now);
      store.putFills(this.rows(address, list));
      for (const f of list) oldest = Math.min(oldest, f.t);
      if (page.length < limit) {
        store.addCoverage('arcus', address, 'fills', { fromT: from, toT: now, exhausted: from === 0 }, now);
        return spent;
      }
      // `to` is inclusive upstream: the boundary rows come back again; the key absorbs them.
      to = oldest;
    }
    store.addCoverage('arcus', address, 'fills', { fromT: oldest, toT: now }, now);
    return spent;
  }

  queueCheck(address: string, from: number, prio: number): void {
    // A page of 100 (same 20 weight): two rows can be two fills of ONE execution.
    this.lane.add({ key: `q:${address}`, prio: 5_000 + prio, run: () => this.read(address, from, 100, 2) });
  }

  queueHistory(address: string, from: number, prio: number, catchUpFrom?: number): void {
    const cov = this.ctx.store.coverage('arcus', address, 'fills');
    if (catchUpFrom !== undefined && cov && (cov.fromT <= from || cov.exhausted)) {
      // Only the stretch the stream missed (`read` pages newest first down to it).
      this.lane.add({ key: `h:${address}`, prio: prio >= 20_000 ? prio : 5_000 + Math.min(prio, 4_000) / 10, replace: true, run: () => this.read(address, catchUpFrom, FILLS_PAGE, HISTORY_PAGES) });
      return;
    }
    if (cov && (cov.fromT <= from || cov.exhausted) && this.ctx.now() - cov.restAt < 2 * 60 * 60_000) return;
    this.lane.add({ key: `h:${address}`, prio, replace: true, run: () => this.read(address, from, FILLS_PAGE, HISTORY_PAGES) });
  }

  status(): Record<string, unknown> {
    return {
      queued: this.lane.size, done: this.lane.done, failed: this.lane.failed, lastError: this.lane.lastError,
      stream: this.socketSince(), listed: this.listed.size, portfolios: this.portfolios, byKind: this.lane.byKind(),
    };
  }
}
