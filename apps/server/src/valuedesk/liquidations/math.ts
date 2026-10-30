/**
 * Liquidation prices, as each venue works them out.
 *
 * Every venue here liquidates a cross account when its value falls to its
 * maintenance margin, and an isolated position when ITS margin does:
 *
 *   value(p)  = cash + Σ s_j · p_j                 (cash: what is left with every position at 0)
 *   margin(p) = Σ mm_j(|s_j| · p_j)                (mm: the market's tiered maintenance margin)
 *
 * A position's liquidation price is the p_i where the two meet with every other
 * position at its price now. That is Hyperliquid's published rule (its docs'
 * `liq_price = price - side * margin_available / size / (1 - l * side)` is the
 * same line), and SoDEX's, Lighter's and Arcus's figures follow it too.
 * Checked live 2026-10-25 against the venues' own figures (tools/liq-check.ts):
 * Hyperliquid 2,107 of 2,601 positions to 1e-6 at the account value it reports,
 * every miss a unified / portfolio-margin account whose margin sits in spot -
 * and those match too once the cash is taken from the venue's own figure, as
 * calibrate() does.
 *
 * So a book keeps one number per account, `cash`, taken at each read from the
 * venue's liquidation price itself (never from a margin summary that may leave
 * the spot collateral out), plus `iso` per isolated position. From then on the
 * prints move it (applyFill: a trade of d at px takes d·px from the cash), and
 * the prices now move every position's liquidation price as the venue's would.
 * Funding it applies every hour (fundingCash, from the venue's published rates); what
 * it cannot see - fees, a deposit or withdrawal - waits for the next read;
 * the tracker measures that drift at every re-read (driftOf).
 */

/** One maintenance tier: from notional `lb` up, rate `r`, less `ded` (keeps the margin continuous). */
export interface Tier {
  lb: number;
  r: number;
  ded: number;
}
/**
 * A market's tiers. `now`: the venue publishes liquidation prices at the rate of the
 * tier the position is in now (SoDEX); without it, at the tier it reaches at that
 * price (Hyperliquid: an account of shorts on tiered markets, 2026-10-25, implies
 * rates between two tiers - the deduction of the upper one at the solution).
 */
export type Tiers = readonly Tier[] & { readonly now?: boolean };

/**
 * Tiers from lower bounds and rates. A missing deduction is the one that keeps
 * the margin continuous at each bound (Hyperliquid's rule; SoDEX publishes its own).
 */
export function tiersOf(rows: ReadonlyArray<{ lb: number; r: number; ded?: number | null }>, o: { now?: boolean } = {}): Tiers {
  const sorted = rows.filter((t) => Number.isFinite(t.lb) && t.r > 0 && t.r < 1).slice().sort((a, b) => a.lb - b.lb);
  const out: Tier[] = [];
  for (const t of sorted) {
    const prev = out[out.length - 1];
    const ded = t.ded != null && Number.isFinite(t.ded) ? t.ded : prev ? prev.ded + t.lb * (t.r - prev.r) : 0;
    out.push({ lb: out.length ? t.lb : 0, r: t.r, ded });
  }
  return o.now ? Object.assign(out, { now: true }) : out;
}

/** One rate for every size (Lighter, Arcus). */
export const flatTiers = (r: number): Tiers => (r > 0 && r < 1 ? [{ lb: 0, r, ded: 0 }] : []);

/** The tier a notional falls in. */
export function tierAt(t: Tiers, notional: number): Tier | undefined {
  let tier = t[0];
  for (const x of t) if (notional >= x.lb) tier = x;
  return tier;
}

/** The maintenance margin on a notional; `at`: at the rate of the tier that notional falls in (default: its own). */
export function mmOf(t: Tiers, notional: number, at = notional): number {
  const tier = tierAt(t, at);
  return tier ? notional * tier.r - tier.ded : 0;
}

/**
 * The price p > 0 where `fixed + s·p = mm(|s|·p)`: a position of signed size s
 * whose account holds `fixed` beside it. Null when there is none - a long whose
 * account can carry it to zero.
 *
 * `now`, the position's notional now: on a venue whose tiers say so (Tiers.now:
 * SoDEX, 2026-10-25 - an account of 92 small shorts whose far liquidation prices
 * would cross tier bounds; every published figure is the current tier's line) the
 * rate is that tier's. Otherwise the tier is the one at the solution.
 */
