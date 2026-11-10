/**
 * Share being VIP, or the move to the VIP servers (owner 2026-11-08): a popup with the card as it will look, as an
 * image or a looping GIF, to copy, download or hand to the device's share sheet. Drawn in the browser on a canvas
 * in the VIP scenes' look (dot grid, outlined VALUE / DESK, gold lines, the gold mark and the pass), so nothing is
 * uploaded and nothing on a server needs a rate limit; one card is drawn at a time.
 */
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { encodeGif } from '../../bots/gif';
import { Icon, Segmented } from './kit/kit';

export type ShareWhat = { kind: 'unlock'; promo: boolean } | { kind: 'move'; bots: number; secs: number };

const W = 1200;
const H = 675;
const GIF_W = 600;
const GIF_H = 338;
const GIF_FRAMES = 24;
const GIF_DELAY = 70;
const URL_TEXT = 'valuedesk.so';

const COLS = [0, 4, 1, 3, 2];
const ROWS = [0, 0, 1, 1, 2];

function goldFill(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): CanvasGradient {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, '#fff1c2'); g.addColorStop(0.45, '#f6dc8e'); g.addColorStop(0.75, '#d4a748'); g.addColorStop(1, '#fbe3a0');
  return g;
}

function mark(c: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const u = size / 32;
  c.fillStyle = goldFill(c, x, y, x + size, y + size);
  COLS.forEach((col, i) => { c.beginPath(); c.roundRect(x + col * 6.6 * u, y + (4.2 + ROWS[i]! * 8.2) * u, 5.6 * u, 7.2 * u, 1.5 * u); c.fill(); });
}

function lines(what: ShareWhat): { head: string; gold: string; sub: string; pill: string; pass: string; rows: string[] } {
  if (what.kind === 'move') {
    return {
      head: 'My bots moved to VIP.', gold: 'VIP servers, 1.6× faster.',
      sub: `${what.bots === 1 ? '1 bot' : `${what.bots} bots`} moved in ${what.secs.toFixed(1)} s, books and all. Nothing closed.`,
      pill: 'VIP servers', pass: 'Dedicated servers', rows: ['Orders 1.6× faster', 'Latency down 37%', 'Moved in one signature'],
    };
  }
  return what.promo
    ? { head: 'I am VIP on ValueDesk.', gold: 'Upgraded for 30 days.', sub: 'The lowest fees on futures, spot, copy trading and bots, and VIP servers.', pill: '30 days', pass: 'Early access pass', rows: ['Lowest fees everywhere', 'VIP servers', 'Early access'] }
    : { head: 'I am VIP on ValueDesk.', gold: 'Bot fees slashed.', sub: '$5M traded in 14 days: the lowest bot fee and the VIP servers.', pill: '$5M · 14 days', pass: 'Volume milestone', rows: ['Bot fees down to 0.1 bp', 'VIP servers', 'Orders 1.6× faster'] };
}

