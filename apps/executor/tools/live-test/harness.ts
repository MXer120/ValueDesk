/**
 * What a scenario has to work with: the executor of the run's target
 * (target.ts: signed requests, a hard restart where the target allows one), the
 * follower's account as SoDEX reports it, the leader wallet the harness trades
 * itself, sizes derived from SoDEX's own market rules, and checks that are
 * counted and named.
 *
 * ONE SCENARIO, TWO MODES. A live run reads every check from SoDEX. A dry run
 * (--dry) sends the same specs with `paper: true` to an executor whose real
 * orders are off, and reads the same checks from the executor's paper book
 * (its simulated fills, children and exits). What only an exchange can answer
 * - a fee SoDEX charged, a post-only order it refused, the leverage it set, a
 * stop it holds, a leader's real trade - is wrapped in `t.live(...)`: counted
 * in a dry run as "not checked here", never as passed.
 */
import type { AlgoView, CopyView, MarketInfo } from '../../../../packages/copy-engine/src/index.ts';
import type { FillInfo, OrderInfo, SodexReads, SodexWallet } from './exchange.ts';
import type { ExecutorApi, ExecutorTarget } from './target.ts';

/** The market did not do what the scenario waited for (a price never reached in time): run it again later. */
export class Inconclusive extends Error {
  override name = 'Inconclusive';
}

/** The scenario cannot run here (the executor lacks the feature, the region forbids it): skipped, with why. */
export class Unavailable extends Error {
  override name = 'Unavailable';
}

export class CheckFailed extends Error {
  override name = 'CheckFailed';
}

export interface Env {
  mode: 'live' | 'dry';
  reads: SodexReads;
  /** Live only: the follower and the leader, with the harness's own key on each. */
  follower: SodexWallet | null;
  leader: SodexWallet | null;
  followerAddress: string;
  leaderAddress: string;
  /** The executor the scenarios run against (--target): its API, and what the runner can do to it. */
  target: ExecutorTarget;
  /** The leverage ceiling of the region (the stricter of the declared country and the one the target sees; EEA: 2), null = none. */
  regionMaxLeverage: number | null;
  /** The country of residence the owner declares with the terms (the env file). */
  country: string;
  /** keccak256 of the copy terms text the web app shows (apps/web/src/legal/copyTerms.ts). */
  termsHash: string;
  /** The builder the executor's orders carry, and the fee ceiling the follower must approve (tenths of a bp: the ladder's top step). */
  builderId: number;
  builderFee: number;
  /** The steps of the executor's copy fee ladder (its /info), tenths of a bp. */
  builderLadder: number[];
  /**
   * The fee its orders carry, where it is known here: a local executor reads no follower volume, so
   * the ladder's first step. null: the step of a volume only the executor knows (ValueDesk's own) -
   * any step of the ladder is accepted, the same on every order, and noted.
   */
  orderFee: number | null;
  main: MarketInfo;
  second: MarketInfo;
  /** USD per child order: SoDEX's minimum plus headroom, so a price move during the scenario keeps it above the minimum. */
  childUsd: number;
  /** Shorter waits for a dry run. */
  timeScale: number;
  log: (line: string) => void;
}

export interface Account {
  position(symbol: string): Promise<number>;
  openOrders(symbol: string): Promise<OrderInfo[]>;
  /** Fills of the market since the scenario began. */
  fills(symbol: string): Promise<FillInfo[]>;
  /** Orders of the market since the scenario began (filled, cancelled, refused, open). */
  history(symbol: string): Promise<OrderInfo[]>;
}

/** Client order ids of one algo's children and exits start with this. */
export const algoPrefix = (algoId: string): string => `va-${algoId.slice(1, 13)}-`;

const signOf = (side: 'buy' | 'sell') => (side === 'buy' ? 1 : -1);

