/**
 * Share cards (owner 2026-11-14: "share button for bot results as cards, and general share cards"): one design, the
 * marketing PnL cards (marketing/video/src/launch/pnlcards.tsx, rendered in desk/marketing/graphics/share-cards) drawn
 * on a canvas in the browser, so nothing is uploaded. Two sizes: wide 1200 x 675 (X, Telegram, Discord) and square
 * 1080 x 1080. The same parts in the same order: the name and what this is, the subject, one big number, the other
 * unit under it, a chart, the figures in one soft panel, a foot.
 *
 * Every figure comes from the caller (shareData.ts builds them from what the page already shows): nothing here makes
 * a number up. What the user hides (dollar amounts, prices, an address) is taken out before drawing (cardView).
 */

import { drawPointsArt, qrModules, type PointsArt } from './pointsArt';

export type CardKind = 'trade' | 'position' | 'portfolio' | 'copy' | 'bot' | 'botvol' | 'points' | 'squad';
export type Ratio = 'wide' | 'square';

export const SIZES: Record<Ratio, [number, number]> = { wide: [1200, 675], square: [1080, 1080] };

/** What a fact is, for the switches: a dollar amount, a price, a statistic or anything else. */
export type FactKind = 'usd' | 'price' | 'stat' | 'plain';
export interface CardFact {
  label: string;
  value: string;
  kind: FactKind;
}

export type CardChart =
  | { type: 'pnl'; ys: number[] }
  | { type: 'copy'; me: number[]; them: number[] }
  | { type: 'volume'; vol: number[]; cost: number[] | null; costEnd: string | null };

export interface CardData {
  kind: CardKind;
  /** The pill on top: Trade, Position, Portfolio, Copy trading, Bot. */
  label: string;
  /** Beside it: a date, "Running 6d 4h", "Last 30 days". */
  when: string;
  /** A line over the title ("Copying"). */
  over?: string;
  title: string;
  /** The title is someone's address (a copied trader): the second switch hides it. */
  titleIsAddress?: boolean;
  pills: Array<{ text: string; tone?: boolean }>;
  /** Signed PnL, USD (null: none to show). */
  usd: number | null;
  /** Signed return as a fraction (0.086 = +8.6%; null: none). */
  pct: number | null;
  /** What the return is on ("on $15,000"), USD. */
  base?: number | null;
  /** A card led by something other than PnL (the volume bot): its big number, label and the line under it. */
  lead?: { label: string; big: string; usdBig?: boolean; sub: string; subRest: string; altLabel: string; altBig: string; altSub: string; altSubRest: string };
  /** What leads when dollar amounts are hidden and there is no return to show (a bot's cost in bp). */
  hidden?: { label: string; big: string; tone: 'up' | 'down' | 'neutral' };
  facts: CardFact[];
  foot: string;
  chart: CardChart | null;
  /** Where a viewer lands: the same setup, or the page it came from. */
  link: string;
  /** The words of a post (X, the share sheet), given what is shown. */
  post: (o: { amounts: boolean }) => string;
  /** The second switch: what it shows (prices, the trader's address, win rate and trades). */
  second: { title: string; line?: string; kind: 'price' | 'stat' | 'title' } | null;
  /** The wallet's address, shown only when the user turns it on. */
  wallet: string | null;
  /** A card drawn as the page's own (SoPoints: SoDEX's tier card, the week's estimate; pointsArt.ts) instead of the PnL layout. */
  art?: PointsArt;
}

export interface CardOpts {
  ratio: Ratio;
  /** Dollar amounts shown (off: returns in % only). */
  amounts: boolean;
  /** The second switch (prices, the trader's address, win rate and trades). */
  second: boolean;
  /** The user's wallet address on the card. */
  wallet: boolean;
  /** ValueDesk's SoDEX code on the card (only for a wallet that may take it: referralRules.mayAttachCode). */
  code: string | null;
}

/* ------------------------------------------------------------- formatting ----- */