/** The card at time t (0..1 loops: the glare's sweep and the gold lines' run), drawn at W x H scaled by `k`. */
function draw(c: CanvasRenderingContext2D, what: ShareWhat, t: number, k: number): void {
  const L = lines(what);
  c.save();
  c.scale(k, k);
  // Ground: ink, a soft gold light toward the pass, the dot grid.
  c.fillStyle = '#0b0b0b'; c.fillRect(0, 0, W, H);
  let g = c.createRadialGradient(820, 300, 0, 820, 300, 620);
  g.addColorStop(0, 'rgba(212,167,72,0.24)'); g.addColorStop(1, 'rgba(212,167,72,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(255,255,255,0.08)';
  for (let y = 22; y < H; y += 44) for (let x = 22; x < W; x += 44) { c.beginPath(); c.arc(x, y, 1.4, 0, Math.PI * 2); c.fill(); }
  // Outlined VALUE (left, drifting up) and DESK (right, drifting down).
  c.font = '700 150px "Space Grotesk", sans-serif';
  c.strokeStyle = 'rgba(246,220,142,0.11)'; c.lineWidth = 1.5;
  const drift = t * 140;
  c.save(); c.translate(150, H + 60 - drift); c.rotate(-Math.PI / 2); c.strokeText('VALUE VALUE', 0, 0); c.restore();
  c.save(); c.translate(W - 150, -200 + drift); c.rotate(Math.PI / 2); c.strokeText('DESK DESK', 0, 0); c.restore();
  // Gold lines running along the grid.
  const run = (x: number, y: number, len: number, vert: boolean, phase: number) => {
    const p = (t + phase) % 1;
    const off = -60 + p * 200;
    const a = Math.sin(p * Math.PI);
    const lg = vert ? c.createLinearGradient(0, y + off, 0, y + off + len) : c.createLinearGradient(x + off, 0, x + off + len, 0);
    lg.addColorStop(0, 'rgba(246,220,142,0)'); lg.addColorStop(0.5, `rgba(246,220,142,${0.85 * a})`); lg.addColorStop(1, 'rgba(246,220,142,0)');
    c.fillStyle = lg;
    if (vert) c.fillRect(x, y + off, 2, len); else c.fillRect(x + off, y, len, 2);
  };
  run(120, 64, 150, false, 0); run(860, 30, 110, false, 0.35); run(470, 640, 120, false, 0.6); run(1130, 470, 120, true, 0.2); run(40, 360, 100, true, 0.75);

  // Left: lockup, the words, the address.
  mark(c, 96, 150, 56);
  c.fillStyle = 'rgba(255,255,255,0.22)'; c.fillRect(170, 156, 1, 44);
  c.fillStyle = '#ffffff'; c.font = '600 32px "Space Grotesk", sans-serif'; c.textBaseline = 'middle'; c.fillText('ValueDesk', 188, 179);
  c.textBaseline = 'alphabetic';
  // The two lines share one size, the largest at which both fit left of the pass.
  let fs = 58;
  const fits = () => { c.font = `600 ${fs}px "Space Grotesk", sans-serif`; return Math.max(c.measureText(L.head).width, c.measureText(L.gold).width) <= 540; };
  while (fs > 34 && !fits()) fs -= 2;
  // The size the loop settled on (it can stop at 34 without measuring it, leaving the last size tried set).
  c.font = `600 ${fs}px "Space Grotesk", sans-serif`;
  c.fillStyle = '#ffffff'; c.fillText(L.head, 96, 300);
  c.fillStyle = goldFill(c, 96, 320, 600, 380); c.fillText(L.gold, 96, 300 + fs * 1.15);
  c.font = '400 21px "IBM Plex Sans", sans-serif'; c.fillStyle = 'rgba(255,255,255,0.62)';
  wrap(c, L.sub, 96, 300 + fs * 1.15 + 56, 520, 30);
  c.font = '500 22px "IBM Plex Sans", sans-serif'; c.fillStyle = 'rgba(248,231,181,0.8)'; c.fillText(URL_TEXT, 96, 580);

  // Right: the gold pass, tilted a touch, with a glare passing over it.
  c.save();
  c.translate(860, 340); c.rotate(-0.035); c.translate(-180, -230);
  const pw = 360, ph = 460;
  c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 60; c.shadowOffsetY = 30;
  const metal = c.createLinearGradient(0, 0, pw, ph);
  metal.addColorStop(0, '#5a4214'); metal.addColorStop(0.34, '#2a1f0b'); metal.addColorStop(0.52, '#3d2d10'); metal.addColorStop(0.74, '#7a5a1e'); metal.addColorStop(1, '#2b200c');
  c.beginPath(); c.roundRect(0, 0, pw, ph, 26); c.fillStyle = metal; c.fill();
  c.shadowColor = 'transparent';
  c.strokeStyle = 'rgba(246,220,142,0.4)'; c.lineWidth = 1.5; c.stroke();
  c.save(); c.beginPath(); c.roundRect(0, 0, pw, ph, 26); c.clip();
  const gx = -pw + t * pw * 3;
  g = c.createLinearGradient(gx, 0, gx + pw * 0.6, ph * 0.3);
  g.addColorStop(0, 'rgba(255,241,194,0)'); g.addColorStop(0.5, 'rgba(255,241,194,0.22)'); g.addColorStop(1, 'rgba(255,241,194,0)');
  c.fillStyle = g; c.fillRect(0, 0, pw, ph);
  c.restore();
  mark(c, 28, 28, 34);
  c.font = '500 16px "Asap", "IBM Plex Sans", sans-serif';
  const pillW = c.measureText(L.pill).width + 28;
  c.fillStyle = 'rgba(246,220,142,0.16)'; c.beginPath(); c.roundRect(pw - 28 - pillW, 28, pillW, 32, 16); c.fill();
  c.fillStyle = '#f8e7b5'; c.textBaseline = 'middle'; c.fillText(L.pill, pw - 28 - pillW + 14, 45); c.textBaseline = 'alphabetic';
  c.font = '700 120px "Space Grotesk", sans-serif'; c.fillStyle = goldFill(c, 28, 90, 260, 210); c.fillText('VIP', 24, 196);
  c.font = '400 18px "IBM Plex Sans", sans-serif'; c.fillStyle = 'rgba(248,231,181,0.62)'; c.fillText(L.pass, 30, 232);
  L.rows.forEach((row, i) => {
    const y = 262 + i * 62;
    c.fillStyle = 'rgba(246,220,142,0.2)'; c.fillRect(28, y, pw - 56, 1);
    c.fillStyle = goldFill(c, 28, y + 14, 64, y + 50); c.beginPath(); c.roundRect(28, y + 13, 36, 36, 10); c.fill();
    c.font = '600 20px "Space Grotesk", sans-serif'; c.fillStyle = '#fff8e6'; c.fillText(row, 80, y + 38);
  });
  c.restore();
  c.restore();
}

function wrap(c: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lh: number): void {
  let line = '';
  for (const w of text.split(' ')) {
    const next = line ? `${line} ${w}` : w;
    if (c.measureText(next).width > max && line) { c.fillText(line, x, y); line = w; y += lh; } else line = next;
  }
  if (line) c.fillText(line, x, y);
}

async function fontsReady(): Promise<void> {
  try {
    await Promise.all(['700 120px "Space Grotesk"', '600 58px "Space Grotesk"', '400 21px "IBM Plex Sans"', '500 16px "Asap"'].map((f) => document.fonts.load(f)));
  } catch { /* the fallbacks draw */ }
}

async function makePng(what: ShareWhat): Promise<Blob> {
  await fontsReady();
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  draw(cv.getContext('2d')!, what, 0.42, 1);
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('The image could not be made.'))), 'image/png'));
}

