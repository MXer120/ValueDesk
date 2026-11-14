/**
 * Fee credits and the welcome, kept against the builder ledger (claim.ts has the rules).
 *
 * Every TICK_MS (main API only: the beta API reads the same file):
 *   earn   each referral's counted orders (builder ledger) since its join: the builder fee it paid (counted volume x
 *          the fee its order named) x TIER_SHARES[tier], onto each of up to three inviters above it;
 *   spend  each wallet with credits: its counted orders since credits first paid that paid less than it would have
 *          without credits (standardFee, valued now) - the difference comes off its balance;
 *   switch credits pay (the wallet's fee is CREDIT_FEE everywhere) from a balance that covers CREDIT_COVER_MIN of the
 *          wallet's own recent trading (never less than CREDIT_MIN_USD), and stop at 0.
 * The welcome needs no record: a wallet that joined with it pays no builder fee until it traded WELCOME_USD on SoDEX
 * since the join (the builder verifier's sweep of all its fills, builder store `traded`).
 *
 * What stops the lowered fee from running past what pays for it:
 *   - it is handed out PERK_HORIZON_MS at a time (the signed terms end with it, the executor asks again sooner);
 *   - the executor gets a budget with it (perkBudget): what is left, what each dollar of its orders uses up, and up to
 *     when the ledger has read the wallet's fills - it counts its own fills after that and stops at the budget;
 *   - credits switch on only with enough to cover the wallet's own pace for CREDIT_COVER_MIN, so a trickle of credit
 *     never opens the lowered fee to a burst;
 *   - whatever still runs over is spent like any other fee: the balance goes below 0 and the next credits repay it.
 */
import type { FeeProduct, FeeProgram } from '../admin/store.js';
import type { BuilderService } from '../builder/service.js';
import { dayOf } from '../builder/counting.js';
import { MICRO } from '../builder/tiers.js';
import {
  CREDIT_COVER_MIN, CREDIT_FEE, CREDIT_MIN_USD, OURS_CODE, PERK_HORIZON_MS, TIER_SHARES, TIERS, WELCOME_CAP, WELCOME_CAP_DAYS,
  WELCOME_FEE, WELCOME_USD, type InviteMe, type InviteReferral,
} from './claim.js';
import { sodexOwnerOf } from './sodex.js';
import type { InviteStore } from './store.js';

export const TICK_MS = 60_000;
/** Seen-order rows outlive the builder ledger's orders (kept 30 days by their last fill) by this much. */
const SEEN_KEEP_MS = 60 * 86_400_000;
const HOUR = 3_600_000;
const ALL: FeeProduct[] = ['perps', 'spot', 'copy', 'bots'];
/** A code SoDEX said nobody owns is asked about again after this long. */
const NO_OWNER_MS = 10 * 60_000;

/** What an order is, by the client order id the engines give theirs (builder/tiers.ts ENGINE_ORDER_ID). */
export function productOf(engine: 'perps' | 'spot', cl: string | null): FeeProduct {
  if (cl?.startsWith('vdc-') || cl?.startsWith('vds-')) return 'copy';
  // Algo children and bots share `va-`: valued at the bot ladder (most of them are bots; an algo order is valued low).
  if (cl?.startsWith('va-')) return 'bots';
  return engine;
}

/** The builder fee of `countedMicro` of volume at `rate` tenths of a bp, micro-USD. */
export const feeMicro = (countedMicro: number, rate: number): number => (countedMicro * rate) / 100_000;

/** On, off, or as it was: on from `onAtMicro` (at least CREDIT_MIN_USD), off at 0, in between as it was. */
export function payingNext(balanceMicro: number, was: boolean, onAtMicro = CREDIT_MIN_USD * MICRO): boolean {
  if (balanceMicro >= Math.max(CREDIT_MIN_USD * MICRO, onAtMicro)) return true;
  if (balanceMicro <= 0) return false;
  return was;
}