export function solveLiq(t: Tiers, s: number, fixed: number, now?: number): number | null {
  if (!s || !t.length || !Number.isFinite(fixed)) return null;
  const a = Math.abs(s);
  if (now !== undefined && t.now) {
    const { r, ded } = tierAt(t, now)!;
    const den = s - a * r;
    const p = den ? (-ded - fixed) / den : NaN;
    return p > 0 ? p : null;
  }
  for (let i = 0; i < t.length; i++) {
    const { r, ded, lb } = t[i]!;
    const den = s - a * r;
    if (!den) continue;
    const p = (-ded - fixed) / den;
    const hi = t[i + 1]?.lb ?? Infinity;
    const n = a * p;
    if (p > 0 && n >= lb && n < hi) return p;
  }
  return null;
}

/** A position as the liquidation math reads it. */
export interface LiqPos {
  symbol: string;
  szi: number;
  /** Isolated: the position's own cash (its margin less s·price); null = isolated but not known. Absent = cross. */
  iso?: number | null;
  /** Isolated: the leverage new size is margined at. */
  lev?: number | null;
  /** The venue's own figure, kept as read where the model does not reproduce it (0 = the venue says none). */
  fix?: number | null;
}

export type PriceOf = (symbol: string) => number | null;
export type TiersFor = (symbol: string) => Tiers | null;

const own = (p: LiqPos, px: number, t: Tiers) => p.szi * px - mmOf(t, Math.abs(p.szi) * px);

/**
 * Every position's liquidation price in one account (aligned with `pos`; null =
 * none, or not known). `cash` null = the account's cross cash is not known.
 * `none`, when given, is filled aligned with `pos`: true where the null is "no
 * liquidation price exists" (the venue says so, or the account carries the position
 * to zero) rather than "not known" (no cash, no price, no margin rules).
 */
export function accountLiqs(cash: number | null, pos: readonly LiqPos[], priceOf: PriceOf, tiersFor: TiersFor, none?: boolean[]): Array<number | null> {
  // The cross positions' part, once: each position takes its own share back out.
  let cross = 0;
  let crossOk = cash !== null && Number.isFinite(cash);
  const parts: Array<number | null> = pos.map((p) => {
    if (p.iso !== undefined) return null;
    const px = priceOf(p.symbol);
    const t = tiersFor(p.symbol);
    if (px === null || !(px > 0) || !t?.length) { crossOk = false; return null; }
    const v = own(p, px, t);
    cross += v;
    return v;
  });
  if (none) none.length = 0;
  return pos.map((p, i) => {
    if (none) none[i] = false;
    if (p.fix != null) {
      if (p.fix > 0) return p.fix;
      if (none) none[i] = true;
      return null;
    }
    const t = tiersFor(p.symbol);
    if (!t?.length) return null;
    const px = priceOf(p.symbol);
    const now = px !== null && px > 0 ? Math.abs(p.szi) * px : undefined;
    let out: number | null;
    if (p.iso !== undefined) {
      if (p.iso === null) return null;
      out = solveLiq(t, p.szi, p.iso, now);
    } else {
      if (!crossOk) return null;
      out = solveLiq(t, p.szi, cash! + cross - parts[i]!, now);
    }
    if (out === null && none) none[i] = true;
    return out;
  });
}

/** One position as a venue's read gives it. */
export interface ReadPos {
  symbol: string;
  szi: number;
  /** The venue's mark in the read. */
  mark: number | null;
  /** The venue's liquidation price: a number, null for "none", undefined when the venue gives none at all. */
  vliq?: number | null;
  isolated?: boolean;
  /** Isolated: the position's margin with its unrealised PnL in (its value at the mark), when the venue says. */
  isoValue?: number | null;
  lev?: number | null;
}

export interface Calibrated {
  cash: number | null;
  /** Per read position (aligned): the book's extras. */
  pos: Array<Pick<LiqPos, 'iso' | 'lev' | 'fix'>>;
  /** Positions with a venue figure, and how many the model reproduced. */
  checked: number;
  matched: number;
  /** Figures kept as read without a check (a split Lighter wallet). */
  kept: number;
}

/** How close the model must come to the venue's figure (relative). */
export const MATCH_TOL = 1e-4;
const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= MATCH_TOL * Math.abs(b));

/**
 * A read made into what a book keeps: the account's cross cash and each
 * isolated position's, taken from the venue's own liquidation prices (the
 * largest cross position's sets the cash), else from the account value the
 * venue reports (`cash0`). Each figure the venue gave is then checked against
 * the model; one it does not reproduce is kept as read (`fix`). `split` (a
 * Lighter wallet with positions in several sub-accounts, each its own margin,
 * merged into one book): every figure is kept as read and no cash is known.
 */
