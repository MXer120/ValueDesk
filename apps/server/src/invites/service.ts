/**
 * Fee credits and the welcome, kept against the builder ledger (claim.ts has the rules).
 *
 * Every TICK_MS (main API only: the beta API reads the same file):
 *   earn   each referral's counted orders (builder ledger) since its join: the builder fee it paid (counted volume x
 *          the fee its order named) x the earner's share of that tier (sharesFor: more while it is VIP), onto each of up to three inviters above it;
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
import { VIP_PROGRAM_FEE } from '../builder/programs.js';
import { dayOf } from '../builder/counting.js';
import { MICRO } from '../builder/tiers.js';
import {
  CREDIT_COVER_MIN, CREDIT_FEE, REFERRED_START_USD, CREDIT_MIN_USD, OURS_CODE, PERK_HORIZON_MS, TIERS, VIP_CODE_DAYS, VIP_CODE_LABEL,
  WELCOME_FEE, WELCOME_USD, CLAIM_MIN_USD, INVITES_PER_WEEK, claimWindow, inviteWeekStart, sharesFor, weekOf, type ClaimRefusal, type CreditClaim, type InviteClaims, type InviteMe, type InviteReferral,
} from './claim.js';
import { sodexCodeOf, sodexInviterOf, sodexOwnerOf } from './sodex.js';
import type { InviteStore } from './store.js';

export const TICK_MS = 60_000;
/** Seen-order rows outlive the builder ledger's orders (kept 30 days by their last fill) by this much. */
const SEEN_KEEP_MS = 60 * 86_400_000;
const HOUR = 3_600_000;
const ALL: FeeProduct[] = ['perps', 'spot', 'copy', 'bots'];
/** A code SoDEX said nobody owns is asked about again after this long. */
const NO_OWNER_MS = 10 * 60_000;
/** Volume blocks a join only once it is this old: a join that could not reach the server in time still counts. */
export const VOLUME_GRACE_MS = 24 * 3_600_000;
/** The SoDEX check (autoTick): not before the page's own ways had this long, and for this long after a wallet's first visit. */
export const AUTO_GRACE_MS = 10 * 60_000;
const AUTO_FOR_MS = 30 * 86_400_000;
const AUTO_PER_TICK = 8;