/**
 * What the executor may still run at the lowered fee for a wallet: `capUsd` of welcome volume or of credit, each dollar
 * of an order on a product using `perUsd[product]` of it, counted from `through` (fills before it are in the ledger).
 */
export interface PerkBudget {
  kind: 'welcome' | 'credits';
  capUsd: number;
  perUsd: { copy: number; bots: number };
  through: number;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export class InviteService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Wallets whose credits pay now (what the fee path reads on every decision). */
  private paying = new Set<string>();
  /** When the last tick finished: the balance reflects the ledger's counted orders up to then. */
  private tickedAt = 0;
  private readonly noOwner = new Map<string, number>();

  constructor(
    readonly store: InviteStore,
    private readonly builder: BuilderService,
    private readonly o: {
      now?: () => number;
      log?: { warn(o: object, m: string): void };
      /** Whose a SoDEX code is (default: SoDEX's public API, sodex.ts). */
      ownerOf?: (code: string) => Promise<string | null | undefined>;
    } = {},
  ) {
    for (const w of store.creditWallets()) if (store.stateOf(w)?.paying) this.paying.add(w);
    builder.setExtraPrograms((address, at) => this.programsFor(address, at));
    builder.setPerkBudget((address, at) => this.perkBudget(address, at));
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

  /* ----------------------------------------------------------------------- codes ----- */

  /** Whose a SoDEX code is: kept answers first, then SoDEX. null: nobody's; undefined: SoDEX did not answer. */
  async ownerOf(code: string): Promise<string | null | undefined> {
    const kept = this.store.ownerOfCode(code);
    if (kept) return kept;
    const miss = this.noOwner.get(code);
    if (miss && this.now() - miss < NO_OWNER_MS) return null;
    const owner = await (this.o.ownerOf ?? sodexOwnerOf)(code);
    if (owner) this.store.noteCode(code, owner, this.now());
    else if (owner === null) {
      if (this.noOwner.size > 5_000) this.noOwner.clear();
      this.noOwner.set(code, this.now());
    }
    return owner;
  }

  /** Whether a join under this inviter would come with the welcome now (its cap). */
  welcomeOpen(inviter: string): boolean {
    return this.store.welcomesSince(inviter, this.now() - WELCOME_CAP_DAYS * 86_400_000) < WELCOME_CAP;
  }

  /** A code as the page checks it: valid (someone's, not ValueDesk's own), and whether it brings the welcome. */
  async check(code: string): Promise<{ valid: boolean; welcome: boolean; silent: boolean }> {
    if (code === OURS_CODE) return { valid: false, welcome: false, silent: false };
    const owner = await this.ownerOf(code);
    if (owner === undefined) return { valid: false, welcome: false, silent: true };
    return owner ? { valid: true, welcome: this.welcomeOpen(owner), silent: false } : { valid: false, welcome: false, silent: false };
  }

  /* -------------------------------------------------------------- ledger readings ----- */

  private cfgStore() {
    const cfg = this.builder.tiers.current();
    const st = this.builder.store;
    return cfg && st ? { id: cfg.builderId, st } : null;
  }

  /** The builder ledger's lifetime counted volume of a wallet, micro-USD (0 when it has none or cannot be read). */
  private lifetimeMicro(address: string): number {
    const c = this.cfgStore();
    if (!c) return 0;
    const w = c.st.wallet(c.id, address.toLowerCase());
    return w ? w.perpsMicro + w.spotMicro : 0;
  }

  hasVolume(address: string): boolean {
    return this.lifetimeMicro(address) > 0;
  }

  /** All the wallet traded on SoDEX since the UTC day it joined, per engine, micro-USD (the day counts whole). */
  private tradedSince(address: string, at: number): { perps: number; spot: number } {
    const c = this.cfgStore();
    return c ? c.st.tradedMicro(c.id, address.toLowerCase(), dayOf(at)) : { perps: 0, spot: 0 };
  }

  /** The welcome volume used, micro-USD, or null when the wallet has no welcome. */
  private welcomeUsed(address: string): number | null {
    const j = this.store.joinOf(address);
    if (!j?.welcome) return null;
    const t = this.tradedSince(address, j.at);
    return t.perps + t.spot;
  }

  welcomeActive(address: string): boolean {
    const used = this.welcomeUsed(address);
    return used !== null && used < WELCOME_USD * MICRO;
  }

  /** What lowers this wallet's builder fee now: the welcome, or credits that pay. Each for PERK_HORIZON_MS at a time. */
  programsFor(address: string, now: number): FeeProgram[] {
    const a = address.toLowerCase();
    const mk = (label: string, fee: number): FeeProgram => ({ id: 0, address: a, products: ALL, fee, from: 0, until: now + PERK_HORIZON_MS, label, addedAt: 0, addedBy: 'invites' });
    if (this.welcomeActive(a)) return [mk('Invite welcome', WELCOME_FEE)];
    if (this.paying.has(a)) return [mk('Fee credits', CREDIT_FEE)];
    return [];
  }

  /** The executor's budget for the lowered fee (null: none applies). */
  perkBudget(address: string, now = this.now()): PerkBudget | null {
    const a = address.toLowerCase();
    const c = this.cfgStore();
    if (!c) return null;
    const used = this.welcomeUsed(a);
    if (used !== null && used < WELCOME_USD * MICRO) {
      return { kind: 'welcome', capUsd: (WELCOME_USD * MICRO - used) / MICRO, perUsd: { copy: 1, bots: 1 }, through: c.st.readThrough(c.id, a) };
    }
    if (!this.paying.has(a)) return null;
    const balance = this.store.totals(a).balance;
    const per = (p: 'copy' | 'bots') => { const std = this.builder.standardFee(a, p, now); return std === null ? 0 : Math.max(0, std - CREDIT_FEE) / 100_000; };
    // The balance holds what the ledger counted by the last tick; orders still waiting for the explorer are not in it.
    const open = c.st.oldestOpen(c.id, a);
    const through = Math.min(c.st.readThrough(c.id, a), this.tickedAt || now, open === null ? Infinity : open - 1);
    return { kind: 'credits', capUsd: Math.max(0, balance / MICRO), perUsd: { copy: per('copy'), bots: per('bots') }, through };
  }

  /** What CREDIT_COVER_MIN of the wallet's own recent trading would cost its credits, micro-USD. */
  private coverMicro(address: string, now: number): number {
    const c = this.cfgStore();
    if (!c) return 0;
    let value = 0;
    for (const o of c.st.countedOrders(c.id, address, now - HOUR)) {
      const std = this.builder.standardFee(address, productOf(o.engine, o.cl), now);
      if (std !== null) value += feeMicro(o.countedMicro, Math.max(0, std - CREDIT_FEE));
    }
    return (value / 60) * CREDIT_COVER_MIN;
  }

  /* ------------------------------------------------------------------------ tick ----- */

  /** One pass: earn, spend, switch. */
  tick(): void {
    const c = this.cfgStore();
    if (!c) return;
    const now = this.now();
    // Earn: each referral's paid fees, a share to each inviter above it.
    for (const j of this.store.allJoins()) {
      const chain = this.store.chainOf(j.wallet);
      if (!chain.length) continue;
      const key = `e:${j.wallet}`;
      for (const o of c.st.countedOrders(c.id, j.wallet, j.at)) {
        if (o.t < j.at) continue;
        const seen = this.store.seenOf(key, o.key);
        const delta = o.countedMicro - seen;
        if (delta <= 0) continue;
        const fee = feeMicro(delta, o.rate);
        this.store.take(key, o.key, o.countedMicro, chain.map((address, i) => ({ address, kind: 'earn' as const, micro: fee * TIER_SHARES[i]!, source: j.wallet, tier: i + 1 })), now);
      }
    }
    // Spend: what credits paid, valued at the fee the wallet would have paid.
    for (const w of this.store.creditWallets()) {
      const key = `s:${w}`;
      // Only orders since credits first paid; during the welcome nothing is spent (it is ValueDesk's).
      const since = this.store.firstPaying(w);
      if (since !== null) {
        for (const o of c.st.countedOrders(c.id, w, since)) {
          if (o.t < since) continue;
          const seen = this.store.seenOf(key, o.key);
          const delta = o.countedMicro - seen;
          if (delta <= 0) continue;
          const std = this.builder.standardFee(w, productOf(o.engine, o.cl), now);
          const spend = std === null || this.welcomeActive(w) ? 0 : feeMicro(delta, Math.max(0, std - o.rate));
          this.store.take(key, o.key, o.countedMicro, [{ address: w, kind: 'spend', micro: spend, source: null, tier: null }], now);
        }
      }
      this.switch(w, now);
    }
    this.store.pruneSeen(now - SEEN_KEEP_MS);
    this.tickedAt = now;
  }

  private switch(w: string, now: number): void {
    const was = this.paying.has(w);
    const balance = this.store.totals(w).balance;
    const next = payingNext(balance, was, was ? 0 : this.coverMicro(w, now));
    if (next) this.paying.add(w); else this.paying.delete(w);
    this.store.setState(w, next, now);
  }

  /* -------------------------------------------------------------------------- me ----- */

  /** A wallet's referrals and credits, for the Referrals page. Referrals shortened: the page never names them whole. */
  me(address: string): InviteMe {
    const a = address.toLowerCase();
    const t = this.store.totals(a);
    const join = this.store.joinOf(a);
    const life = this.lifetimeMicro(a);
    const earned = this.store.earnedBySource(a);
    const referrals: InviteReferral[] = [];
    const referred: [number, number, number] = [0, 0, 0];
    let perps = 0;
    let spot = 0;
    // Tier by tier: the wallets that joined this one, then those that joined them, then the next.
    let level: string[] = [a];
    for (let tier = 1; tier <= TIERS && level.length; tier++) {
      const next: string[] = [];
      for (const up of level) {
        for (const j of this.store.referralsOf(up)) {
          if (j.wallet === a || referrals.length >= 2_000) continue;
          const v = this.tradedSince(j.wallet, j.at);
          referred[tier - 1] = (referred[tier - 1] ?? 0) + 1;
          perps += v.perps;
          spot += v.spot;
          referrals.push({
            wallet: short(j.wallet), tier: tier as 1 | 2 | 3, rate: TIER_SHARES[tier - 1]!, at: j.at,
            perpsUsd: v.perps / MICRO, spotUsd: v.spot / MICRO, earnedUsd: (earned.get(j.wallet) ?? 0) / MICRO, welcome: j.welcome,
          });
          next.push(j.wallet);
        }
      }
      level = next;
    }
    const used = join?.welcome ? this.welcomeUsed(a) ?? 0 : null;
    return {
      ok: true,
      joined: join ? { inviter: short(join.inviter), code: join.code, at: join.at } : null,
      canJoin: !join && life === 0 && !this.store.hasReferrals(a),
      welcome: used === null ? null : { active: used < WELCOME_USD * MICRO, usedUsd: Math.min(WELCOME_USD, used / MICRO), leftUsd: Math.max(0, WELCOME_USD - used / MICRO), limitUsd: WELCOME_USD },
      credits: { balanceUsd: t.balance / MICRO, earnedUsd: t.earned / MICRO, spentUsd: t.spent / MICRO, paying: this.paying.has(a), rates: TIER_SHARES },
      stats: { referred, perpsUsd: perps / MICRO, spotUsd: spot / MICRO, earnedUsd: t.earned / MICRO },
      referrals,
      history: this.store.history(a).map((e) => ({ at: e.at, kind: e.kind, usd: e.micro / MICRO, tier: e.tier, from: e.source ? short(e.source) : null })),
    };
  }
}
