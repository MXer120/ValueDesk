/**
 * Fee credits and the invite welcome, kept against the builder ledger (claim.ts has the rules).
 *
 * Every TICK_MS (main API only: the beta API reads the same file):
 *   earn   each invitee's counted orders (builder ledger) inside its CREDIT_MONTHS from the join: the builder fee it
 *          paid (counted volume x the fee its order named) x CREDIT_SHARE, onto the inviter's balance;
 *   spend  each wallet with credits: its counted orders that paid less than it would have without credits (standardFee,
 *          valued now) - the difference comes off its balance;
 *   switch a balance of CREDIT_MIN_USD or more turns credits on (the wallet's builder fee is CREDIT_FEE on every
 *          product), 0 or less turns them off; in between it stays as it was.
 * The welcome needs no record: an invited wallet with less than WELCOME_USD of lifetime counted volume has it.
 *
 * What credits can overrun: the fees of the volume a wallet trades between its balance reaching 0 and the switch
 * reaching its orders - the builder ledger's counting delay (the explorer check), up to TICK_MS here, and the TTL of the
 * signed fee (10 minutes; the executor reads programs on each fee check). That overrun is spent like any other, so the
 * balance goes below 0 by it and the next credits pay it back first.
 */
import type { FeeProduct, FeeProgram } from '../admin/store.js';
import type { BuilderService } from '../builder/service.js';
import { MICRO } from '../builder/tiers.js';
import { CREDIT_FEE, CREDIT_MIN_USD, CREDIT_MONTHS, CREDIT_SHARE, CREDIT_WINDOW_MS, WELCOME_USD, type InviteMe } from './claim.js';
import type { InviteStore } from './store.js';

export const TICK_MS = 60_000;
/** Seen-order rows outlive the builder ledger's orders (kept 30 days by their last fill) by this much. */
const SEEN_KEEP_MS = 60 * 86_400_000;
const ALL: FeeProduct[] = ['perps', 'spot', 'copy', 'bots'];

/** What an order is, by the client order id the engines give theirs (builder/tiers.ts ENGINE_ORDER_ID). */
export function productOf(engine: 'perps' | 'spot', cl: string | null): FeeProduct {
  if (cl?.startsWith('vdc-') || cl?.startsWith('vds-')) return 'copy';
  // Algo children and bots share `va-`: valued at the bot ladder (most of them are bots; an algo order is valued low).
  if (cl?.startsWith('va-')) return 'bots';
  return engine;
}

/** The builder fee of `countedMicro` of volume at `rate` tenths of a bp, micro-USD. */
export const feeMicro = (countedMicro: number, rate: number): number => (countedMicro * rate) / 100_000;