export function calibrate(read: { cash0: number | null; positions: readonly ReadPos[]; split?: boolean }, tiersFor: TiersFor): Calibrated {
  const ps = read.positions;
  const out: Calibrated = { cash: null, pos: ps.map(() => ({})), checked: 0, matched: 0, kept: 0 };
  if (read.split) {
    ps.forEach((p, i) => {
      if (p.vliq === undefined) return;
      out.pos[i] = { fix: p.vliq ?? 0 };
      out.kept++;
    });
    return out;
  }
  const markOf = new Map(ps.map((p) => [p.symbol, p.mark]));
  const priceOf: PriceOf = (s) => markOf.get(s) ?? null;
  // Isolated positions: their own cash.
  ps.forEach((p, i) => {
    if (!p.isolated) return;
    const t = tiersFor(p.symbol);
    let iso: number | null = null;
    if (p.vliq && t?.length) iso = mmOf(t, Math.abs(p.szi) * p.vliq, t.now && p.mark !== null ? Math.abs(p.szi) * p.mark : undefined) - p.szi * p.vliq;
    else if (p.isoValue != null && p.mark !== null) iso = p.isoValue - p.szi * p.mark;
    out.pos[i] = { iso, lev: p.lev ?? null };
  });
  // Cross: the cash from the largest position the venue gave a figure for.
  let cross = 0;
  let ok = true;
  const parts = ps.map((p) => {
    if (p.isolated) return 0;
    const t = tiersFor(p.symbol);
    if (p.mark === null || !t?.length) { ok = false; return 0; }
    const v = own(p, p.mark, t);
    cross += v;
    return v;
  });
  let best = -1;
  ps.forEach((p, i) => {
    if (p.isolated || !p.vliq || !(p.vliq > 0) || p.mark === null) return;
    if (best < 0 || Math.abs(p.szi * p.mark) > Math.abs(ps[best]!.szi * ps[best]!.mark!)) best = i;
  });
  if (ok && best >= 0) {
    const p = ps[best]!;
    const t = tiersFor(p.symbol)!;
    const fixed = mmOf(t, Math.abs(p.szi) * p.vliq!, t.now ? Math.abs(p.szi) * p.mark! : undefined) - p.szi * p.vliq!;
    out.cash = fixed - (cross - parts[best]!);
  } else if (ok && read.cash0 !== null && Number.isFinite(read.cash0)) {
    let cash = read.cash0;
    // The venue says a long cannot be liquidated: the cash is at least what keeps it so.
    ps.forEach((p, i) => {
      if (p.isolated || p.vliq !== null || p.szi <= 0) return;
      cash = Math.max(cash, -(cross - parts[i]!));
    });
    out.cash = cash;
  }
  // Check every figure the venue gave; keep the ones the model misses as read.
  const lv = accountLiqs(out.cash, ps.map((p, i) => ({ symbol: p.symbol, szi: p.szi, ...out.pos[i] })), priceOf, tiersFor);
  ps.forEach((p, i) => {
    if (p.vliq === undefined) return;
    out.checked++;
    const want = p.vliq && p.vliq > 0 ? p.vliq : null;
    if (close(lv[i] ?? null, want)) out.matched++;
    else out.pos[i] = { ...out.pos[i], fix: want ?? 0 };
  });
  return out;
}

/** A book as the fills move it (cohortTracker.ts Book): the cross cash and each position's size and extras. */
export interface FillBook {
  cash?: number | null;
  pos: Map<string, { szi: number; entry: number | null; iso?: number | null; lev?: number | null; fix?: number | null }>;
}

/**
 * What a trade of d at px does to the liquidation side of a book (before the
 * size itself moves; cohortTracker.ts applyFill does that). Cross: the cash
 * pays d·px. Isolated, Hyperliquid's rule: added size brings margin |d|·px/lev
 * over from the cross cash; a reduction hands back its share of the position's
 * value. A venue figure kept as read no longer stands once the size moves.
 */
export function fillCash(book: FillBook, symbol: string, d: number, px: number): void {
  const cur = book.pos.get(symbol);
  const s = cur?.szi ?? 0;
  if (cur && cur.fix !== undefined) delete cur.fix;
  const has = book.cash !== undefined && book.cash !== null;
  if (!cur || cur.iso === undefined) {
    if (has) book.cash! -= d * px;
    return;
  }
  const lev = cur.lev && cur.lev > 0 ? cur.lev : null;
  const n = s + d;
  if (s === 0 || Math.sign(s) === Math.sign(d)) {
    const m = lev ? (Math.abs(d) * px) / lev : 0;
    if (cur.iso !== null) cur.iso = cur.iso - d * px + m;
    if (has) book.cash! -= m;
    return;
  }
  // A reduction, a close or a flip.
  const value = cur.iso === null ? null : cur.iso + s * px;
  const f = Math.min(1, Math.abs(d) / Math.abs(s));
  if (has && value !== null) book.cash! += f * value;
  if (cur.iso !== null) cur.iso *= 1 - f;
  if (Math.abs(n) > 0 && Math.sign(n) !== Math.sign(s)) {
    // Flipped: the rest opens isolated afresh.
    const m = lev ? (Math.abs(n) * px) / lev : 0;
    cur.iso = cur.iso === null && !lev ? null : m - n * px;
    if (has) book.cash! -= m;
  }
}