/** The follower's account as SoDEX reports it. */
class LiveAccount implements Account {
  constructor(
    private readonly env: Env,
    private readonly since: number,
  ) {}
  position(symbol: string) {
    return this.env.reads.position(this.env.followerAddress, symbol);
  }
  openOrders(symbol: string) {
    return this.env.reads.openOrders(this.env.followerAddress, symbol);
  }
  fills(symbol: string) {
    return this.env.reads.fills(this.env.followerAddress, symbol, this.since);
  }
  history(symbol: string) {
    return this.env.reads.history(this.env.followerAddress, symbol, this.since);
  }
}

/** The follower's account as the executor's paper book has it (dry runs): algos and paper copies started in this scenario. */
class PaperAccount implements Account {
  constructor(
    private readonly env: Env,
    private readonly since: number,
  ) {}

  private async mine(): Promise<AlgoView[]> {
    return (await this.env.target.algos()).filter((v) => v.algo.createdAt >= this.since - 1_000);
  }

  async position(symbol: string): Promise<number> {
    let size = 0;
    for (const v of await this.mine()) {
      const s = v.algo.spec;
      if (s.kind === 'basket' || s.symbol !== symbol) continue;
      size += signOf(s.side) * v.algo.filled;
      for (const x of v.exits ?? []) size -= signOf(s.side) * x.filled;
    }
    for (const c of (await this.env.target.me()).copies) {
      if (c.subscription.createdAt < this.since - 1_000) continue;
      for (const p of c.positions) if (p.symbol === symbol) size += p.size;
    }
    return size;
  }

  async openOrders(symbol: string): Promise<OrderInfo[]> {
    const out: OrderInfo[] = [];
    for (const v of await this.mine()) {
      const a = v.algo;
      if (a.spec.symbol !== symbol && a.spec.kind !== 'basket') continue;
      for (const c of a.children) {
        if (c.state === 'done' || c.cancelling) continue;
        out.push({ orderId: c.orderId ?? c.clOrdID, clOrdID: c.clOrdID, side: c.side, price: c.price, qty: c.quantity, filled: c.filled, tif: c.tif.toUpperCase(), type: 'LIMIT', status: 'NEW', reduceOnly: c.reduceOnly, stop: null, builderFee: null, createdAt: c.placedAt });
      }
      for (const c of a.exitOrders ?? []) {
        if (c.state === 'done' || c.cancelling || !c.exit) continue;
        out.push({ orderId: c.orderId ?? c.clOrdID, clOrdID: c.clOrdID, side: c.side, price: 0, qty: c.quantity, filled: c.filled, tif: 'IOC', type: 'MARKET', status: 'NEW', reduceOnly: true, stop: { kind: c.exit, trigger: c.price }, builderFee: null, createdAt: c.placedAt });
      }
    }
    return out;
  }

  async fills(symbol: string): Promise<FillInfo[]> {
    const out: FillInfo[] = [];
    for (const v of await this.mine()) {
      if (v.algo.spec.symbol !== symbol) continue;
      for (const e of await this.env.target.events(v.algo.id, 500)) {
        if (e.kind !== 'fill' || !e.qty || !e.price) continue;
        out.push({ clOrdID: e.clOrdID, orderId: e.clOrdID ?? '', side: e.side ?? v.algo.spec.side, price: e.price, qty: e.qty, fee: 0, builderFee: 0, maker: false, time: e.at });
      }
    }
    return out;
  }

  async history(symbol: string): Promise<OrderInfo[]> {
    const out: OrderInfo[] = [];
    for (const v of await this.mine()) {
      if (v.algo.spec.symbol !== symbol) continue;
      for (const c of [...v.algo.children, ...(v.algo.exitOrders ?? [])]) {
        out.push({ orderId: c.orderId ?? c.clOrdID, clOrdID: c.clOrdID, side: c.side, price: c.price, qty: c.quantity, filled: c.filled, tif: c.tif.toUpperCase(), type: c.exit ? 'MARKET' : 'LIMIT', status: c.state === 'done' ? (c.filled >= c.quantity ? 'FILLED' : 'CANCELED') : 'NEW', reduceOnly: c.reduceOnly, stop: c.exit ? { kind: c.exit, trigger: c.price } : null, builderFee: null, createdAt: c.placedAt });
      }
    }
    return out;
  }
}