/** On, off, or as it was: the hysteresis between CREDIT_MIN_USD and 0. */
export function payingNext(balanceMicro: number, was: boolean): boolean {
  if (balanceMicro >= CREDIT_MIN_USD * MICRO) return true;
  if (balanceMicro <= 0) return false;
  return was;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export class InviteService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per wallet, what the fee path reads on every decision: credits paying, the welcome's end. */
  private paying = new Set<string>();

  constructor(
    readonly store: InviteStore,
    private readonly builder: BuilderService,
    private readonly o: { now?: () => number; log?: { warn(o: object, m: string): void } } = {},
  ) {
    for (const w of store.creditWallets()) if (store.stateOf(w)?.paying) this.paying.add(w);
    builder.setExtraPrograms((address, at) => this.programsFor(address, at));
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Keep the ledger (main API). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.o.log?.warn({ err: String(e) }, 'invites: the credit tick failed'); } }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The builder ledger's lifetime counted volume of a wallet, micro-USD (0 when it has none or cannot be read). */
  private lifetimeMicro(address: string): number {
    const cfg = this.builder.tiers.current();
    const st = this.builder.store;
    if (!cfg || !st) return 0;
    const w = st.wallet(cfg.builderId, address.toLowerCase());
    return w ? w.perpsMicro + w.spotMicro : 0;
  }

  hasVolume(address: string): boolean {
    return this.lifetimeMicro(address) > 0;
  }

  welcomeActive(address: string): boolean {
    return !!this.store.joinOf(address) && this.lifetimeMicro(address) < WELCOME_USD * MICRO;
  }

  /** What lowers this wallet's builder fee now: the welcome, or credits that pay (each CREDIT_FEE on every product). */
  programsFor(address: string, now: number): FeeProgram[] {
    const a = address.toLowerCase();
    const out: FeeProgram[] = [];
    const mk = (label: string): FeeProgram => ({ id: 0, address: a, products: ALL, fee: CREDIT_FEE, from: 0, until: null, label, addedAt: 0, addedBy: 'invites' });
    if (this.welcomeActive(a)) out.push(mk('Invite welcome'));
    else if (this.paying.has(a)) out.push(mk('Fee credits'));
    void now;
    return out;
  }

  /** One pass: earn, spend, switch. */
  tick(): void {
    const cfg = this.builder.tiers.current();
    const ledger = this.builder.store;
    if (!cfg || !ledger) return;
    const now = this.now();
    // Earn: each invitee's paid fees inside its window.
    for (const j of this.store.allJoins()) {
      const until = j.at + CREDIT_WINDOW_MS;
      const key = `e:${j.wallet}`;
      for (const o of ledger.countedOrders(cfg.builderId, j.wallet, j.at)) {
        if (o.t < j.at || o.t > until) continue;
        const seen = this.store.seenOf(key, o.key);
        const delta = o.countedMicro - seen;
        if (delta <= 0) continue;
        this.store.take(key, o.key, o.countedMicro, [{ address: j.inviter, kind: 'earn', micro: feeMicro(delta, o.rate) * CREDIT_SHARE, source: j.wallet }], now);
      }
    }
    // Spend: what credits paid, valued at the fee the wallet would have paid.
    for (const w of this.store.creditWallets()) {
      const st = this.store.stateOf(w);
      if (!st) {
        this.switch(w, now);
        continue;
      }
      const key = `s:${w}`;
      // Only orders since credits first paid; during the welcome nothing is spent (it is ValueDesk's).
      const since = this.store.firstPaying(w);
      if (since === null) { this.switch(w, now); continue; }
      for (const o of ledger.countedOrders(cfg.builderId, w, since)) {
        if (o.t < since) continue;
        const seen = this.store.seenOf(key, o.key);
        const delta = o.countedMicro - seen;
        if (delta <= 0) continue;
        const std = this.builder.standardFee(w, productOf(o.engine, o.cl), now);
        const spend = std === null || this.welcomeActive(w) ? 0 : feeMicro(delta, Math.max(0, std - o.rate));
        this.store.take(key, o.key, o.countedMicro, [{ address: w, kind: 'spend', micro: spend, source: null }], now);
      }
      this.switch(w, now);
    }
    this.store.pruneSeen(now - SEEN_KEEP_MS);
  }

  private switch(w: string, now: number): void {
    const next = payingNext(this.store.totals(w).balance, this.paying.has(w));
    if (next) this.paying.add(w); else this.paying.delete(w);
    this.store.setState(w, next, now);
  }

  /** A wallet's invites and credits, for the Savings page. Invitees shortened: the page never names them whole. */
  me(address: string): InviteMe {
    const a = address.toLowerCase();
    const t = this.store.totals(a);
    const join = this.store.joinOf(a);
    const life = this.lifetimeMicro(a);
    const invitees = this.store.invitesOf(a).map((j) => ({
      wallet: short(j.wallet),
      at: j.at,
      trading: this.lifetimeMicro(j.wallet) > 0,
      earnedUsd: this.store.earnedFrom(a, j.wallet) / MICRO,
      until: j.at + CREDIT_WINDOW_MS,
    }));
    return {
      ok: true,
      code: this.store.codeOf(a),
      joined: join ? { code: join.code, at: join.at } : null,
      canJoin: !join && life === 0,
      welcome: join ? { active: life < WELCOME_USD * MICRO, leftUsd: Math.max(0, WELCOME_USD - life / MICRO), limitUsd: WELCOME_USD } : null,
      credits: { balanceUsd: t.balance / MICRO, earnedUsd: t.earned / MICRO, spentUsd: t.spent / MICRO, paying: this.paying.has(a), share: CREDIT_SHARE, months: CREDIT_MONTHS },
      invitees,
    };
  }
}
