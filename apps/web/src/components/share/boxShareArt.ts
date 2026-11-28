/**
 * The Blind Box share images (owner 2026-11-28: "the share cards need to be special designed based off of each boxes
 * rarity, nft needs special with actual image if there is one ... instead of $ amount and wallet address use ref code &
 * box id"). One layout, coloured by the tier: the box (or the Cybereator's own picture) in its tier's light, the tier and
 * the box id or count beside it, and at the foot the ValueDesk lockup and the sharer's referral code. No dollar figure and
 * no wallet address are drawn.
 */
import { lockup } from './card';

type Ctx = CanvasRenderingContext2D;

export interface BoxShareArt {
  kind: 'box';
  /** 'Common' … 'SuperRare', or 'Cybereator'. */
  tier: string;
  /** The pill: "SuperRare box", "Common boxes", "Cybereator". */
  label: string;
  /** The big line: "#196204", "23 boxes", "Cybereator #2564". */
  title: string;
  /** Small lines under it (no dollars). */
  lines: string[];
  /** The picture: the box art (same origin) or the NFT's own image. */
  image: string | null;
  when: string;
}

const INK = '#0b0b0b';
const WHITE = '#f4f4f2';
const MUTED = 'rgba(244,244,242,0.62)';
const DISPLAY = '"Space Grotesk", sans-serif';
const TEXT = '"IBM Plex Sans", sans-serif';
const NUM = '"Asap", "IBM Plex Sans", sans-serif';

/** Each tier's light (sodex.css --tier); SuperRare purple with gold, a Cybereator our green. */
const LIGHT: Record<string, { glow: string; edge: string; accent: string }> = {
  Common: { glow: '184,174,148', edge: '184,174,148', accent: '#d9d0b6' },
  Uncommon: { glow: '74,165,125', edge: '74,165,125', accent: '#7fd3ab' },
  Rare: { glow: '76,134,218', edge: '76,134,218', accent: '#8fc0ff' },
  SuperRare: { glow: '142,92,217', edge: '230,180,60', accent: '#ffd76a' },
  Cybereator: { glow: '0,180,129', edge: '0,180,129', accent: '#5fe0b3' },
};

const loaded = new Map<string, HTMLImageElement | null>();

/** Loads the picture before a draw; one that will not load (or may not be drawn) is left out, never a broken card. */
export async function loadShareImage(url: string | null): Promise<void> {
  if (!url || loaded.has(url)) return;
  const img = await new Promise<HTMLImageElement | null>((res) => {
    const i = new Image();
    if (!url.startsWith('/')) i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = url;
  });
  /* A picture from a host that sends no CORS header would block the image's export: left out instead. */
  if (img) { try { const t = document.createElement('canvas'); t.width = t.height = 1; const x = t.getContext('2d')!; x.drawImage(img, 0, 0, 1, 1); x.getImageData(0, 0, 1, 1); } catch { loaded.set(url, null); return; } }
  loaded.set(url, img);
}

function rr(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function star(c: Ctx, x: number, y: number, r: number, color: string): void {
  c.save();
  c.translate(x, y);
  c.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const a = (Math.PI / 4) * i;
    const d = i % 2 ? r * 0.26 : r;
    c.lineTo(Math.cos(a) * d, Math.sin(a) * d);
  }
  c.closePath();
  c.shadowColor = color; c.shadowBlur = r * 1.4;
  c.fillStyle = color; c.fill();
  c.restore();
}