const MINUS = '−';
const nf = (x: number, d: number) => Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** "+$12,480.20", "−$842.10"; whole dollars from $1,000. */
export function usdSigned(x: number): string {
  const d = Math.abs(x) >= 1_000 ? 0 : 2;
  return `${x < 0 ? MINUS : '+'}$${nf(x, d)}`;
}
/** "$2.14M", "$640K", "$62,923". */
export function usdShort(x: number): string {
  const a = Math.abs(x);
  const s = x < 0 ? MINUS : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 100_000) return `${s}$${Math.round(a / 1e3)}K`;
  return `${s}$${nf(a, a >= 1_000 ? 0 : 2)}`;
}
/** "+184.6%", "−1.4%", "+0.06%". */
export function pctSigned(f: number): string {
  const p = f * 100;
  const d = Math.abs(p) >= 1_000 ? 0 : Math.abs(p) >= 1 ? 1 : 2;
  return `${p < 0 ? MINUS : '+'}${nf(p, d)}%`;
}
export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** "2d 6h", "3h 12m", "14m". */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
export const dayWords = (t: number): string => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/* ------------------------------------------------------------- what shows ----- */

export interface CardView {
  big: string;
  bigTone: 'up' | 'down' | 'neutral';
  bigLabel: string | null;
  sub: string | null;
  subRest: string | null;
  subTone: 'up' | 'down' | 'neutral' | 'blue';
  title: string;
  facts: CardFact[];
  footLeft: string;
  footRight: string;
}

/** The card as the switches leave it: what is hidden is gone, never drawn and blurred. */
export function cardView(d: CardData, o: Pick<CardOpts, 'amounts' | 'second' | 'wallet' | 'code'>): CardView {
  const tone = (x: number | null): 'up' | 'down' | 'neutral' => (x === null ? 'neutral' : x < 0 ? 'down' : 'up');
  const facts = d.facts.filter((f) => (o.amounts || f.kind !== 'usd') && (o.second || !d.second || d.second.kind === 'title' || f.kind !== d.second.kind));
  const title = d.titleIsAddress && d.second?.kind === 'title' && !o.second ? 'A trader' : d.title;
  const footRight = o.code ? `valuedesk.so · code ${o.code}` : 'valuedesk.so';
  const footLeft = o.wallet && d.wallet ? `${d.foot} · ${shortAddress(d.wallet)}` : d.foot;
  if (d.lead) {
    const l = d.lead;
    const useAlt = !o.amounts && l.usdBig;
    return {
      big: useAlt ? l.altBig : l.big, bigTone: 'neutral', bigLabel: useAlt ? l.altLabel : l.label,
      sub: useAlt ? (o.amounts ? l.altSub : null) : l.sub, subRest: useAlt ? (o.amounts ? l.altSubRest : null) : l.subRest,
      subTone: useAlt ? 'up' : 'blue', title, facts, footLeft, footRight,
    };
  }
  const bigTone = tone(d.usd ?? d.pct);
  if (!o.amounts && d.pct === null && d.hidden) {
    return { big: d.hidden.big, bigTone: d.hidden.tone, bigLabel: d.hidden.label, sub: null, subRest: null, subTone: d.hidden.tone, title, facts, footLeft, footRight };
  }
  if (o.amounts && d.usd === null && d.pct === null && d.hidden) {
    return { big: d.hidden.big, bigTone: d.hidden.tone, bigLabel: d.hidden.label, sub: null, subRest: null, subTone: d.hidden.tone, title, facts, footLeft, footRight };
  }
  // Dollar amounts on: the dollars lead when there is no return to show; the return leads otherwise (the mock).
  if (!o.amounts || d.usd === null) {
    return { big: d.pct !== null ? pctSigned(d.pct) : '', bigTone, bigLabel: null, sub: o.amounts && d.usd !== null ? usdSigned(d.usd) : null, subRest: o.amounts && d.usd !== null ? 'PnL' : null, subTone: bigTone, title, facts, footLeft, footRight };
  }
  if (d.pct === null) return { big: usdSigned(d.usd), bigTone, bigLabel: null, sub: null, subRest: null, subTone: bigTone, title, facts, footLeft, footRight };
  return { big: pctSigned(d.pct), bigTone, bigLabel: null, sub: usdSigned(d.usd), subRest: d.base ? `PnL on ${usdShort(d.base)}` : 'PnL', subTone: bigTone, title, facts, footLeft, footRight };
}

/* ---------------------------------------------------------------- drawing ----- */

const INK = '#0b0b0b';
const WHITE = '#f4f4f4';
const MUTED = '#a8a8a8';
const DIM = '#7b7b7b';
const SIGNAL = '#00b481';
const RED = '#f0616d';
const BLUE = '#7fb0ff';
const DISPLAY = '"Space Grotesk", sans-serif';
const TEXT = '"IBM Plex Sans", sans-serif';
const NUM = '"Asap", "IBM Plex Sans", sans-serif';

