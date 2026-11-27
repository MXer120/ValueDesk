/**
 * The SoPoints share images (owner 2026-11-27: "the share sopoints normal card also needs to look just like the actual
 * card, but styled the ref code in the bottom left with qr code in bottom right, like sodex original"; "the share of
 * the estimation panel should look like the estimation panel"). Drawn on the same canvas as the other share cards
 * (card.ts cardPng): the page's own card, SoDEX's tier card or the week's estimate card, large, and under it the
 * wallet's invite code on the left and a QR code of the link on the right.
 */
import { lockup } from './card';

type Ctx = CanvasRenderingContext2D;

const INK = '#0b0b0b';
const WHITE = '#f4f4f2';
const MUTED = 'rgba(244,244,242,0.62)';
const FAINT = 'rgba(244,244,242,0.42)';
const INDIGO = '140,155,245';
const DISPLAY = '"Space Grotesk", sans-serif';
const TEXT = '"IBM Plex Sans", sans-serif';
const NUM = '"Asap", "IBM Plex Sans", sans-serif';

/** SoDEX's tier card (SoPointsMine SoPointsCard), as data. */
export interface TierArt {
  kind: 'tier';
  tier: string;
  /** The card's gradient stops, its edge, the chip's colour and the progress bar's stops (TIER_STYLE). */
  stops: string[];
  border: string;
  chip: string;
  bar: string[];
  /** Over the number ("SoPoints", "Week 12", "Rank on SoDEX"), the number, and the line under it. */
  label: string;
  big: string;
  unit: string | null;
  line: string | null;
  next: { name: string; at: string; pct: number } | null;
  rank: string | null;
}

/** The week's estimate card (Stage LiveCard), as data. */
export interface EstimateArt {
  kind: 'estimate';
  title: string;
  big: string;
  busy: string;
  mid: string;
  quiet: string;
  /** Where busy, typical and quiet sit on the scale, 0..1. */
  at: { busy: number; mid: number; quiet: number };
  inputs: Array<{ k: string; v: string }>;
}

export type PointsArt = (TierArt | EstimateArt) & {
  /** Beside the lockup ("Layer 1 · Week 13"). */
  when: string;
  /** The QR code's modules (filled in by cardPng from the card's link before it draws). */
  qr?: { size: number; data: ArrayLike<number> } | null;
};

/** The QR code of a link (the `qrcode` package, loaded only when a card needs one). */
export async function qrModules(text: string): Promise<{ size: number; data: ArrayLike<number> } | null> {
  try {
    const QR = (await import('qrcode')).default;
    const q = QR.create(text, { errorCorrectionLevel: 'M' });
    return { size: q.modules.size, data: q.modules.data };
  } catch {
    return null;
  }
}