export function drawBoxArt(c: Ctx, a: BoxShareArt, W: number, H: number, code: string | null, k = 1): void {
  const wide = W > H;
  const L = LIGHT[a.tier] ?? LIGHT.Common!;
  c.save();
  c.scale(k, k);
  c.clearRect(0, 0, W, H);
  const r = wide ? 34 : 38;
  rr(c, 0.5, 0.5, W - 1, H - 1, r); c.fillStyle = INK; c.fill();
  // The tier's light from the top and behind the box.
  const top = c.createRadialGradient(W / 2, 0, 0, W / 2, 0, W * 0.75);
  top.addColorStop(0, `rgba(${L.glow},0.34)`); top.addColorStop(1, `rgba(${L.glow},0)`);
  rr(c, 0.5, 0.5, W - 1, H - 1, r); c.fillStyle = top; c.fill();
  const foot = wide ? 92 : 112;
  const size = Math.min(wide ? H * 0.6 : W * 0.5, H - foot - 120);
  const ix = wide ? W * 0.27 : W / 2;
  const iy = wide ? (H - foot) / 2 + 6 : 64 + size / 2;
  const halo = c.createRadialGradient(ix, iy, 0, ix, iy, size * 0.8);
  halo.addColorStop(0, `rgba(${L.glow},0.55)`); halo.addColorStop(0.55, `rgba(${L.glow},0.16)`); halo.addColorStop(1, `rgba(${L.glow},0)`);
  c.fillStyle = halo; c.fillRect(0, 0, W, H);
  const img = a.image ? loaded.get(a.image) : null;
  if (img) {
    const nft = a.tier === 'Cybereator';
    const s = nft ? size * 0.92 : size;
    c.save();
    if (nft) { rr(c, ix - s / 2, iy - s / 2, s, s, s * 0.08); c.clip(); }
    c.drawImage(img, ix - s / 2, iy - s / 2, s, s);
    c.restore();
    if (nft) { rr(c, ix - s / 2, iy - s / 2, s, s, s * 0.08); c.strokeStyle = `rgba(${L.edge},0.7)`; c.lineWidth = 2; c.stroke(); }
  }
  if (a.tier === 'SuperRare' || a.tier === 'Rare') {
    const pts: Array<[number, number, number]> = a.tier === 'SuperRare'
      ? [[-0.55, -0.42, 18], [0.5, -0.5, 14], [0.58, 0.3, 12], [-0.48, 0.4, 15], [0.05, -0.62, 10], [-0.7, -0.02, 10]]
      : [[-0.5, -0.4, 10], [0.52, -0.38, 9], [0.46, 0.42, 8]];
    for (const [dx, dy, sr] of pts) star(c, ix + dx * size, iy + dy * size, sr * (wide ? 1 : 1.15), a.tier === 'SuperRare' ? L.accent : '#8fc0ff');
  }
  // The words.
  const tx = wide ? W * 0.52 : W / 2;
  let ty = wide ? (H - foot) / 2 - 80 : iy + size / 2 + 56;
  c.textAlign = wide ? 'left' : 'center';
  c.textBaseline = 'middle';
  c.font = `600 ${wide ? 24 : 28}px ${TEXT}`;
  const pill = a.label;
  const pw = c.measureText(pill).width + 34;
  const px = wide ? tx : tx - pw / 2;
  rr(c, px, ty - 21, pw, 42, 21); c.fillStyle = `rgba(${L.edge},0.16)`; c.fill(); c.strokeStyle = `rgba(${L.edge},0.55)`; c.lineWidth = 1.5; c.stroke();
  c.fillStyle = L.accent; c.fillText(pill, wide ? px + 17 : tx, ty + 1);
  ty += wide ? 82 : 90;
  c.fillStyle = WHITE;
  let fs = wide ? 86 : 96;
  c.font = `600 ${fs}px ${DISPLAY}`;
  while (c.measureText(a.title).width > (wide ? W * 0.44 : W * 0.86) && fs > 40) { fs -= 4; c.font = `600 ${fs}px ${DISPLAY}`; }
  c.fillText(a.title, tx, ty);
  ty += fs * 0.5 + 34;
  c.font = `500 ${wide ? 26 : 30}px ${NUM}`;
  c.fillStyle = MUTED;
  for (const line of a.lines.slice(0, 3)) { c.fillText(line, tx, ty); ty += wide ? 40 : 46; }
  // The foot: the lockup and the referral code.
  rr(c, 0.5, 0.5, W - 1, H - 1, r); c.strokeStyle = `rgba(${L.edge},0.55)`; c.lineWidth = 1.5; c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(40, H - foot, W - 80, 1);
  const cy = H - foot / 2;
  c.textAlign = 'left';
  lockup(c, 44, cy, wide ? 34 : 42);
  c.textAlign = 'right';
  c.font = `600 ${wide ? 26 : 30}px ${NUM}`;
  c.fillStyle = code ? WHITE : MUTED;
  c.fillText(code ? `Ref ${code}` : 'valuedesk.so', W - 44, cy);
  c.restore();
}