const toneColor = (t: CardView['bigTone'] | CardView['subTone']): string => (t === 'up' ? SIGNAL : t === 'down' ? RED : t === 'blue' ? BLUE : WHITE);

type Ctx = CanvasRenderingContext2D;

function spacing(c: Ctx, px: number): void {
  (c as unknown as { letterSpacing?: string }).letterSpacing = `${px}px`;
}

function mark(c: Ctx, x: number, y: number, size: number): void {
  const COLS = [0, 4, 1, 3, 2];
  const ROWS = [0, 0, 1, 1, 2];
  const u = size / 32;
  COLS.forEach((col, i) => {
    c.fillStyle = ROWS[i] === 2 ? SIGNAL : WHITE;
    c.beginPath();
    c.roundRect(x + col * 6.6 * u, y + (4.2 + ROWS[i]! * 8.2) * u, 5.6 * u, 7.2 * u, 1.5 * u);
    c.fill();
  });
}

/** The lockup: the mark, a hairline, the name. Returns its width. */
export function lockup(c: Ctx, x: number, cy: number, h: number): number {
  mark(c, x, cy - h / 2, h);
  c.fillStyle = 'rgba(244,244,244,0.28)';
  c.fillRect(x + h + h * 0.34, cy - h * 0.45, 2, h * 0.9);
  c.font = `600 ${h * 0.86}px ${DISPLAY}`;
  spacing(c, -h * 0.86 * 0.025);
  c.fillStyle = WHITE;
  c.textBaseline = 'middle';
  const tx = x + h + h * 0.68 + 2;
  c.fillText('ValueDesk', tx, cy + h * 0.04);
  const w = tx + c.measureText('ValueDesk').width - x;
  spacing(c, 0);
  c.textBaseline = 'alphabetic';
  return w;
}

/** A pill; returns its width. `right`: x is its right edge. */
function pill(c: Ctx, text: string, x: number, cy: number, s: number, color: string | null, right = false): number {
  c.font = `500 ${19 * s}px ${TEXT}`;
  const w = c.measureText(text).width + 30 * s;
  const h = 19 * s * 1.1 + 14 * s;
  const left = right ? x - w : x;
  c.fillStyle = color ? `${color}29` : 'rgba(255,255,255,0.11)';
  c.beginPath();
  c.roundRect(left, cy - h / 2, w, h, h / 2);
  c.fill();
  c.fillStyle = color ?? WHITE;
  c.textBaseline = 'middle';
  c.fillText(text, left + 15 * s, cy + 1);
  c.textBaseline = 'alphabetic';
  return w;
}

const pts = (ys: number[], x: number, y: number, w: number, h: number, lo: number, hi: number): Array<[number, number]> =>
  ys.map((v, i) => [x + (ys.length > 1 ? (i / (ys.length - 1)) * w : w), y + h - ((v - lo) / (hi - lo || 1)) * h]);

function smooth(c: Ctx, p: Array<[number, number]>, start = true): void {
  if (!p.length) return;
  if (start) c.moveTo(p[0]![0], p[0]![1]);
  for (let i = 1; i < p.length; i++) {
    const [x0, y0] = p[i - 1]!;
    const [x1, y1] = p[i]!;
    const mx = (x0 + x1) / 2;
    c.bezierCurveTo(mx, y0, mx, y1, x1, y1);
  }
}

function endDot(c: Ctx, x: number, y: number, s: number, color: string): void {
  c.globalAlpha = 0.2;
  c.fillStyle = color;
  c.beginPath(); c.arc(x, y, 15 * s, 0, Math.PI * 2); c.fill();
  c.globalAlpha = 1;
  c.beginPath(); c.arc(x, y, 7 * s, 0, Math.PI * 2); c.fill();
}