async function makeGif(what: ShareWhat): Promise<Blob> {
  await fontsReady();
  const cv = document.createElement('canvas');
  cv.width = GIF_W; cv.height = GIF_H;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  const frames: ImageData[] = [];
  for (let i = 0; i < GIF_FRAMES; i++) {
    draw(c, what, i / GIF_FRAMES, GIF_W / W);
    frames.push(c.getImageData(0, 0, GIF_W, GIF_H));
  }
  return encodeGif(frames, GIF_W, GIF_H, GIF_DELAY);
}

type Format = 'image' | 'gif';

export function VipShare({ what, onClose }: { what: ShareWhat; onClose: () => void }) {
  const [format, setFormat] = useState<Format>('image');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const made = useRef(new Map<Format, Blob>());
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const have = made.current.get(format);
    setBusy(!have);
    (have ? Promise.resolve(have) : format === 'gif' ? makeGif(what) : makePng(what))
      .then((b) => {
        if (!live) return;
        made.current.set(format, b);
        setBlob(b);
        setUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b); });
        setBusy(false);
      })
      .catch((e) => { if (live) { setBusy(false); setNote(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [format, what]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const name = `valuedesk-${what.kind === 'move' ? 'vip-servers' : 'vip'}.${format === 'gif' ? 'gif' : 'png'}`;
  const file = blob ? new File([blob], name, { type: blob.type }) : null;
  const canShare = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });

  // What the last copy did, said in the popup for a few seconds (not a toast that stays).
  const noteTimer = useRef(0);
  const say = (t: string) => { setNote(t); window.clearTimeout(noteTimer.current); noteTimer.current = window.setTimeout(() => setNote(null), 4500); };
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);
  const copy = async () => {
    if (!blob) return;
    // Most browsers take only PNG on the clipboard: a GIF is copied as the still card there, and downloads animated.
    const gifOk = format !== 'gif' || (typeof ClipboardItem !== 'undefined' && typeof ClipboardItem.supports === 'function' && ClipboardItem.supports('image/gif'));
    try {
      const b = gifOk ? blob : made.current.get('image') ?? await makePng(what);
      if (!gifOk) made.current.set('image', b);
      await navigator.clipboard.write([new ClipboardItem({ [b.type]: b })]);
      say(format === 'gif' ? (gifOk ? 'GIF copied.' : 'Copied as a still image: this browser copies GIFs as PNG. Download keeps the animation.') : 'Image copied.');
    } catch {
      say('This browser did not allow copying. Download it instead.');
    }
  };
  const download = () => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
  };
  const shareSheet = async () => {
    if (!file) return;
    try { await navigator.share({ files: [file], text: what.kind === 'move' ? 'My bots run on the VIP servers.' : 'I am VIP on ValueDesk.', url: `https://${URL_TEXT}` }); } catch { /* closed */ }
  };

  return (
    <Modal open title={what.kind === 'move' ? 'Share your move to VIP' : 'Share your VIP'} onClose={onClose} size="md" className="vipshare">
      <div className="vipshare__bar">
        <Segmented value={format} label="Format" onChange={(v) => setFormat(v as Format)} options={[{ value: 'image', label: 'Image' }, { value: 'gif', label: 'GIF' }]} />
        <small>{format === 'gif' ? 'Animated, loops' : 'PNG, 1200 × 675'}</small>
      </div>
      <div className={`vipshare__preview${busy ? ' is-busy' : ''}`}>
        {url && <img src={url} alt={what.kind === 'move' ? 'Card: my bots moved to the VIP servers' : 'Card: I am VIP on ValueDesk'} />}
        {busy && <span className="vipshare__busy">{format === 'gif' ? 'Making the GIF…' : 'Drawing…'}</span>}
      </div>
      <div className="vipshare__act">
        <button type="button" className="vipx-cta" disabled={!blob || busy} onClick={() => void copy()}><Icon name="layers" size={15} />Copy</button>
        <button type="button" className="vipx-later" disabled={!blob || busy} onClick={download}><Icon name="down" size={14} />Download</button>
        {canShare && <button type="button" className="vipx-icon" aria-label="Share" title="Share" disabled={busy} onClick={() => void shareSheet()}><Icon name="share" size={17} /></button>}
      </div>
      {note ? <p className="vipshare__note" role="status">{note}</p> : <p className="vipshare__fine">Made in your browser: nothing is uploaded.</p>}
    </Modal>
  );
}
