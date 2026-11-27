/**
 * The SoPoints share images (owner 2026-11-27: "It should be completely the estimate/sopoints card, with just a bar at
 * the bottom with valuedesk logo and users referral code. It should look like its coming out behind the gold card ...
 * boders around it, but very very slim and our bg color at the bottom and green at the top fading into bg at the
 * bottom, but some green is still visible at the bottom"). Drawn on the same canvas as the other share cards (card.ts
 * cardPng): the page's own card, SoDEX's tier card or the week's estimate card, edge to edge, and under it, slipping
 * out from behind it, a slightly narrower bar with the ValueDesk lockup and the wallet's referral code. Nothing else
 * is drawn: the image's corners are transparent.
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
  /** The week it is ("Layer 1 · Week 13"), in the bar when no code is shown. */
  when: string;
};

function rr(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function chipText(c: Ctx, text: string, x: number, cy: number, size: number, color: string, outline: boolean): number {
  c.font = `500 ${size}px ${TEXT}`;
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

/** A soft vignette inside a card: clear in the middle, darker toward its edges and corners. */
function vignette(c: Ctx, x: number, y: number, w: number, h: number, r: number, strength: number): void {
  c.save();
  rr(c, x, y, w, h, r); c.clip();
  c.translate(x + w / 2, y + h / 2);
  c.scale(w / Math.max(w, h), h / Math.max(w, h));
  const R = Math.max(w, h) * 0.72;
  const g = c.createRadialGradient(0, 0, R * 0.45, 0, 0, R);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${strength})`);
  c.fillStyle = g; c.fillRect(-R, -R, R * 2, R * 2);
  c.restore();
}

function tierCard(c: Ctx, a: TierArt, x: number, y: number, w: number, h: number, s: number, R = 30 * s): void {
  // SoDEX's card: the tier's gradient (165 degrees), its edge, its shadow.
  c.save();
  rr(c, x, y, w, h, R);
  const ang = (165 - 90) * (Math.PI / 180);
  const cx = x + w / 2, cy = y + h / 2, len = Math.abs(w * Math.cos(ang)) + Math.abs(h * Math.sin(ang));
  const g = c.createLinearGradient(cx - (Math.cos(ang) * len) / 2, cy - (Math.sin(ang) * len) / 2, cx + (Math.cos(ang) * len) / 2, cy + (Math.sin(ang) * len) / 2);
  a.stops.forEach((col, i) => g.addColorStop(i / Math.max(1, a.stops.length - 1), col));
  c.fillStyle = g; c.fill();
  c.restore();
  // A soft sheen from the top left, as the card's glare.
  c.save(); rr(c, x, y, w, h, R); c.clip();
  const sh = c.createLinearGradient(x, y, x + w * 0.6, y + h * 0.8);
  sh.addColorStop(0, 'rgba(255,255,255,0.16)'); sh.addColorStop(0.5, 'rgba(255,255,255,0)');
  c.fillStyle = sh; c.fillRect(x, y, w, h);
  c.restore();
  vignette(c, x, y, w, h, R, 0.34);
  // The tier's edge last, so the vignette never dims it.
  rr(c, x, y, w, h, R); c.strokeStyle = a.border; c.lineWidth = 3; c.stroke();
  const p = 46 * s;
  // The tier's name, the number and its chip.
  c.fillStyle = WHITE; c.font = `600 ${58 * s}px ${DISPLAY}`; c.textBaseline = 'alphabetic';
  c.fillText(a.tier.toUpperCase(), x + p, y + p + 46 * s);
  c.font = `500 ${22 * s}px ${TEXT}`; c.fillStyle = 'rgba(255,255,255,0.72)';
  c.textAlign = 'right'; c.fillText(a.label, x + w - p, y + p + 36 * s); c.textAlign = 'left';
  c.font = `500 ${124 * s}px ${NUM}`; c.fillStyle = WHITE;
  // The number sits in the card's middle when the card is tall (the square image), under the name when it is wide.
  const by = Math.max(y + p + 46 * s + 150 * s, y + h * 0.5);
  c.fillText(a.big, x + p - 4 * s, by);
  const bw = c.measureText(a.big).width;
  if (a.unit) chipText(c, a.unit, x + p + bw + 24 * s, by - 44 * s, 24 * s, a.chip, true);
  if (a.line) { c.font = `500 ${26 * s}px ${TEXT}`; c.fillStyle = 'rgba(255,255,255,0.82)'; c.fillText(a.line, x + p, by + 54 * s); }
  // The next tier and its bar, the rank.
  const bot = y + h - p;
  let ry = bot;
  if (a.rank) {
    crown(c, x + p, bot - 8 * s, 1.5 * s, 'rgba(255,255,255,0.85)');
    c.font = `500 ${24 * s}px ${TEXT}`; c.fillStyle = 'rgba(255,255,255,0.88)';
    c.fillText(a.rank, x + p + 32 * s, bot);
    ry = bot - 46 * s;
  }
  const barY = ry - 12 * s;
  rr(c, x + p, barY, w - 2 * p, 14 * s, 7 * s); c.fillStyle = 'rgba(0,0,0,0.28)'; c.fill();
  const pct = a.next ? Math.max(0.02, Math.min(1, a.next.pct)) : 1;
  const bg = c.createLinearGradient(x + p, 0, x + p + (w - 2 * p) * pct, 0);
  a.bar.forEach((col, i) => bg.addColorStop(i / Math.max(1, a.bar.length - 1), col));
  rr(c, x + p, barY, (w - 2 * p) * pct, 14 * s, 7 * s); c.fillStyle = bg; c.fill();
  c.font = `500 ${20 * s}px ${TEXT}`; c.fillStyle = 'rgba(255,255,255,0.82)';
  c.fillText(a.next ? `NEXT TIER: ${a.next.name.toUpperCase()}` : 'MAX LEVEL', x + p, barY - 18 * s);
  if (a.next) { c.font = `500 ${22 * s}px ${NUM}`; c.textAlign = 'right'; c.fillText(a.next.at, x + w - p, barY - 18 * s); c.textAlign = 'left'; }
}

function estimateCard(c: Ctx, a: EstimateArt, x: number, y: number, w: number, h: number, s: number, R = 26 * s): void {
  c.save();
  rr(c, x, y, w, h, R);
  const g = c.createLinearGradient(x, y, x + w * 0.7, y + h);
  g.addColorStop(0, '#212225'); g.addColorStop(0.46, '#141517'); g.addColorStop(1, '#0c0c0d');
  c.fillStyle = g; c.fill();
  c.restore();
  vignette(c, x, y, w, h, R, 0.45);
  rr(c, x, y, w, h, R); c.strokeStyle = 'rgba(255,255,255,0.14)'; c.lineWidth = 1.5; c.stroke();
  const p = 44 * s;
  c.font = `500 ${26 * s}px ${TEXT}`; c.fillStyle = 'rgba(244,244,242,0.78)';
  c.fillText(a.title, x + p, y + p + 22 * s);
  // The "Estimate" pill, as the card's.
  c.font = `500 ${20 * s}px ${TEXT}`;
  const tw = c.measureText('Estimate').width + 28 * s;
  rr(c, x + w - p - tw, y + p - 4 * s, tw, 36 * s, 18 * s); c.fillStyle = 'rgba(255,255,255,0.1)'; c.fill();
  c.fillStyle = 'rgba(244,244,242,0.8)'; c.textBaseline = 'middle'; c.fillText('Estimate', x + w - p - tw + 14 * s, y + p + 14 * s); c.textBaseline = 'alphabetic';
  // The number.
  c.font = `500 ${120 * s}px ${NUM}`; c.fillStyle = WHITE;
  // Tall (the square image): the number and its range in the middle; wide: under the title.
  const ny = Math.max(y + p + 170 * s, y + h * 0.42);
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
    c.font = `500 ${28 * s}px ${NUM}`; c.fillStyle = WHITE; c.fillText(v, lx + (align === 'left' ? 0 : 0), ly + 36 * s);
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
    c.font = `500 ${24 * s}px ${NUM}`; c.fillStyle = WHITE; c.fillText(it.v, ix, iy);
    ix += Math.max(c.measureText(it.v).width, (c.font = `400 ${18 * s}px ${TEXT}`, c.measureText(it.k).width)) + 40 * s;
  }
}

/* Only the weights the app self-hosts (main.tsx @fontsource: Space Grotesk 600, Asap 400/500, IBM Plex Sans 400/500),
   so the canvas never falls back to another face. */

/** Our green (the app's --pos). */
const GREEN = '0,180,129';

/**
 * The image: one slim frame around the card and the bar under it (owner 2026-11-27: "the valuedesk thing needs to have
 * same width, and a slim border extending to the sides of the cards and then top"). The frame is green at the top and
 * fades into our ground (#0b0b0b) toward its foot, a little green left there; the card sits in it a few pixels in, so
 * the bar, the frame's open foot, is the card's width; the lockup on its left, the referral code on its right (the week
 * when the code is hidden).
 */
export function drawPointsArt(c: Ctx, a: PointsArt, W: number, H: number, code: string | null, _link: string, k = 1): void {
  const wide = W > H;
  c.save();
  c.scale(k, k);
  c.clearRect(0, 0, W, H);
  const bar = wide ? 84 : 112;
  const gap = wide ? 7 : 9;
  const radius = wide ? 30 : 34;
  const cardH = H - bar;
  // The frame: the whole image, our ground, green from the top fading down, its slim edge.
  rr(c, 0.5, 0.5, W - 1, H - 1, radius + gap);
  c.fillStyle = INK; c.fill();
  const tint = c.createLinearGradient(0, 0, 0, H);
  tint.addColorStop(0, `rgba(${GREEN},0.5)`); tint.addColorStop(0.6, `rgba(${GREEN},0.16)`); tint.addColorStop(1, `rgba(${GREEN},0.07)`);
  rr(c, 0.5, 0.5, W - 1, H - 1, radius + gap); c.fillStyle = tint; c.fill();
  const edge = c.createLinearGradient(0, 0, 0, H);
  edge.addColorStop(0, `rgba(${GREEN},0.8)`); edge.addColorStop(1, 'rgba(255,255,255,0.14)');
  rr(c, 0.5, 0.5, W - 1, H - 1, radius + gap); c.strokeStyle = edge; c.lineWidth = 1; c.stroke();
  // The card in it, a few pixels in at the top and sides.
  const s = Math.min(1.25, W / 960);
  const cw = W - 2 * gap, ch = cardH - gap;
  if (a.kind === 'tier') tierCard(c, a, gap, gap, cw, ch, s * (wide ? 0.95 : 1.07), radius);
  else estimateCard(c, a, gap, gap, cw, ch, s * (wide ? 0.95 : 1.04), radius);
  // The frame's open foot: the lockup and the code.
  const cy = cardH + bar / 2;
  const pad = gap + (wide ? 34 : 40);
  lockup(c, pad, cy, wide ? 36 : 44);
  c.textBaseline = 'middle'; c.textAlign = 'right';
  const right = W - pad;
  if (code) {
    c.font = `500 ${wide ? 30 : 38}px ${NUM}`; c.fillStyle = WHITE;
    c.fillText(code, right, cy);
    const tw = c.measureText(code).width;
    c.font = `400 ${wide ? 19 : 24}px ${TEXT}`; c.fillStyle = MUTED;
    c.fillText('Referral code', right - tw - (wide ? 16 : 20), cy + 1);
  } else {
    c.font = `400 ${wide ? 19 : 24}px ${TEXT}`; c.fillStyle = MUTED;
    c.fillText(a.when, right, cy + 1);
  }
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.restore();
}