/** PnL from the window's start: green above zero, red below, the zero line dashed. */
function pnlChart(c: Ctx, ys: number[], x: number, y: number, w: number, h: number, s: number): void {
  if (ys.length < 2) return;
  const lo = Math.min(0, ...ys);
  const hi = Math.max(0, ...ys);
  const p = pts(ys, x, y, w, h, lo, hi);
  const z = y + h - ((0 - lo) / (hi - lo || 1)) * h;
  const area = () => { c.beginPath(); smooth(c, p); c.lineTo(x + w, z); c.lineTo(x, z); c.closePath(); };
  for (const [top, color] of [[true, SIGNAL], [false, RED]] as const) {
    c.save();
    c.beginPath();
    if (top) c.rect(x - 20, y - 40, w + 40, z - y + 40); else c.rect(x - 20, z, w + 40, y + h - z + 40);
    c.clip();
    const g = top ? c.createLinearGradient(0, y, 0, z) : c.createLinearGradient(0, y + h, 0, z);
    g.addColorStop(0, `${color}52`); g.addColorStop(1, `${color}05`);
    area(); c.fillStyle = g; c.fill();
    c.beginPath(); smooth(c, p);
    c.strokeStyle = color; c.lineWidth = 3.5 * s; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke();
    c.restore();
  }
  c.save();
  c.setLineDash([4 * s, 7 * s]);
  c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 1.5 * s;
  c.beginPath(); c.moveTo(x, z); c.lineTo(x + w, z); c.stroke();
  c.restore();
  const e = p[p.length - 1]!;
  endDot(c, e[0], e[1], s, ys[ys.length - 1]! >= 0 ? SIGNAL : RED);
}

/** The trader against my copy, the gap hatched; my line takes my result's colour. */
function copyChart(c: Ctx, me: number[], them: number[], x: number, y: number, w: number, h: number, s: number, tone: string): void {
  if (me.length < 2) return;
  const all = [...me, ...them];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const mp = pts(me, x, y, w, h, lo, hi);
  const tp = them.length > 1 ? pts(them, x, y, w, h, lo, hi) : [];
  if (tp.length) {
    // The gap, hatched.
    const hatch = document.createElement('canvas');
    hatch.width = hatch.height = Math.round(9 * s);
    const hc = hatch.getContext('2d')!;
    hc.strokeStyle = 'rgba(255,255,255,0.2)'; hc.lineWidth = 2 * s;
    hc.beginPath(); hc.moveTo(0, hatch.height); hc.lineTo(hatch.width, 0); hc.stroke();
    c.save();
    c.beginPath(); smooth(c, tp);
    for (const [px, py] of [...mp].reverse()) c.lineTo(px, py);
    c.closePath();
    c.fillStyle = c.createPattern(hatch, 'repeat') ?? 'rgba(255,255,255,0.08)';
    c.fill();
    c.restore();
    c.beginPath(); smooth(c, tp);
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 3 * s; c.lineCap = 'round'; c.stroke();
  }
  c.beginPath(); smooth(c, mp);
  c.strokeStyle = tone; c.lineWidth = 3.5 * s; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke();
  const e = mp[mp.length - 1]!;
  endDot(c, e[0], e[1], s, tone);
}

/** Volume built up (filled) with the cost in bp as a dashed second line on its own scale, its end labelled. */
function volumeChart(c: Ctx, vol: number[], cost: number[] | null, costEnd: string | null, x: number, y: number, w: number, h: number, s: number): void {
  if (vol.length < 2) return;
  const vp = pts(vol, x, y, w, h, Math.min(...vol), Math.max(...vol));
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, `${SIGNAL}47`); g.addColorStop(1, `${SIGNAL}00`);
  c.beginPath(); smooth(c, vp); c.lineTo(x + w, y + h); c.lineTo(x, y + h); c.closePath(); c.fillStyle = g; c.fill();
  c.beginPath(); smooth(c, vp); c.strokeStyle = SIGNAL; c.lineWidth = 3.5 * s; c.lineCap = 'round'; c.stroke();
  const ve = vp[vp.length - 1]!;
  c.fillStyle = SIGNAL; c.beginPath(); c.arc(ve[0], ve[1], 7 * s, 0, Math.PI * 2); c.fill();
  if (cost && cost.length > 1) {
    const hi = Math.max(...cost.map(Math.abs)) * 1.05 || 1;
    const lo = Math.min(0, ...cost);
    const cp = pts(cost, x, y + h * 0.04, w, h * 0.5, lo, hi);
    c.save();
    c.setLineDash([7 * s, 6 * s]);
    c.beginPath(); smooth(c, cp); c.strokeStyle = BLUE; c.lineWidth = 2.6 * s; c.stroke();
    c.restore();
    const ce = cp[cp.length - 1]!;
    c.fillStyle = BLUE; c.beginPath(); c.arc(ce[0], ce[1], 6 * s, 0, Math.PI * 2); c.fill();
    if (costEnd) {
      c.font = `500 ${18 * s}px ${NUM}`; c.textAlign = 'right';
      c.fillText(costEnd, ce[0] - 12 * s, ce[1] - 14 * s);
      c.textAlign = 'left';
    }
  }
}