function rr(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function chipText(c: Ctx, text: string, x: number, cy: number, size: number, color: string, outline: boolean): number {
  c.font = `600 ${size}px ${TEXT}`;
  const w = c.measureText(text).width + size * 1.3;
  const h = size * 1.9;
  rr(c, x, cy - h / 2, w, h, h * 0.22);
  if (outline) { c.strokeStyle = `${color}80`; c.lineWidth = Math.max(1.5, size * 0.09); c.stroke(); } else { c.fillStyle = 'rgba(255,255,255,0.12)'; c.fill(); }
  c.fillStyle = color;
  c.textBaseline = 'middle';
  c.fillText(text, x + size * 0.65, cy + 1);
  c.textBaseline = 'alphabetic';
  return w;
}

/** A small crown (SoDEX's rank line). */
function crown(c: Ctx, x: number, cy: number, s: number, color: string): void {
  c.save();
  c.strokeStyle = color; c.lineWidth = 1.6 * s; c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(x, cy - 2 * s); c.lineTo(x + 4 * s, cy + 1 * s); c.lineTo(x + 7 * s, cy - 5 * s); c.lineTo(x + 10 * s, cy + 1 * s); c.lineTo(x + 14 * s, cy - 2 * s);
  c.lineTo(x + 12.5 * s, cy + 5 * s); c.lineTo(x + 1.5 * s, cy + 5 * s); c.closePath(); c.stroke();
  c.restore();
}

function tierCard(c: Ctx, a: TierArt, x: number, y: number, w: number, h: number, s: number): void {
  // SoDEX's card: the tier's gradient (165 degrees), its edge, its shadow.
  c.save();
  c.shadowColor = `${a.border}66`; c.shadowBlur = 60 * s; c.shadowOffsetY = 24 * s;
  rr(c, x, y, w, h, 30 * s);
  const ang = (165 - 90) * (Math.PI / 180);
  const cx = x + w / 2, cy = y + h / 2, len = Math.abs(w * Math.cos(ang)) + Math.abs(h * Math.sin(ang));
  const g = c.createLinearGradient(cx - (Math.cos(ang) * len) / 2, cy - (Math.sin(ang) * len) / 2, cx + (Math.cos(ang) * len) / 2, cy + (Math.sin(ang) * len) / 2);
  a.stops.forEach((col, i) => g.addColorStop(i / Math.max(1, a.stops.length - 1), col));
  c.fillStyle = g; c.fill();
  c.restore();
  rr(c, x, y, w, h, 30 * s); c.strokeStyle = a.border; c.lineWidth = 3 * s; c.stroke();
  // A soft sheen from the top left, as the card's glare.
  c.save(); rr(c, x, y, w, h, 30 * s); c.clip();
  const sh = c.createLinearGradient(x, y, x + w * 0.6, y + h * 0.8);
  sh.addColorStop(0, 'rgba(255,255,255,0.16)'); sh.addColorStop(0.5, 'rgba(255,255,255,0)');
  c.fillStyle = sh; c.fillRect(x, y, w, h);
  c.restore();
  const p = 46 * s;
  // The tier's name, the number and its chip.
  c.fillStyle = WHITE; c.font = `700 ${58 * s}px ${DISPLAY}`; c.textBaseline = 'alphabetic';
  c.fillText(a.tier.toUpperCase(), x + p, y + p + 46 * s);
  c.font = `500 ${22 * s}px ${TEXT}`; c.fillStyle = 'rgba(255,255,255,0.72)';
  c.textAlign = 'right'; c.fillText(a.label, x + w - p, y + p + 36 * s); c.textAlign = 'left';
  c.font = `700 ${124 * s}px ${NUM}`; c.fillStyle = WHITE;
  const by = y + p + 46 * s + 150 * s;
  c.fillText(a.big, x + p - 4 * s, by);
  const bw = c.measureText(a.big).width;
  if (a.unit) chipText(c, a.unit, x + p + bw + 24 * s, by - 44 * s, 24 * s, a.chip, true);
  if (a.line) { c.font = `600 ${26 * s}px ${TEXT}`; c.fillStyle = 'rgba(255,255,255,0.82)'; c.fillText(a.line, x + p, by + 54 * s); }
  // The next tier and its bar, the rank.
  const bot = y + h - p;
  let ry = bot;
  if (a.rank) {
    crown(c, x + p, bot - 8 * s, 1.5 * s, 'rgba(255,255,255,0.85)');
    c.font = `600 ${24 * s}px ${TEXT}`; c.fillStyle = 'rgba(255,255,255,0.88)';
    c.fillText(a.rank, x + p + 32 * s, bot);
    ry = bot - 46 * s;
  }
  const barY = ry - 12 * s;
  rr(c, x + p, barY, w - 2 * p, 14 * s, 7 * s); c.fillStyle = 'rgba(0,0,0,0.28)'; c.fill();
  const pct = a.next ? Math.max(0.02, Math.min(1, a.next.pct)) : 1;
  const bg = c.createLinearGradient(x + p, 0, x + p + (w - 2 * p) * pct, 0);
  a.bar.forEach((col, i) => bg.addColorStop(i / Math.max(1, a.bar.length - 1), col));
  rr(c, x + p, barY, (w - 2 * p) * pct, 14 * s, 7 * s); c.fillStyle = bg; c.fill();
  c.font = `600 ${20 * s}px ${TEXT}`; c.fillStyle = 'rgba(255,255,255,0.82)';
  c.fillText(a.next ? `NEXT TIER: ${a.next.name.toUpperCase()}` : 'MAX LEVEL', x + p, barY - 18 * s);
  if (a.next) { c.font = `700 ${22 * s}px ${NUM}`; c.textAlign = 'right'; c.fillText(a.next.at, x + w - p, barY - 18 * s); c.textAlign = 'left'; }
}

function estimateCard(c: Ctx, a: EstimateArt, x: number, y: number, w: number, h: number, s: number): void {
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.7)'; c.shadowBlur = 50 * s; c.shadowOffsetY = 20 * s;
  rr(c, x, y, w, h, 26 * s);
  const g = c.createLinearGradient(x, y, x + w * 0.7, y + h);
  g.addColorStop(0, '#212225'); g.addColorStop(0.46, '#141517'); g.addColorStop(1, '#0c0c0d');
  c.fillStyle = g; c.fill();
  c.restore();
  rr(c, x, y, w, h, 26 * s); c.strokeStyle = 'rgba(255,255,255,0.1)'; c.lineWidth = 2 * s; c.stroke();
  const p = 44 * s;
  c.font = `600 ${26 * s}px ${TEXT}`; c.fillStyle = 'rgba(244,244,242,0.78)';
  c.fillText(a.title, x + p, y + p + 22 * s);
  // The "Estimate" pill, as the card's.
  c.font = `500 ${20 * s}px ${TEXT}`;
  const tw = c.measureText('Estimate').width + 28 * s;
  rr(c, x + w - p - tw, y + p - 4 * s, tw, 36 * s, 18 * s); c.fillStyle = 'rgba(255,255,255,0.1)'; c.fill();
  c.fillStyle = 'rgba(244,244,242,0.8)'; c.textBaseline = 'middle'; c.fillText('Estimate', x + w - p - tw + 14 * s, y + p + 14 * s); c.textBaseline = 'alphabetic';
  // The number.
  c.font = `800 ${120 * s}px ${NUM}`; c.fillStyle = WHITE;
  const ny = y + p + 170 * s;
  c.fillText(a.big, x + p - 4 * s, ny);
  const nw = c.measureText(a.big).width;
  c.font = `400 ${30 * s}px ${TEXT}`; c.fillStyle = 'rgba(244,244,242,0.56)';
  c.fillText('SoPoints', x + p + nw + 18 * s, ny);
  // The range: the axis, the busy-to-quiet band, the typical week.
  const ay = ny + 64 * s, ax = x + p, aw = w - 2 * p;
  c.fillStyle = 'rgba(255,255,255,0.1)'; rr(c, ax, ay - 2 * s, aw, 4 * s, 2 * s); c.fill();
  const bx = ax + aw * a.at.busy, qx = ax + aw * a.at.quiet;
  const band = c.createLinearGradient(bx, 0, qx, 0);
  band.addColorStop(0, `rgba(${INDIGO},0.42)`); band.addColorStop(1, `rgba(${INDIGO},0.85)`);
  c.save(); c.shadowColor = `rgba(${INDIGO},0.5)`; c.shadowBlur = 18 * s;
  rr(c, bx, ay - 10 * s, Math.max(6 * s, qx - bx), 20 * s, 10 * s); c.fillStyle = band; c.fill(); c.restore();
  const mx = ax + aw * a.at.mid;
  rr(c, mx - 4 * s, ay - 18 * s, 8 * s, 36 * s, 4 * s); c.fillStyle = WHITE; c.fill();
  // Busy, typical, quiet.
  const ly = ay + 56 * s;
  const lab = (t: string, v: string, lx: number, align: CanvasTextAlign, dot: string) => {
    c.textAlign = align;
    c.font = `400 ${20 * s}px ${TEXT}`; c.fillStyle = FAINT;
    const off = align === 'left' ? 16 * s : align === 'right' ? 0 : 8 * s;
    c.fillText(t, lx + off, ly);
    c.font = `600 ${28 * s}px ${NUM}`; c.fillStyle = WHITE; c.fillText(v, lx + (align === 'left' ? 0 : 0), ly + 36 * s);
    const tw2 = (c.font = `400 ${20 * s}px ${TEXT}`, c.measureText(t).width);
    const dx = align === 'left' ? lx + 5 * s : align === 'right' ? lx - tw2 - 12 * s : lx - tw2 / 2 - 6 * s;
    c.beginPath(); c.arc(dx, ly - 7 * s, 5 * s, 0, Math.PI * 2); c.fillStyle = dot; c.fill();
    c.textAlign = 'left';
  };
  lab('Busy week', a.busy, ax, 'left', `rgba(${INDIGO},0.55)`);
  lab('Typical', a.mid, ax + aw / 2, 'center', WHITE);
  lab('Quiet week', a.quiet, ax + aw, 'right', `rgb(${INDIGO})`);
  // What it prices.
  const iy = y + h - p;
  c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(ax, iy - 74 * s, aw, 1.5 * s);
  let ix = ax;
  for (const it of a.inputs) {
    c.font = `400 ${18 * s}px ${TEXT}`; c.fillStyle = FAINT; c.fillText(it.k, ix, iy - 34 * s);
    c.font = `600 ${24 * s}px ${NUM}`; c.fillStyle = WHITE; c.fillText(it.v, ix, iy);
    ix += Math.max(c.measureText(it.v).width, (c.font = `400 ${18 * s}px ${TEXT}`, c.measureText(it.k).width)) + 40 * s;
  }
}

