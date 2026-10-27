/**
 * Lighter in the index.
 *
 * PnL: Lighter ranks EVERY account (~97k) per window and serves the whole
 * list both ways. The adapter walks it: the first pages of each end every 20
 * minutes (the boards), and the full list continuously in the background, so
 * every Lighter trader has a PnL row for the netted view.
 *
 * Trades: one request per sub-account answers the trade check exactly - the
 * two newest trades, newest first. Board members' fills are then read back
 * to the window start, 100 a page.
 *
 * Stream: the public `trade/{market}` channels (streams.ts LighterStream)
 * name both parties by SUB-ACCOUNT index. An index maps to its wallet once a
 * read of that wallet saw it (sub-accounts of a trade check, the cohorts'
 * account read); the map is kept in `ext_index`. Activity is counted per
 * index, so a wallet's count is the sum over its indices.
 *
 * Budget: Lighter allows 60 requests / minute per IP; the worker takes
 * VALUESCAN_INDEX_LIGHTER (default 30); the API thread keeps 20 with a burst of 8.
 */
import type { BoardWindow, Window } from '../../valuedesk/types.js';
import { WINDOWS } from '../../valuedesk/types.js';
import { Pacer } from '../../valuedesk/extra/http.js';
import { LIGHTER_PAGE, LIGHTER_WS, lighterAccounts, lighterActiveMarkets, lighterLeaderboard, lighterMarkets, lighterTrades, type LighterTrade } from '../../valuedesk/extra/lighter.js';
import { Lane } from '../lanes.js';
import { LighterStream } from '../streams.js';
import type { FillRow, IndexStore } from '../store.js';
import type { ExtContext, ExtVenue } from './types.js';

const PER_MIN = Number(process.env.VALUESCAN_INDEX_LIGHTER) || 30;
/** Each end of each window's ranking, a page of 100 each: enough candidates for a top and a worst 100 of active traders. */
const HEAD_PAGES = 5;
const HEAD_EVERY_MS = 20 * 60_000;
const SUBS_TTL_MS = 24 * 60 * 60_000;
const HISTORY_PAGES = 5;

export class LighterVenue implements ExtVenue {
  readonly venue = 'lighter' as const;
  // The full walk and the cohorts' position reads each keep a share of the
  // budget; trade checks (the boards) take the rest and anything left over.
  // Cohort reads and the slow all-time walk each keep a share; the boards' trade checks take the rest.
  // Shares are of the lane's SPEND (requests): cohort reads keep 45% until the
  // first pass has read every wallet it should (then the stream moves them).
  readonly lane = new Lane({ name: 'lighter', perMin: 100_000, shares: [{ prefix: 'coh:', share: 0.45 }, { prefix: 'walk:', share: 0.1 }] });
  readonly pacer = new Pacer('Lighter index', PER_MIN);
  private ctx!: ExtContext;
  private headAt: Partial<Record<Window, number>> = {};
  private headSnap: Partial<Record<Window, number>> = {};
  /** Full-list walk: next offset per window. */
  private walk: Partial<Record<Window, number>> = {};
  private subs = new Map<string, { at: number; idx: number[] }>();
  private stream: LighterStream | null = null;
  /** Sub-account index -> wallet, and wallet -> its indices. */
  private walletOf = new Map<string, string>();
  private indicesOf = new Map<string, string[]>();

  start(ctx: ExtContext): void {
    this.ctx = ctx;
    for (const [idx, address] of ctx.store.extIndex('lighter')) this.note(address, [idx], false);
    if (process.env.VALUESCAN_INDEX_STREAMS !== '0') {
      this.stream = new LighterStream(ctx.onPrint, () => lighterActiveMarkets(this.pacer), LIGHTER_WS);
      void this.stream.start().catch(() => {
        // No market list: try again in a minute.
        this.stream = null;
        const t = setTimeout(() => this.ctx && this.startStreamLater(), 60_000);
        t.unref?.();
      });
    }
    // The walk resumes where it stopped: a restart must not send it back to page one.
    for (const w of WINDOWS) {
      const at = Number(ctx.store.getMeta(`lighter_walk:${w}`));
      if (at > 0) this.walk[w] = at;
    }
    this.lane.start();
  }