function legend(c: Ctx, items: Array<[string, string, boolean?]>, x: number, y: number, s: number): void {
  c.font = `400 ${18 * s}px ${TEXT}`;
  let at = x;
  for (const [label, color, dash] of items) {
    c.fillStyle = color;
    if (dash) for (let k = 0; k < 22 * s; k += 10 * s) c.fillRect(at + k, y - 2 * s, Math.min(6 * s, 22 * s - k), 3 * s);
    else c.fillRect(at, y - 2 * s, 22 * s, 3 * s);
    c.fillStyle = MUTED;
    c.textBaseline = 'middle';
    c.fillText(label, at + 31 * s, y);
    c.textBaseline = 'alphabetic';
    at += 31 * s + c.measureText(label).width + 26 * s;
  }
}

/** The figures in one soft panel; signed values take their colour. Returns its height. */
function factsPanel(c: Ctx, facts: CardFact[], x: number, y: number, w: number, cols: number, s: number, draw = true): number {
  if (!facts.length) return 0;
  const rows = Math.ceil(facts.length / cols);
  const padY = 22 * s;
  const padX = 28 * s;
  const rowH = 17 * s + 6 * s + 27 * s;
  const gapY = 22 * s;
  const h = padY * 2 + rows * rowH + (rows - 1) * gapY;
  if (!draw) return h;
  c.fillStyle = 'rgba(255,255,255,0.045)';
  c.beginPath(); c.roundRect(x, y, w, h, 16 * s); c.fill();
  const colW = (w - padX * 2 - (cols - 1) * 24 * s) / cols;
  facts.forEach((f, i) => {
    const cx = x + padX + (i % cols) * (colW + 24 * s);
    const cy = y + padY + Math.floor(i / cols) * (rowH + gapY);
    c.font = `400 ${17 * s}px ${TEXT}`; c.fillStyle = DIM; c.textBaseline = 'top';
    c.fillText(f.label, cx, cy, colW);
    c.font = `500 ${27 * s}px ${NUM}`;
    c.fillStyle = /^\+/.test(f.value) ? SIGNAL : f.value.startsWith(MINUS) ? RED : WHITE;
    c.fillText(f.value, cx, cy + 23 * s, colW);
    c.textBaseline = 'alphabetic';
  });
  return h;
}

/** The figures as a list (label left, value right) in one soft panel: the wide card with no chart. */
function factsList(c: Ctx, facts: CardFact[], x: number, y: number, w: number): number {
  const rowH = 50;
  const h = 14 + facts.length * rowH + 14;
  c.fillStyle = 'rgba(255,255,255,0.045)';
  c.beginPath(); c.roundRect(x, y, w, h, 16); c.fill();
  facts.forEach((f, i) => {
    const cy = y + 14 + i * rowH + rowH / 2;
    if (i > 0) { c.fillStyle = 'rgba(255,255,255,0.07)'; c.fillRect(x + 24, y + 14 + i * rowH, w - 48, 1); }
    c.textBaseline = 'middle';
    c.font = `400 17px ${TEXT}`; c.fillStyle = DIM; c.fillText(f.label, x + 24, cy);
    c.font = `500 22px ${NUM}`; c.textAlign = 'right';
    c.fillStyle = /^\+/.test(f.value) ? SIGNAL : f.value.startsWith(MINUS) ? RED : WHITE;
    c.fillText(f.value, x + w - 24, cy, w * 0.6);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  });
  return h;
}