function qr(c: Ctx, q: { size: number; data: ArrayLike<number> }, x: number, y: number, side: number): void {
  const pad = side * 0.08;
  rr(c, x, y, side, side, side * 0.08); c.fillStyle = '#ffffff'; c.fill();
  const cell = (side - 2 * pad) / q.size;
  c.fillStyle = INK;
  for (let r = 0; r < q.size; r++) for (let k = 0; k < q.size; k++) if (q.data[r * q.size + k]) c.fillRect(x + pad + k * cell, y + pad + r * cell, Math.ceil(cell), Math.ceil(cell));
}

/** The whole image: the ground, the lockup and the week, the card, the code and the QR code. */
export function drawPointsArt(c: Ctx, a: PointsArt, W: number, H: number, code: string | null, link: string, k = 1): void {
  const wide = W > H;
  const s = wide ? 0.82 : 1;
  c.save();
  c.scale(k, k);
  c.fillStyle = INK; c.fillRect(0, 0, W, H);
  const tint = a.kind === 'tier' ? a.border : `rgb(${INDIGO})`;
  const g = c.createRadialGradient(W * 0.7, H * 0.3, 0, W * 0.7, H * 0.3, Math.max(W, H) * 0.75);
  g.addColorStop(0, `${tint.startsWith('#') ? `${tint}33` : 'rgba(140,155,245,0.2)'}`); g.addColorStop(1, 'rgba(11,11,11,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(255,255,255,0.06)';
  const cell = 40;
  for (let yy = cell / 2; yy < H; yy += cell) for (let xx = cell / 2; xx < W; xx += cell) { c.beginPath(); c.arc(xx, yy, 1.3, 0, Math.PI * 2); c.fill(); }
  const pad = wide ? 46 : 64;
  const head = wide ? 30 : 34;
  lockup(c, pad, pad + head / 2, head);
  c.font = `400 20px ${TEXT}`; c.fillStyle = MUTED; c.textAlign = 'right'; c.textBaseline = 'middle';
  c.fillText(a.when, W - pad, pad + head / 2); c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  // The foot: the invite code on the left, the QR code of the link on the right (SoDEX's poster).
  const side = wide ? 96 : 176;
  const footTop = H - pad - side;
  const cardTop = pad + head + (wide ? 18 : 40);
  const cardH = footTop - cardTop - (wide ? 18 : 40);
  const cardW = wide ? Math.min(W - 2 * pad, cardH * 2) : W - 2 * pad;
  const cardX = (W - cardW) / 2;
  if (a.kind === 'tier') tierCard(c, a, cardX, cardTop, cardW, cardH, Math.min(1.2, cardW / 960) * (wide ? 1 : 1.05));
  else estimateCard(c, a, cardX, cardTop, cardW, cardH, Math.min(1.2, cardW / 900));
  const fy = footTop + side / 2;
  c.textBaseline = 'middle';
  if (code) {
    c.font = `400 ${wide ? 19 : 24}px ${TEXT}`; c.fillStyle = MUTED; c.fillText('Join my squad with my invite code', pad, fy - (wide ? 30 : 42));
    c.font = `700 ${wide ? 44 : 60}px ${NUM}`; c.fillStyle = WHITE; c.fillText(code, pad, fy + 6);
    c.font = `400 ${wide ? 18 : 22}px ${TEXT}`; c.fillStyle = FAINT; c.fillText(link.replace(/^https?:\/\//, ''), pad, fy + (wide ? 44 : 58));
  } else {
    c.font = `500 ${wide ? 26 : 32}px ${TEXT}`; c.fillStyle = WHITE; c.fillText('SoPoints on SoDEX', pad, fy - 12);
    c.font = `400 ${wide ? 19 : 23}px ${TEXT}`; c.fillStyle = FAINT; c.fillText(link.replace(/^https?:\/\//, ''), pad, fy + 22);
  }
  c.textBaseline = 'alphabetic';
  if (a.qr) qr(c, a.qr, W - pad - side, footTop, side);
  c.restore();
}