/**
 * A trade's fee (USD) on a book, before the size moves (fillCash, applyFill): an isolated
 * position pays it from its own margin, a cross one from the cash; the account value moves
 * by the same. A fill paid fees nowhere until 2026-10-28: a Hyperliquid round trip at the
 * base taker rate is 0.09% of the notional, a liquidation price's whole 0.1% tolerance.
 */
export function feeCash(book: FillBook & { equity?: number | null }, symbol: string, fee: number): void {
  // Negative: a maker rebate, paid in.
  if (!fee || !Number.isFinite(fee)) return;
  const cur = book.pos.get(symbol);
  if (cur && cur.iso !== undefined) { if (cur.iso !== null) cur.iso -= fee; }
  else if (book.cash !== undefined && book.cash !== null) book.cash -= fee;
  if (book.equity !== undefined && book.equity !== null) book.equity -= fee;
}

/**
 * One hour's funding on a book. Hyperliquid settles every hour: a position of size s pays
 * s · oracle price · rate (longs pay a positive rate). Cross positions pay from the cash,
 * an isolated one from its own margin; the account value moves by the same amount. A
 * market without a rate pays nothing. Returns what the book paid in all (negative: received).
 */
export function fundingCash(book: FillBook & { equity?: number | null }, rateOf: (symbol: string) => { rate: number; px: number } | null): number {
  let paid = 0;
  for (const [symbol, p] of book.pos) {
    const f = rateOf(symbol);
    if (!f || !Number.isFinite(f.rate) || !(f.px > 0)) continue;
    const pay = p.szi * f.px * f.rate;
    if (!Number.isFinite(pay) || pay === 0) continue;
    paid += pay;
    if (p.iso !== undefined) { if (p.iso !== null) p.iso -= pay; }
    else if (book.cash !== undefined && book.cash !== null) book.cash -= pay;
  }
  if (paid && book.equity !== undefined && book.equity !== null) book.equity -= paid;
  return paid;
}

// --- drift and accuracy ----------------------------------------------------------------

/** How far the book's figures were from the venue's at re-reads, per venue (cohortTracker.ts). */
export interface DriftStats {
  /** Since when (ms). */
  since: number;
  /** At each read: positions with a venue figure, and how many the model reproduced to MATCH_TOL. */
  checked: number;
  matched: number;
  /** At re-reads, positions of unchanged size: the book's figure against the venue's new one. */
  n: number;
  within01: number;
  within1: number;
  within5: number;
  /** The same weighted by notional (USD at the venue's figure): all, within 0.1% (absent before 2026-10-30), within 1%. */
  usd: number;
  usd01?: number;
  usd1: number;
  /** Positions whose size the read found changed (prints the stream missed). */
  moved: number;
}

export const emptyDrift = (since: number): DriftStats => ({ since, checked: 0, matched: 0, n: 0, within01: 0, within1: 0, within5: 0, usd: 0, usd01: 0, usd1: 0, moved: 0 });

/** Add one comparison: the book's figure `was` against the venue's `now` for a position of `usd` notional. */
export function addDrift(d: DriftStats, was: number | null, now: number | null, usd: number): void {
  if (now === null && was === null) return;
  d.n++;
  d.usd += usd;
  const err = now === null || was === null ? Infinity : Math.abs(was - now) / now;
  // usd01 only where the day began with it (a day saved before 2026-10-30 would show a part as the whole).
  if (err <= 0.001) { d.within01++; if (d.usd01 !== undefined) d.usd01 += usd; }
  if (err <= 0.01) { d.within1++; d.usd1 += usd; }
  if (err <= 0.05) d.within5++;
}

// --- buckets ----------------------------------------------------------------------------

/** A step that reads well: 1, 2, 2.5 or 5 times a power of ten, nearest `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const e = Math.floor(Math.log10(raw));
  const base = 10 ** e;
  const f = raw / base;
  const k = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.75 ? 2.5 : f < 7.5 ? 5 : 10;
  return k * base;
}

export type Resolution = 'fine' | 'medium' | 'coarse';
/** Bucket width as a share of the price, per resolution (Hyperdash's Fine is ~0.1%). */
export const RESOLUTION: Record<Resolution, number> = { fine: 0.001, medium: 0.004, coarse: 0.015 };