export interface WaitOptions {
  timeoutMs: number;
  everyMs?: number;
  /** Running out of time means the market did not cooperate (Inconclusive), not a failure. */
  inconclusive?: boolean;
}

export class T {
  readonly startedAt = Date.now();
  readonly account: Account;
  readonly checks = { passed: 0, liveOnly: 0 };
  readonly notes: string[] = [];
  /** Algos and copies this scenario started (the cleanup stops them first). */
  readonly algos: string[] = [];
  readonly copies: string[] = [];
  /** The builder fee SoDEX showed on this scenario's orders, where it is not known beforehand (checkOrderFees). */
  feeRate: number | null = null;
  /**
   * Set by the runner when it stops waiting for this scenario (its timeout, Ctrl+C): the scenario's
   * code may still be running, but from then on it can place nothing - every action throws - so the
   * cleanup that follows is the last word on the account.
   */
  private abandoned: string | null = null;

  abandon(why: string): void {
    this.abandoned ??= why;
  }

  private alive(): void {
    if (this.abandoned) throw new CheckFailed(`abandoned (${this.abandoned}): nothing more is sent`);
  }

  constructor(readonly env: Env, readonly id: string) {
    this.account = env.mode === 'live' ? new LiveAccount(env, this.startedAt) : new PaperAccount(env, this.startedAt);
  }

  get dry(): boolean {
    return this.env.mode === 'dry';
  }
  /** Where the checks read the account: SoDEX, or (dry) the executor's paper book. */
  get where(): string {
    return this.dry ? 'the paper book' : 'SoDEX';
  }
  get exec(): ExecutorApi {
    return this.env.target;
  }
  get main(): MarketInfo {
    return this.env.main;
  }
  get second(): MarketInfo {
    return this.env.second;
  }
  get U(): number {
    return this.env.childUsd;
  }

  note(msg: string): void {
    this.notes.push(msg);
    this.env.log(`    . ${msg}`);
  }