  private startStreamLater(): void {
    if (this.stream || process.env.VALUESCAN_INDEX_STREAMS === '0') return;
    this.stream = new LighterStream(this.ctx.onPrint, () => lighterActiveMarkets(this.pacer), LIGHTER_WS);
    void this.stream.start().catch(() => {
      this.stream = null;
      const t = setTimeout(() => this.startStreamLater(), 60_000);
      t.unref?.();
    });
  }

  stop(): void {
    this.lane.stop();
    this.stream?.stop();
  }

  /** Up only once every active market's channel is confirmed. */
  socketSince(): number | null {
    return this.stream?.since ?? null;
  }

  /** Remember which wallet a set of sub-account indices belongs to (from any read). */
  learn(address: string, indices: readonly (number | string)[]): void {
    if (!this.ctx) return;
    this.note(address, indices.map(String), true);
  }

  private note(address: string, indices: string[], persist: boolean): void {
    const fresh: Array<{ idx: string; address: string }> = [];
    const mine = new Set(this.indicesOf.get(address) ?? []);
    for (const idx of indices) {
      if (this.walletOf.get(idx) === address && mine.has(idx)) continue;
      this.walletOf.set(idx, address);
      mine.add(idx);
      fresh.push({ idx, address });
    }
    this.indicesOf.set(address, [...mine]);
    if (persist && fresh.length) this.ctx.store.putExtIndex('lighter', fresh);
  }

  addressOf(acct: string): string | null {
    return this.walletOf.get(acct) ?? null;
  }

  accountsOf(address: string): string[] | null {
    const l = this.indicesOf.get(address);
    return l && l.length ? l : null;
  }

  maxAgeMs(): number {
    return 6 * 60 * 60_000;
  }

  sourceReady(window: BoardWindow): boolean {
    return (WINDOWS as readonly string[]).includes(window) ? this.headSnap[window as Window] !== undefined : false;
  }

  refresh(now: number): void {
    for (const w of WINDOWS) {
      if (now - (this.headAt[w] ?? 0) >= HEAD_EVERY_MS) {
        this.headAt[w] = now;
        for (const dir of ['desc', 'asc'] as const) {
          for (let p = 0; p < HEAD_PAGES; p++) {
            this.lane.add({ key: `head:${w}:${dir}:${p}`, prio: 9_000 - p, run: () => this.page(w, dir, p * LIGHTER_PAGE, true) });
          }
        }
      }
      // The boards need only the ends above. The all-time list is walked slowly for
      // the cohorts alone (every account's all-time PnL and value = its cohort).
      if (w === 'all' && this.lane.countPrefix(`walk:${w}:`) === 0) this.queueWalk(w);
    }
  }

  private queueWalk(w: Window): void {
    const offset = this.walk[w] ?? 0;
    this.lane.add({ key: `walk:${w}:${offset}`, prio: 100, run: () => this.page(w, 'desc', offset, false) });
  }

  private async page(w: Window, dir: 'asc' | 'desc', offset: number, head: boolean): Promise<number> {
    const r = await lighterLeaderboard(w, { dir, offset }, this.pacer);
    const now = this.ctx.now();
    const store = this.ctx.store;
    store.putPnl('lighter', w, r.rows.map((x) => ({ address: x.address, pnl: x.pnl, volume: x.volume })), r.updatedAt || now, now);
    store.tx(() => {
      for (const x of r.rows) if (x.accountValue !== null) store.setAccountValue('lighter', x.address, x.accountValue, now);
    });
    if (head) this.headSnap[w] = r.updatedAt || now;
    else {
      this.walk[w] = r.rows.length < LIGHTER_PAGE || offset + LIGHTER_PAGE >= r.total ? 0 : offset + LIGHTER_PAGE;
      store.setMeta(`lighter_walk:${w}`, String(this.walk[w]));
      this.queueWalk(w);
    }
    return 1;
  }

  private async subAccounts(address: string): Promise<number[]> {
    const hit = this.subs.get(address);
    if (hit && this.ctx.now() - hit.at < SUBS_TTL_MS) return hit.idx;
    const idx = await lighterAccounts(address, this.pacer);
    this.subs.set(address, { at: this.ctx.now(), idx });
    if (idx.length) {
      this.ctx.store.upsertAccount('lighter', address, { accountId: idx[0]! });
      this.learn(address, idx);
    }
    return idx;
  }

