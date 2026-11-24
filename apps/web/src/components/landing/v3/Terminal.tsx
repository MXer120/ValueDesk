/**
 * Version 3's hero (owner 2026-11-24: "the full pages trade, copytrading & bots"): the app's own Trade, Copy and Bots
 * pages in 3D. Each page is ONE picture of the real page (marketing/video/capture/heroPages.mts, a demo account), shown
 * as a slab with its panels cut out of the same picture and lifted above it - so the navbar, the rail, the order panel
 * and every row are exactly the app's. No reads of any kind; the other two pages' pictures load once the first is in.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { liteDevice, reducedMotion } from '../shared';
import tradeL from './hero/trade.webp';
import tradeS from './hero/trade-s.webp';
import copyL from './hero/copy.webp';
import copyS from './hero/copy-s.webp';
import botsL from './hero/bots.webp';
import botsS from './hero/bots-s.webp';
import './terminal.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
/** The pictures' own size, and the size they are drawn at. */
const PW = 1920;
const W = 1240;
const K = W / PW;

/** A panel: its box in the picture (x, y, width, height), how far it stands above the page, its corner, and the height it is cut out at (a row of another panel: that one's). */
type Panel = [x: number, y: number, w: number, h: number, z: number, r?: number, cut?: number];
interface Page { id: 'trade' | 'copy' | 'bots'; t: string; l: string; s: string; panels: Panel[] }

const cards = (): Panel[] => [0, 1].flatMap((row) => [0, 1, 2, 3, 4].map((i): Panel => [150 + [0, 340, 681, 1021, 1362][i]!, 517 + row * 242, 326, 228, [44, 30, 58, 36, 50][(i + row * 2) % 5]!, 14]));

const PAGES: Page[] = [
  { id: 'trade', t: 'Trade', l: tradeL, s: tradeS, panels: [
    [72, 6, 1844, 48, 34, 12], [72, 60, 1074, 63, 34, 12], [72, 127, 1074, 604, 34, 14], [72, 735, 1459, 333, 44, 14], [1150, 60, 381, 671, 54, 14], [1535, 735, 381, 333, 64, 14], [1535, 60, 381, 671, 78, 14],
  ] },
  { id: 'copy', t: 'Copy trading', l: copyL, s: copyS, panels: cards() },
  { id: 'bots', t: 'Bots', l: botsL, s: botsS, panels: [
    [374, 228, 848, 787, 18, 18], [397, 291, 802, 100, 32, 12, 18.5], [397, 397, 802, 100, 32, 12, 18.5], [397, 681, 802, 100, 32, 12, 18.5], [397, 787, 802, 100, 32, 12, 18.5], [397, 892, 802, 100, 32, 12, 18.5], [397, 502, 802, 173, 50, 12, 18.5], [1234, 228, 380, 837, 78, 18],
  ] },
];

const box = ([x, y, w, h, , r]: Panel): CSSProperties => ({ left: x * K, top: y * K, width: w * K, height: h * K, borderRadius: (r ?? 12) * K });

export function TerminalDesk() {
  const wrap = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const [small, setSmall] = useState(() => window.innerWidth * Math.min(2, devicePixelRatio || 1) <= 1300);
  /** The pictures asked for: the first at once, the others when it is in (or when picked). */
  const [asked, setAsked] = useState<ReadonlySet<number>>(() => new Set([0]));
  useEffect(() => {
    const b = wrap.current;
    const r = rig.current;
    if (!b || !r) return;
    const fit = () => {
      const s = Math.min(1, b.clientWidth / r.offsetWidth);
      b.style.setProperty('--s', s.toFixed(4));
      b.style.height = `${Math.round(r.offsetHeight * s)}px`;
      setSmall(b.clientWidth * Math.min(2, devicePixelRatio || 1) <= 1300);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    const io = new IntersectionObserver(([e]) => setOn(!!e?.isIntersecting), { rootMargin: '100px' });
    io.observe(b);
    return () => { ro.disconnect(); io.disconnect(); };
  }, []);
  // The other two pictures, once the page has the first on screen and time to spare.
  useEffect(() => {
    if (!on || asked.size === PAGES.length) return;
    const id = window.setTimeout(() => setAsked(new Set([0, 1, 2])), 2_500);
    return () => window.clearTimeout(id);
  }, [on, asked]);
  useEffect(() => {
    if (!on || held || reducedMotion()) return;
    const id = window.setInterval(() => setAt((x) => (x + 1) % PAGES.length), 5_500);
    return () => window.clearInterval(id);
  }, [on, held]);
  useEffect(() => {
    const b = wrap.current;
    if (!b || !on || reducedMotion() || liteDevice() || !matchMedia('(pointer: fine)').matches) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        b.style.setProperty('--mx', (e.clientX / window.innerWidth - 0.5).toFixed(3));
        b.style.setProperty('--my', (e.clientY / window.innerHeight - 0.5).toFixed(3));
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, [on]);
  const pick = (i: number) => { setHeld(true); setAsked((x) => new Set([...x, i])); setAt(i); };
  return (
    <div className="tm">
      <div className="tm-sw" role="group" aria-label="Page shown">
        {PAGES.map((p, i) => <button key={p.id} type="button" aria-pressed={i === at} className={cx(i === at && 'is-on')} onClick={() => pick(i)}>{p.t}</button>)}
      </div>
      <div ref={wrap} className="tm-box" aria-hidden="true">
        <div ref={rig} className="tm-rig"><div className="tm-tilt">
          {PAGES.map((p, i) => {
            const img = asked.has(i) ? `url(${small ? p.s : p.l})` : undefined;
            return (
              <div key={p.id} className={cx('tm-page', i === at && 'is-on')} style={{ backgroundImage: img }}>
                {p.panels.map((b, n) => <span key={n} className="tm-hole" style={{ ...box(b), transform: b[6] ? `translateZ(${b[6]}px)` : undefined }} />)}
                {p.panels.map((b, n) => (
                  <span key={n} className="tm-pane" style={{ ...box(b), '--z': b[4], '--i': n, backgroundImage: img, backgroundPosition: `${-b[0] * K}px ${-b[1] * K}px` } as CSSProperties} />
                ))}
              </div>
            );
          })}
        </div></div>
      </div>
      <p className="tm-note">The app's own pages, with a demo account.</p>
    </div>
  );
}