  /** One check: it holds, or the scenario fails with `what`. */
  check(ok: boolean, what: string, detail?: unknown): void {
    if (!ok) throw new CheckFailed(`${what}${detail === undefined ? '' : ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})`}`);
    this.checks.passed += 1;
    this.env.log(`    ok ${what}`);
  }

  /** Checks only a real exchange can answer: run live; in a dry run counted as not checked. */
  async live(what: string, fn: () => Promise<void>): Promise<void> {
    if (this.dry) {
      this.checks.liveOnly += 1;
      this.env.log(`    -- live only: ${what}`);
      return;
    }
    await fn();
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.round(ms * (this.dry ? this.env.timeScale : 1))));
    this.alive();
  }

  /** Poll `fn` until it returns something truthy, or fail (or be inconclusive) after `timeoutMs`. */
  async waitFor<V>(what: string, fn: () => Promise<V | null | undefined | false>, o: WaitOptions): Promise<V> {
    const until = Date.now() + o.timeoutMs;
    let last: unknown = null;
    for (;;) {
      this.alive();
      const gone = this.env.target.gone();
      if (gone) throw new CheckFailed(`${gone} while waiting for: ${what}`);
      try {
        const v = await fn();
        if (v) {
          this.checks.passed += 1;
          this.env.log(`    ok ${what}`);
          return v;
        }
      } catch (e) {
        last = e;
      }
      if (Date.now() >= until) {
        const msg = `timed out after ${Math.round(o.timeoutMs / 1000)} s waiting for: ${what}${last ? ` (last error: ${String(last).slice(0, 160)})` : ''}`;
        throw o.inconclusive ? new Inconclusive(msg) : new CheckFailed(msg);
      }
      await new Promise((r) => setTimeout(r, o.everyMs ?? 2_000));
    }
  }

  /* ---------------------------------------------------------------- sizes ----- */

  /** Base quantity worth at least `usd` at the current touch (rounded UP to the step, so it never falls under). */
  async qty(usd: number, symbol = this.main.name): Promise<string> {
    const m = symbol === this.main.name ? this.main : this.second;
    const q = await this.env.reads.quote(symbol);
    const step = Number(m.stepSize);
    const decimals = (m.stepSize.split('.')[1] ?? '').length;
    return (Math.ceil(usd / q.bid / step) * step).toFixed(decimals);
  }

  quote(symbol = this.main.name) {
    return this.env.reads.quote(symbol);
  }

  /** A price snapped to the market's tick. */
  tick(price: number, symbol = this.main.name, mode: 'down' | 'up' | 'near' = 'near'): number {
    const m = symbol === this.main.name ? this.main : this.second;
    const t = Number(m.tickSize);
    const k = price / t;
    const r = mode === 'down' ? Math.floor(k) : mode === 'up' ? Math.ceil(k) : Math.round(k);
    return Number((r * t).toFixed((m.tickSize.split('.')[1] ?? '').length));
  }

  /** The leverage an algo or copy ends up with on SoDEX when it asks for `want`: the region's cap and the market's. */
  expectedLeverage(want: number, m = this.main): number {
    let l = Math.min(want, m.maxLeverage);
    if (this.env.regionMaxLeverage !== null) l = Math.min(l, this.env.regionMaxLeverage);
    return Math.max(1, Math.floor(l));
  }

  /* ---------------------------------------------------------------- algos ----- */

  /** A spec for this run: on the main market, paper exactly when the run is dry. */
  spec(x: Record<string, unknown>): Record<string, unknown> {
    const s: Record<string, unknown> = { symbol: this.main.name, side: 'buy', label: `live-test ${this.id}`.slice(0, 40), ...x, paper: this.dry };
    const then = s.then as { type?: string; algo?: Record<string, unknown> } | undefined;
    if (then?.type === 'algo' && then.algo) then.algo = { ...then.algo, paper: this.dry };
    return s;
  }

  async start(x: Record<string, unknown>): Promise<AlgoView> {
    this.alive();
    const v = await this.exec.algoStart(this.spec(x));
    this.algos.push(v.algo.id);
    this.note(`started ${v.algo.spec.kind} ${v.algo.id} (${v.algo.spec.side} ${('quantity' in v.algo.spec ? v.algo.spec.quantity : '') || ''} ${v.algo.spec.symbol})`);
    return v;
  }

  view(id: string): Promise<AlgoView> {
    return this.exec.algo(id);
  }

  /** Wait until the algo's view satisfies `pred`. */
  waitAlgo(id: string, what: string, pred: (v: AlgoView) => boolean, o: WaitOptions): Promise<AlgoView> {
    return this.waitFor(what, async () => {
      const v = await this.view(id);
      return pred(v) ? v : null;
    }, o);
  }

  /** Wait until the algo has ended (any final status), and return it. */
  waitEnded(id: string, timeoutMs: number, inconclusive = false): Promise<AlgoView> {
    return this.waitAlgo(id, `algo ${id} ended`, (v) => ['done', 'cancelled', 'expired', 'failed'].includes(v.algo.status), { timeoutMs, inconclusive });
  }

  /** The follower's open orders that belong to one algo (its children and exits). */
  async algoOrders(id: string, symbol = this.main.name): Promise<OrderInfo[]> {
    const p = algoPrefix(id);
    return (await this.account.openOrders(symbol)).filter((o) => o.clOrdID?.startsWith(p));
  }

  /** The follower's fills that belong to one algo. */
  async algoFills(id: string, symbol = this.main.name): Promise<FillInfo[]> {
    const p = algoPrefix(id);
    return (await this.account.fills(symbol)).filter((f) => f.clOrdID?.startsWith(p));
  }

  /** The builder fee the orders should carry, in words: '2.5 bp', or (not known here) 'a step of its fee ladder'. */
  get feeText(): string {
    return this.env.orderFee !== null ? `${this.env.orderFee / 10} bp` : 'a step of its fee ladder';
  }

  /**
   * Every one of these orders (SoDEX's history) names the builder fee the executor should charge:
   * the known one (Env.orderFee), or - where only the executor knows the follower's volume - one step
   * of its ladder, the same on every order, which is noted and used by the fill checks after it.
   */
  checkOrderFees(orders: OrderInfo[]): number {
    const want = this.env.orderFee;
    if (want !== null) {
      this.check(orders.every((o) => o.builderFee === want), `each order names the builder fee ${want} (${want / 10} bp)`, orders.map((o) => o.builderFee));
      return want;
    }
    const rates = [...new Set(orders.map((o) => o.builderFee))];
    const rate = rates.length === 1 ? rates[0]! : null;
    this.check(rate !== null && this.env.builderLadder.includes(rate), `each order names the same builder fee, a step of the ladder ${this.env.builderLadder.join('/')}`, rates);
    this.feeRate = rate;
    this.note(`the executor charges builder fee ${rate} (${rate! / 10} bp)`);
    return rate!;
  }

  /**
   * Every builder fee SoDEX charged on these fills is the rate the orders carry, of their value, within
   * rounding: the known one, the one an order check saw, or else the ladder step nearest the first fill's.
   */
  async checkBuilderFee(fills: FillInfo[], rateTenthsBp: number | null = this.feeRate ?? this.env.orderFee): Promise<void> {
    await this.live(rateTenthsBp !== null ? `SoDEX charged the ${rateTenthsBp / 10} bp builder fee on every fill` : 'SoDEX charged one step of the builder fee ladder on every fill', async () => {
      this.check(fills.length > 0, 'there are fills to check the builder fee on');
      let rate = rateTenthsBp;
      if (rate === null) {
        const f = fills[0]!;
        const seen = (f.builderFee / (f.qty * f.price)) * 100_000;
        rate = this.env.builderLadder.reduce((a, b) => (Math.abs(b - seen) < Math.abs(a - seen) ? b : a), this.env.builderLadder[0] ?? 0);
        this.note(`the fills show builder fee ${rate} (${rate / 10} bp), the ladder step nearest ${seen.toFixed(1)}`);
      }
      for (const f of fills) {
        const want = (f.qty * f.price * rate) / 100_000;
        this.check(Math.abs(f.builderFee - want) <= Math.max(want * 0.15, 1e-6), `builder fee ${f.builderFee} on ${f.qty} @ ${f.price} is ${rate / 10} bp`, { want });
      }
    });
  }

  /* ------------------------------------------------------- the follower ----- */

  /** Open a position on the follower straight on SoDEX (the harness's key), for scenarios that start from one. Dry: not possible. */
  async openPosition(side: 'buy' | 'sell', usd: number, symbol = this.main.name): Promise<number> {
    this.alive();
    if (this.dry || !this.env.follower) {
      this.checks.liveOnly += 1;
      this.env.log(`    -- live only: open a ${side} of $${usd} ${symbol} on the follower first`);
      return 0;
    }
    await this.env.follower.iocUsd(symbol, side, usd, { tag: 'setup' });
    return this.waitFor(`the follower holds a ${side === 'buy' ? 'long' : 'short'} on ${symbol}`, async () => {
      const p = await this.account.position(symbol);
      return p !== 0 && Math.sign(p) === signOf(side) ? p : null;
    }, { timeoutMs: 20_000 });
  }

  /** Wait until the follower's position (signed USD at the mark) is within `tol` of `usd`. Live only. */
  async expectFollowerUsd(usd: number, what: string, o: { tol?: number; timeoutMs?: number; symbol?: string } = {}): Promise<void> {
    const symbol = o.symbol ?? this.main.name;
    await this.live(what, async () => {
      const tol = o.tol ?? 0.25;
      await this.waitFor(what, async () => {
        const [p, q] = await Promise.all([this.account.position(symbol), this.quote(symbol)]);
        const v = p * q.mark;
        if (usd === 0) return p === 0 ? true : null;
        return Math.sign(v) === Math.sign(usd) && Math.abs(v - usd) <= Math.abs(usd) * tol ? true : null;
      }, { timeoutMs: o.timeoutMs ?? 90_000 });
    });
  }

  /* ----------------------------------------------------------- the leader ----- */

  /** The leader trades `usd` (or closes): real IOCs on the leader wallet. Dry: there is no leader to trade with. */
  async leader(action: { buyUsd?: number; sellUsd?: number; close?: boolean }, symbol = this.main.name): Promise<void> {
    this.alive();
    const what = action.close ? 'closes' : action.buyUsd ? `buys $${action.buyUsd}` : `sells $${action.sellUsd}`;
    if (this.dry || !this.env.leader) {
      this.checks.liveOnly += 1;
      this.env.log(`    -- live only: the leader ${what} ${symbol}`);
      return;
    }
    const L = this.env.leader;
    const before = await L.position(symbol);
    if (action.close) {
      if (before) await L.close(symbol, before);
    } else if (action.buyUsd) await L.iocUsd(symbol, 'buy', action.buyUsd, { tag: 'leader' });
    else if (action.sellUsd) await L.iocUsd(symbol, 'sell', action.sellUsd, { tag: 'leader' });
    const after = await this.waitFor(`the leader's trade (${what}) shows on SoDEX`, async () => {
      const p = await L.position(symbol);
      return p !== before || (action.close && p === 0) ? { p } : null;
    }, { timeoutMs: 20_000, everyMs: 750 });
    this.note(`leader ${what}: position ${before} -> ${after.p}`);
  }

  /** The leader's own fills since the scenario began (SoDEX's record, its timestamps). */
  async leaderFills(symbol = this.main.name): Promise<FillInfo[]> {
    if (!this.env.leader) return [];
    return this.env.reads.fills(this.env.leaderAddress, symbol, this.startedAt);
  }

  async leaderUsd(symbol = this.main.name): Promise<number> {
    if (!this.env.leader) return 0;
    const [p, q] = await Promise.all([this.env.leader.position(symbol), this.quote(symbol)]);
    return p * q.mark;
  }

  /* ----------------------------------------------------------- copies ----- */

  /** Copy rules for the leader wallet: paper exactly when the run is dry. */
  settings(x: Record<string, unknown>): Record<string, unknown> {
    return {
      leader: { venue: 'sodex', address: this.env.leaderAddress },
      assetAllow: [this.main.base],
      stopLossPct: null,
      takeProfitPct: null,
      drawdownStopPct: null,
      copyExisting: false,
      slippageBps: 50,
      marginMode: 'isolated',
      approval: 'auto',
      maxPositionUsd: 1000,
      ...x,
      paper: this.dry,
    };
  }

  async subscribe(x: Record<string, unknown>): Promise<CopyView> {
    this.alive();
    const v = await this.exec.subscribe(this.settings(x));
    this.copies.push(v.subscription.id);
    this.note(`copy ${v.subscription.id} started (${v.subscription.settings.sizingMode}${v.subscription.settings.direction === 'counter' ? ', counter' : ''})`);
    return v;
  }

  /* ---------------------------------------------------------- restarts ----- */

  /**
   * Kill the executor hard, do `whileDown`, start it again on the same data, and wait until it lists
   * what it had. Only where the target lets the runner (a scenario that calls it declares needs: ['restart']).
   */
  async restart(o: { downMs?: number; whileDown?: () => Promise<void> } = {}): Promise<void> {
    const target = this.env.target;
    if (!target.capabilities.restart) throw new Unavailable(`the ${target.name} target cannot be restarted from here`);
    this.note('killing the executor (no shutdown code runs)');
    await target.kill();
    if (o.whileDown) await o.whileDown();
    if (o.downMs) await new Promise((r) => setTimeout(r, o.downMs));
    await target.start();
    this.note('the executor is up again on the same data folder');
  }
}
