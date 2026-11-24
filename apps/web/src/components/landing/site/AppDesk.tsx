/**
 * The home page's hero (owner 2026-11-24): the app's own Trade, Copy and Bots pages in 3D, one after the other by itself,
 * and leaning with the mouse. Each page is THREE pictures, tilted already (marketing/video/capture/heroBake.mjs): the page
 * with its tiles cut out, the tiles, the front tiles. The picture plane turns with the pointer and the layers move against
 * each other by their depth, so there is real depth from three composited layers - nothing is laid out or painted while
 * it moves, and it reads nothing. On a phone: the app's phone pages as three phones that change places, swaying slowly.
 * The next page comes only once its pictures are decoded; all of it rests off screen, in a hidden tab, and under reduced
 * motion.
 */
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { liteDevice, reducedMotion } from '../shared';
import trade0 from './hero/trade-0.webp';
import trade0s from './hero/trade-0-s.webp';
import trade1 from './hero/trade-1.webp';
import trade1s from './hero/trade-1-s.webp';
import trade2 from './hero/trade-2.webp';
import trade2s from './hero/trade-2-s.webp';
import tradeP from './hero/trade-p.webp';
import copy0 from './hero/copy-0.webp';
import copy0s from './hero/copy-0-s.webp';
import copy1 from './hero/copy-1.webp';
import copy1s from './hero/copy-1-s.webp';
import copy2 from './hero/copy-2.webp';
import copy2s from './hero/copy-2-s.webp';
import copyP from './hero/copy-p.webp';
import bots0 from './hero/bots-0.webp';
import bots0s from './hero/bots-0-s.webp';
import bots1 from './hero/bots-1.webp';
import bots1s from './hero/bots-1-s.webp';
import bots2 from './hero/bots-2.webp';
import bots2s from './hero/bots-2-s.webp';
import botsP from './hero/bots-p.webp';
import './appDesk.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const PAGES: Array<{ p: string; layers: Array<[l: string, s: string]> }> = [
  { p: tradeP, layers: [[trade0, trade0s], [trade1, trade1s], [trade2, trade2s]] },
  { p: copyP, layers: [[copy0, copy0s], [copy1, copy1s], [copy2, copy2s]] },
  { p: botsP, layers: [[bots0, bots0s], [bots1, bots1s], [bots2, bots2s]] },
];
const EVERY = 5_000;
const PHONE = '(max-width: 700px)';

export function AppDesk() {
  const box = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(0);
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
  /** The other two pictures are asked for a little after the first. */
  const [all, setAll] = useState(false);
  /** How many of a page's pictures are decoded. */
  const ready = useRef(new Map<number, number>());
  useEffect(() => {
    const m = matchMedia(PHONE);
    const f = () => { ready.current.clear(); setPhone(m.matches); };
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOn(!!e?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!on || reducedMotion()) return;
    const t = window.setTimeout(() => setAll(true), 1_500);
    const id = window.setInterval(() => {
      if (!document.hidden) setAt((x) => ((ready.current.get((x + 1) % PAGES.length) ?? 0) >= (phone ? 1 : 3) ? (x + 1) % PAGES.length : x));
    }, EVERY);
    return () => { window.clearTimeout(t); window.clearInterval(id); };
  }, [on, phone]);
  // The pointer: followed softly, one frame at a time, and only until it has arrived.
  useEffect(() => {
    const el = box.current;
    if (!el || !on || phone || reducedMotion() || liteDevice() || !matchMedia('(pointer: fine)').matches) return;
    let raf = 0, x = 0, y = 0, tx = 0, ty = 0;
    const step = () => {
      x += (tx - x) * 0.09;
      y += (ty - y) * 0.09;
      const there = Math.abs(tx - x) + Math.abs(ty - y) < 0.002;
      if (there) { x = tx; y = ty; }
      el.style.setProperty('--mx', x.toFixed(4));
      el.style.setProperty('--my', y.toFixed(4));
      raf = there ? 0 : requestAnimationFrame(step);
    };
    const to = (nx: number, ny: number) => { tx = nx; ty = ny; if (!raf) raf = requestAnimationFrame(step); };
    const move = (e: PointerEvent) => to((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    const out = () => to(0, 0);
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', out);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointermove', move); document.documentElement.removeEventListener('pointerleave', out); };
  }, [on, phone]);
  const loaded = (i: number) => (e: SyntheticEvent<HTMLImageElement>) => { void e.currentTarget.decode().catch(() => {}).then(() => ready.current.set(i, (ready.current.get(i) ?? 0) + 1)); };
  return (
    <div ref={box} className={cx('ad', phone && 'is-phone', !on && 'is-off')} aria-hidden="true">
      <div className="ad-plane">
        {PAGES.map((p, i) => {
          if (i > 0 && !all) return null;
          const side = (i - at + PAGES.length) % PAGES.length;
          if (phone) return <img key={`p${i}`} className={cx('ad-ph', side === 0 && 'is-on', side === 1 && 'is-r', side === 2 && 'is-l')} src={p.p} width={258} height={558} alt="" decoding="async" onLoad={loaded(i)} />;
          return (
            <div key={i} className={cx('ad-pg', side === 0 && 'is-on')}>
              {p.layers.map(([l, s], n) => <div key={n} className={`ad-l is-${n}`}><img src={l} srcSet={`${s} 1200w, ${l} 2160w`} sizes="min(1440px, 109vw)" width={1440} height={860} alt="" decoding="async" onLoad={loaded(i)} /></div>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