/** The card, drawn on `c` at its size times `k`. */
export function drawCard(c: Ctx, d: CardData, o: CardOpts, k = 1): void {
  const [W, H] = SIZES[o.ratio];
  if (d.art) { drawPointsArt(c, d.art, W, H, o.code, d.link, k); return; }
  const v = cardView(d, o);
  const wide = o.ratio === 'wide';
  const s = wide ? 1 : 1.12;
  const tone = d.kind === 'botvol' ? SIGNAL : v.bigTone === 'down' ? RED : SIGNAL;
  c.save();
  c.scale(k, k);
  // Ground: ink, a soft light top left, the dot grid, the result's glow toward the chart.
  c.fillStyle = INK; c.fillRect(0, 0, W, H);
  let g = c.createRadialGradient(W * 0.25, 0, 0, W * 0.25, 0, Math.max(W, H) * 0.8);
  g.addColorStop(0, '#1b1b1b'); g.addColorStop(1, INK);
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(255,255,255,0.075)';
  const cell = 40 * s;
  for (let y = cell / 2; y < H; y += cell) for (let x = cell / 2; x < W; x += cell) { c.beginPath(); c.arc(x, y, 1.4, 0, Math.PI * 2); c.fill(); }
  const gx = wide ? W * 0.78 : W * 0.7;
  const gy = wide ? H * 0.45 : H * 0.55;
  c.save();
  c.translate(gx, gy); c.scale(1, (H * 0.45) / (W * 0.5));
  g = c.createRadialGradient(0, 0, 0, 0, 0, W * 0.5);
  g.addColorStop(0, `${tone}22`); g.addColorStop(1, `${tone}00`);
  c.fillStyle = g; c.fillRect(-W, -W, W * 2, W * 2);
  c.restore();

  const pad = wide ? 60 : 72;
  const top = wide ? 48 : pad * 0.9;
  const bottom = H - (wide ? 40 : pad * 0.8);
  const inner = W - pad * 2;

  // Head: the lockup, the label pill and when.
  const headH = 38 * s;
  const headY = top + headH / 2;
  lockup(c, pad, headY, headH);
  c.font = `400 ${19 * s}px ${TEXT}`; c.fillStyle = MUTED; c.textAlign = 'right'; c.textBaseline = 'middle';
  c.fillText(d.when, W - pad, headY);
  const whenW = c.measureText(d.when).width;
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  pill(c, d.label, W - pad - whenW - 14 * s, headY, s, null, true);

  // Foot and figures, from the bottom up.
  const footY = bottom - 4 * s;
  c.font = `400 ${18 * s}px ${TEXT}`; c.fillStyle = MUTED;
  c.fillText(v.footLeft, pad, footY);
  c.font = `500 ${18 * s}px ${TEXT}`; c.fillStyle = WHITE; c.textAlign = 'right';
  c.fillText(v.footRight, W - pad, footY);
  c.textAlign = 'left';
  const cols = wide ? Math.min(4, Math.max(1, v.facts.length)) : 2;
  // Wide with no chart: the figures stand on the right as a list (the trade card), the bottom stays free.
  const listRight = wide && !d.chart && v.facts.length > 0;
  const factsH = listRight ? 0 : factsPanel(c, v.facts, pad, 0, inner, cols, wide ? 1 : s, false);
  const factsY = footY - 18 * s - (wide ? 26 : 30 * s) - factsH;
  if (!listRight) factsPanel(c, v.facts, pad, factsY, inner, cols, wide ? 1 : s);

  // Subject and number.
  const bodyTop = top + headH + (wide ? 46 : 64);
  let y = bodyTop;
  if (d.over) {
    c.font = `400 ${20 * s}px ${TEXT}`; c.fillStyle = MUTED; c.textBaseline = 'top';
    c.fillText(d.over, pad, y); c.textBaseline = 'alphabetic';
    y += 26 * s;
  }
  const titleY = y + 22 * s;
  c.font = `600 ${36 * s}px ${DISPLAY}`; spacing(c, -0.72 * s); c.fillStyle = WHITE; c.textBaseline = 'middle';
  c.fillText(v.title, pad, titleY);
  let px = pad + c.measureText(v.title).width + 14 * s;
  spacing(c, 0); c.textBaseline = 'alphabetic';
  for (const p of d.pills) px += pill(c, p.text, px, titleY, s, p.tone ? tone : null) + 10 * s;
  y = titleY + 22 * s + 26 * s;
  if (v.bigLabel) {
    c.font = `400 ${22 * s}px ${TEXT}`; c.fillStyle = MUTED; c.textBaseline = 'top';
    c.fillText(v.bigLabel, pad, y); c.textBaseline = 'alphabetic';
    y += 32 * s;
  }
  let big = (wide ? 124 : 132 * s) * (v.big.length > 9 ? 0.82 : 1);
  c.font = `600 ${big}px ${DISPLAY}`; spacing(c, -big * 0.05);
  const maxW = wide ? 560 : inner;
  while (c.measureText(v.big).width > maxW && big > 48) { big -= 4; c.font = `600 ${big}px ${DISPLAY}`; spacing(c, -big * 0.05); }
  c.fillStyle = toneColor(v.bigTone); c.textBaseline = 'top';
  c.fillText(v.big, pad + 2 * s, y);
  spacing(c, 0);
  y += big * 0.95;
  if (v.sub) {
    y += 16 * s;
    c.font = `500 ${28 * s}px ${TEXT}`; c.fillStyle = toneColor(v.subTone);
    c.fillText(v.sub, pad, y);
    const sw = c.measureText(`${v.sub} `).width;
    if (v.subRest) { c.font = `400 ${28 * s}px ${TEXT}`; c.fillStyle = MUTED; c.fillText(v.subRest, pad + sw, y); }
    y += 28 * s * 1.25;
  }
  c.textBaseline = 'alphabetic';

  if (listRight) {
    const lw = 340;
    const lh = 14 + v.facts.length * 50 + 14;
    const areaTop = top + headH + 30;
    factsList(c, v.facts, W - pad - lw, areaTop + Math.max(0, (footY - 40 - areaTop - lh) / 2), lw);
  }
  // The chart: beside the number (wide), or between the number and the figures (square).
  if (d.chart) {
    const hasLegend = d.chart.type !== 'pnl';
    let cx: number, cy: number, cw: number, ch: number;
    if (wide) {
      cw = 500; ch = hasLegend ? 190 : 210;
      cx = W - pad - cw;
      const areaTop = bodyTop;
      const areaBottom = factsY - 18;
      cy = areaTop + (areaBottom - areaTop - ch - (hasLegend ? 34 : 18)) / 2;
    } else {
      const areaTop = y + 26 * s;
      const areaBottom = factsY - 26 * s;
      cw = inner; ch = Math.max(60, Math.min(170 * (hasLegend ? 0.85 : 1), areaBottom - areaTop - (hasLegend ? 40 * s : 0)));
      cx = pad; cy = areaTop + (areaBottom - areaTop - ch - (hasLegend ? 40 * s : 0)) / 2;
    }
    const ch2 = d.chart;
    if (ch2.type === 'pnl') pnlChart(c, ch2.ys, cx, cy, cw, ch, s);
    else if (ch2.type === 'copy') {
      copyChart(c, ch2.me, ch2.them, cx, cy, cw, ch, s, tone);
      legend(c, ch2.them.length > 1 ? [['Trader', 'rgba(255,255,255,0.55)'], ['My copy', tone]] : [['My copy', tone]], cx, cy + ch + 26 * s, s);
    } else {
      volumeChart(c, ch2.vol, ch2.cost, ch2.costEnd, cx, cy, cw, ch, s);
      legend(c, ch2.cost ? [['Volume', SIGNAL], ['Cost (bp)', BLUE, true]] : [['Volume', SIGNAL]], cx, cy + ch + 26 * s, s);
    }
  }
  c.restore();
}

/** The fonts the card draws with (self-hosted, @fontsource), loaded before a draw. */
export async function cardFonts(): Promise<void> {
  try {
    await Promise.all(['600 124px "Space Grotesk"', '400 19px "IBM Plex Sans"', '500 19px "IBM Plex Sans"', '500 27px "Asap"'].map((f) => document.fonts.load(f)));
  } catch {
    /* the fallbacks draw */
  }
}

export async function cardPng(d0: CardData, o: CardOpts): Promise<Blob> {
  await cardFonts();
  // The SoPoints cards carry a QR code of their link: made once per link, before the draw.
  const d = d0.art && d0.art.qr === undefined ? { ...d0, art: { ...d0.art, qr: await qrModules(d0.link) } } : d0;
  const [W, H] = SIZES[o.ratio];
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  drawCard(cv.getContext('2d')!, d, o, 1);
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('The image could not be made.'))), 'image/png'));
}

/** The X post link: its words and the card's link (the image is attached by the user: X takes no image by URL). */
export function xIntent(d: CardData, o: Pick<CardOpts, 'amounts'>): string {
  const q = new URLSearchParams({ text: d.post(o), url: d.link });
  return `https://x.com/intent/post?${q.toString()}`;
}