  private rows(address: string, own: Set<number>, list: LighterTrade[], symbols: Map<number, string>): FillRow[] {
    return list.map((t): FillRow => {
      const sell = own.has(t.askAccount);
      return {
        venue: 'lighter',
        address,
        id: t.id,
        t: t.t,
        symbol: symbols.get(t.marketId) ?? String(t.marketId),
        side: sell ? -1 : 1,
        px: t.price,
        sz: t.size,
        fee: null,
        closedPnl: sell ? t.askPnl : t.bidPnl,
        oid: sell ? t.askOrder : t.bidOrder,
        src: 1,
      };
    });
  }

  /**
   * Read each sub-account newest first down to `from` (or `maxPages`). Each
   * sub-account's read covers [its oldest row, now]; the address is covered
   * from the latest of those, so no sub-account is claimed past what was read.
   */
  private async read(address: string, from: number, limit: number, maxPages: number): Promise<number> {
    const store: IndexStore = this.ctx.store;
    const idx = await this.subAccounts(address);
    let spent = 1;
    const now = this.ctx.now();
    if (!idx.length) {
      store.addCoverage('lighter', address, 'fills', { fromT: 0, toT: now, exhausted: true }, now);
      return spent;
    }
    const own = new Set(idx);
    const symbols = await lighterMarkets(this.pacer).catch(() => new Map<number, string>());
    let coveredFrom = 0;
    let exhausted = true;
    for (const i of idx) {
      let cursor: string | undefined;
      let oldest = now;
      let reachedStart = false;
      for (let p = 0; p < maxPages; p++) {
        const r = await lighterTrades(i, { limit, cursor }, this.pacer);
        spent++;
        store.putFills(this.rows(address, own, r.trades, symbols));
        for (const t of r.trades) oldest = Math.min(oldest, t.t);
        if (!r.next) { reachedStart = true; break; }
        if (oldest < from) break;
        cursor = r.next;
      }
      if (reachedStart) continue;
      exhausted = false;
      coveredFrom = Math.max(coveredFrom, oldest);
    }
    store.addCoverage('lighter', address, 'fills', { fromT: exhausted ? 0 : coveredFrom, toT: now, exhausted }, now);
    return spent;
  }

  queueCheck(address: string, from: number, prio: number): void {
    // A full page (one request either way): two rows can be two fills of ONE execution.
    this.lane.add({ key: `q:${address}`, prio: 5_000 + prio, run: () => this.read(address, from, LIGHTER_PAGE, 2) });
  }

  queueHistory(address: string, from: number, prio: number, catchUpFrom?: number): void {
    const cov = this.ctx.store.coverage('lighter', address, 'fills');
    if (catchUpFrom !== undefined && cov && (cov.fromT <= from || cov.exhausted)) {
      // Only the stretch the stream missed, newest first: a page or two.
      // Rows on the leaderboard's opening boards (and on screen) keep their priority; the rest sit under the rankings.
      this.lane.add({ key: `h:${address}`, prio: prio >= 20_000 ? prio : 4_500 + Math.min(prio, 4_000) / 10, replace: true, run: () => this.read(address, catchUpFrom, LIGHTER_PAGE, HISTORY_PAGES) });
      return;
    }
    if (cov && (cov.fromT <= from || cov.exhausted) && this.ctx.now() - cov.restAt < 2 * 60 * 60_000) return;
    // Below the full-list walk (4,500): PnL for every account first, deep history after.
    this.lane.add({ key: `h:${address}`, prio: prio >= 20_000 ? prio : Math.min(prio, 4_000), replace: true, run: () => this.read(address, from, LIGHTER_PAGE, HISTORY_PAGES) });
  }

  status(): Record<string, unknown> {
    return {
      queued: this.lane.size, done: this.lane.done, failed: this.lane.failed, lastError: this.lane.lastError, walk: this.walk,
      byKind: this.lane.byKind(), stream: this.socketSince(), subscribed: this.stream?.subscribed ?? null, indices: this.walletOf.size,
    };
  }
}