/** Wallets as ValueDesk first saw them: the builder ledger's and the usernames'. */
export interface People {
  since(t: number): Array<{ wallet: string; at: number }>;
  firstSeen(wallet: string): number | null;
}

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
      /** A wallet's own SoDEX code (default: sodex.ts). */
      codeOf?: (wallet: string) => Promise<string | null | undefined>;
      /** Who uses ValueDesk since when (default: nobody - no SoDEX check). */
      people?: People;
      /** Whom SoDEX names as a wallet's inviter (default: sodex.ts). */
      inviterOf?: (wallet: string) => Promise<string | null | undefined>;
      /** Whether a wallet is VIP now (default: as the app shows it - builder vipNow or a VIP program). */
      isVip?: (address: string) => boolean;
    } = {},
  ) {
    for (const w of store.creditWallets()) if (store.stateOf(w)?.paying) this.paying.add(w);
    builder.setExtraPrograms((address, at) => this.programsFor(address, at));
    builder.setGiftPrograms?.((address, at) => this.giftsFor(address, at));
    builder.setPerkBudget((address, at) => this.perkBudget(address, at));
    // A wallet that joined through a referral starts at the fee tier of REFERRED_START_USD (owner 2026-11-15).
    builder.setVolumeFloor?.((address) => (this.store.joinOf(address) ? REFERRED_START_USD : 0));
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Keep the ledger (main API). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { this.o.log?.warn({ err: String(e) }, 'invites: the credit tick failed'); }
      void this.autoTick().catch((e) => this.o.log?.warn({ err: String(e) }, 'invites: the SoDEX check failed'));
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ------------------------------------------------------------------- VIP codes ----- */

  isVip(address: string): boolean {
    const a = address.toLowerCase();
    try {
      return this.o.isVip ? this.o.isVip(a) : this.builder.vipNow(a) || this.builder.vipProgramOf(a) !== null;
    } catch {
      return false;
    }
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

  /** Whom SoDEX names as this wallet's inviter. null: nobody; undefined: SoDEX did not answer. */
  inviterOf(wallet: string): Promise<string | null | undefined> {
    return (this.o.inviterOf ?? sodexInviterOf)(wallet.toLowerCase());
  }

  /**
   * A referral that was lost (until 2026-11-25 the link dropped its code), put back on SoDEX's word: SoDEX names `inviter`
   * as the wallet's inviter, so it signed that code there. Refused: anyone SoDEX does not name, a code that is not the
   * inviter's, a wallet that joined, has referrals, or stands above its inviter on SoDEX (the inviter's own other wallet).
   * `at`: since when its fees count for the inviter (its first visit); the VIP days run from now.
   */
  async restore(wallet: string, inviter: string, code: string, at: number, dry = false): Promise<{ ok: true; welcome: boolean; vipUntil: number | null } | { ok: false; why: string }> {
    const a = wallet.toLowerCase();
    const by = inviter.toLowerCase();
    const c = code.toUpperCase();
    const owner = await this.ownerOf(c);
    if (owner !== by) return { ok: false, why: `the code ${c} is ${owner === undefined ? 'not answered for by SoDEX' : owner === null ? "nobody's" : "someone else's"}` };
    const named = await this.inviterOf(a);
    if (named !== by) return { ok: false, why: named === undefined ? 'SoDEX did not answer' : named === null ? 'SoDEX names no inviter' : `SoDEX names another inviter: ${short(named)}` };
    for (let up: string | null | undefined = by, i = 0; i < 12; i++) {
      up = await this.inviterOf(up);
      if (up === undefined) return { ok: false, why: 'SoDEX did not answer' };
      if (up === null || up === by) break;
      if (up === a) return { ok: false, why: 'a loop: the inviter stands below this wallet on SoDEX' };
    }
    if (this.store.joinOf(a)) return { ok: false, why: 'joined already' };
    if (this.store.hasReferrals(a)) return { ok: false, why: 'has referrals of its own' };
    const now = this.now();
    const welcome = true;
    const days = this.vipDaysOf(c, by);
    const vipUntil = days ? now + days * 86_400_000 : null;
    if (dry) return { ok: true, welcome, vipUntil };
    const r = this.store.join({ wallet: a, code: c, statement: '', nonce: 'sodex', issuedAt: String(now), expiresAt: String(now), chainId: 0, signature: 'sodex' }, by, { hasVolume: false, welcome, vipUntil, via: 'sodex' }, Math.min(at, now));
    return r.ok ? { ok: true, welcome, vipUntil } : { ok: false, why: r.code };
  }

  /**
   * The SoDEX check: a wallet first seen since it began, not joined, whom SoDEX names an inviter for, becomes that
   * inviter's referral - whatever its browser lost on the way. Only an inviter that used ValueDesk before the wallet came,
   * or has referrals already: SoDEX's inviters of wallets that found ValueDesk on their own are not ValueDesk's.
   */
  private readonly autoNext = new Map<string, number>();
  private autoOn = false;
  async autoTick(): Promise<number> {
    const people = this.o.people;
    if (!people || this.autoOn) return 0;
    this.autoOn = true;
    let joined = 0;
    try {
      const now = this.now();
      const from = Math.max(this.store.autoFrom(), now - AUTO_FOR_MS);
      const due = people.since(from).filter((p) => now - p.at >= AUTO_GRACE_MS && (this.autoNext.get(p.wallet) ?? 0) <= now && !this.store.joinOf(p.wallet));
      for (const { wallet, at } of due.slice(0, AUTO_PER_TICK)) {
        // Often while it is new (it may bind on SoDEX any minute), hourly for two days, then daily.
        const age = now - at;
        const again = now + (age < HOUR ? 3 * 60_000 : age < 48 * HOUR ? HOUR : 24 * HOUR);
        this.autoNext.set(wallet, again);
        const inviter = await this.inviterOf(wallet);
        if (!inviter) { if (inviter === undefined) this.autoNext.set(wallet, now + 3 * 60_000); continue; }
        const first = people.firstSeen(inviter);
        if ((first === null || first >= at) && !this.store.hasReferrals(inviter)) continue;
        const code = this.store.codeOfOwner(inviter) ?? (await (this.o.codeOf ?? sodexCodeOf)(inviter));
        if (!code || code === OURS_CODE) continue;
        const r = await this.restore(wallet, inviter, code, at);
        if (r.ok) { joined++; this.store.count('sodex', now); this.o.log?.warn({ wallet, code }, "invites: joined on SoDEX's word"); }
        else this.autoNext.set(wallet, now + (/did not answer/.test(r.why) ? 3 * 60_000 : 24 * HOUR));
      }
      if (this.autoNext.size > 20_000) this.autoNext.clear();
    } finally {
      this.autoOn = false;
    }
    return joined;
  }

  /** A code as the page checks it: valid (someone's, not ValueDesk's own), and whether it brings the welcome. */
  async check(code: string): Promise<{ valid: boolean; welcome: boolean; vipDays: number; silent: boolean; full?: { until: number } }> {
    if (code === OURS_CODE) return { valid: false, welcome: false, vipDays: 0, silent: false };
    const owner = await this.ownerOf(code);
    if (owner === undefined) return { valid: false, welcome: false, vipDays: 0, silent: true };
    return owner ? { valid: true, welcome: true, vipDays: this.vipDaysOf(code, owner), silent: false, ...this.fullOf(owner) } : { valid: false, welcome: false, vipDays: 0, silent: false };
  }

  /** The code's joins of this week are taken: until when. */
  fullOf(owner: string, now = this.now()): { full?: { until: number } } {
    return this.store.joinsThisWeek(owner, now) >= INVITES_PER_WEEK ? { full: { until: inviteWeekStart(now) + 7 * 86_400_000 } } : {};
  }

  /* -------------------------------------------------------------- ledger readings ----- */

  /**
   * Days of the VIP fee a wallet joining with this code now gets: its owner is VIP (as the app shows it; not through a VIP
   * code it joined with itself), or the code was upgraded on the dev page.
   */
  vipDaysOf(code: string, owner: string): number {
    return this.store.isVipCode(code) || this.isVip(owner) ? VIP_CODE_DAYS : 0;
  }

  /** A joined wallet's VIP fee while it lasts (builder programs; never VIP standing, service.ts vipProgramOf). */
  giftsFor(address: string, now: number): FeeProgram[] {
    const a = address.toLowerCase();
    const j = this.store.joinOf(a);
    if (!j?.vipUntil || j.vipUntil <= now) return [];
    return [{ id: 0, address: a, products: ALL, fee: VIP_PROGRAM_FEE, from: j.at, until: j.vipUntil, label: VIP_CODE_LABEL, addedAt: j.at, addedBy: 'invites' }];
  }

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

  /** Volume that stands against a join: the ledger has known the wallet for VOLUME_GRACE_MS. */
  hasOldVolume(address: string): boolean {
    const c = this.cfgStore();
    const w = c?.st.wallet(c.id, address.toLowerCase());
    return !!w && w.perpsMicro + w.spotMicro > 0 && this.now() - Number(w.createdAt ?? 0) >= VOLUME_GRACE_MS;
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
    // Earn: each referral's paid fees, a share to each inviter above it, at that inviter's own standing now.
    const vip = new Map<string, boolean>();
    const share = (address: string, i: number) => {
      let v = vip.get(address);
      if (v === undefined) { v = this.isVip(address); vip.set(address, v); }
      return sharesFor(v)[i]!;
    };
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
        this.store.take(key, o.key, o.countedMicro, chain.map((address, i) => ({ address, kind: 'earn' as const, micro: fee * share(address, i), source: j.wallet, tier: i + 1 })), now);
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

  /* ------------------------------------------------------------------- the weekly claim ----- */

  claimsOf(address: string, now = this.now()): InviteClaims {
    const w = claimWindow(now);
    return {
      week: w.week, opensAt: w.opensAt, closesAt: w.closesAt,
      usd: this.store.claimableMicro(address, now) / MICRO,
      claimed: !!this.store.claimOf(address, w.week),
      pendingUsd: this.store.earnedInWeek(address, weekOf(now)) / MICRO,
      claimedUsd: this.store.totals(address).claimed / MICRO,
      minUsd: CLAIM_MIN_USD,
    };
  }

  /** A signed claim: this week's, once a week, of all that is claimable, from CLAIM_MIN_USD on. */
  claim(c: CreditClaim): { ok: true; usd: number } | { ok: false; code: ClaimRefusal } {
    const now = this.now();
    if (c.week !== claimWindow(now).week) return { ok: false, code: 'closed' };
    if (this.store.claimOf(c.wallet, c.week)) return { ok: false, code: 'claimed' };
    const micro = this.store.claimableMicro(c.wallet, now);
    if (micro <= 0) return { ok: false, code: 'nothing' };
    if (micro < CLAIM_MIN_USD * MICRO) return { ok: false, code: 'small' };
    if (!this.store.claim(c, micro, now)) return { ok: false, code: 'claimed' };
    // The balance grew: credits may switch on before the next tick.
    this.switch(c.wallet.toLowerCase(), now);
    return { ok: true, usd: micro / MICRO };
  }

  /* -------------------------------------------------------------------------- me ----- */

  /** A wallet's referrals and credits, for the Referrals page. Referrals shortened: the page never names them whole. */
  me(address: string): InviteMe {
    const a = address.toLowerCase();
    const t = this.store.totals(a);
    const join = this.store.joinOf(a);
    const traded = this.hasOldVolume(a);
    const earned = this.store.earnedBySource(a);
    const vip = this.isVip(a);
    const rates = sharesFor(vip);
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
          if (j.wallet === a) continue;
          const v = this.tradedSince(j.wallet, j.at);
          referred[tier - 1] = (referred[tier - 1] ?? 0) + 1;
          perps += v.perps;
          spot += v.spot;
          next.push(j.wallet);
          // Every referral counts; the list names the first 2,000.
          if (referrals.length < 2_000) referrals.push({
            wallet: short(j.wallet), tier: tier as 1 | 2 | 3, rate: rates[tier - 1]!, at: j.at,
            perpsUsd: v.perps / MICRO, spotUsd: v.spot / MICRO, earnedUsd: (earned.get(j.wallet) ?? 0) / MICRO, welcome: j.welcome,
          });
        }
      }
      level = next;
    }
    const used = join?.welcome ? this.welcomeUsed(a) ?? 0 : null;
    return {
      ok: true,
      joined: join ? { inviter: short(join.inviter), code: join.code, at: join.at } : null,
      canJoin: !join && !traded && !this.store.hasReferrals(a),
      blocked: join ? 'joined' : this.store.hasReferrals(a) ? 'has-referrals' : traded ? 'has-volume' : null,
      welcome: used === null ? null : { active: used < WELCOME_USD * MICRO, usedUsd: Math.min(WELCOME_USD, used / MICRO), leftUsd: Math.max(0, WELCOME_USD - used / MICRO), limitUsd: WELCOME_USD },
      vipUntil: join?.vipUntil && join.vipUntil > this.now() ? join.vipUntil : null,
      vip,
      vipCode: vip || this.store.ownsVipCode(a),
      credits: { balanceUsd: t.balance / MICRO, earnedUsd: t.earned / MICRO, grantedUsd: t.granted / MICRO, spentUsd: t.spent / MICRO, paying: this.paying.has(a), rates },
      stats: { referred, perpsUsd: perps / MICRO, spotUsd: spot / MICRO, earnedUsd: t.earned / MICRO },
      referrals,
      claims: this.claimsOf(a),
      invites: { week: this.store.joinsThisWeek(a, this.now()), max: INVITES_PER_WEEK, resetsAt: inviteWeekStart(this.now()) + 7 * 86_400_000 },
      days: this.store.days(a),
      // The removed VIP credit: shown only for what it paid.
      history: this.store.history(a).filter((e) => e.kind !== 'grant' || t.granted > 0).map((e) => (e.kind === 'grant' ? { ...e, micro: t.granted } : e)).map((e) => ({ at: e.at, kind: e.kind, usd: e.micro / MICRO, tier: e.tier, from: e.source ? short(e.source) : null })),
    };
  }
}
