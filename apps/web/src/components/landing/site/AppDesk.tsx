/**
 * The home page's hero (owner 2026-11-24): the app's own Trade, Copy and Bots pages in 3D, one after the other by itself.
 * Each is ONE picture, tilted and with its tiles lifted already (marketing/video/capture/heroPages.mts, then baked from
 * the 3D scene), so the browser only fades and moves pictures: no 3D layers, no reads. On a phone: the app's phone pages
 * as three phones that change places. The next page comes only once its picture is decoded; all of it rests off screen,
 * in a hidden tab, and under reduced motion.
 */
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { reducedMotion } from '../shared';
import trade from './hero/trade.webp';
import tradeS from './hero/trade-s.webp';
import tradeP from './hero/trade-p.webp';
import copy from './hero/copy.webp';
import copyS from './hero/copy-s.webp';
import copyP from './hero/copy-p.webp';
import bots from './hero/bots.webp';
import botsS from './hero/bots-s.webp';
import botsP from './hero/bots-p.webp';
import './appDesk.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');
const PAGES = [{ l: trade, s: tradeS, p: tradeP }, { l: copy, s: copyS, p: copyP }, { l: bots, s: botsS, p: botsP }];
const EVERY = 5_000;
const PHONE = '(max-width: 700px)';

export function AppDesk() {
  const box = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(0);
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
  /** The other two pictures are asked for a little after the first. */
  const [all, setAll] = useState(false);
  const ready = useRef(new Set<number>());
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
      if (!document.hidden) setAt((x) => (ready.current.has((x + 1) % PAGES.length) ? (x + 1) % PAGES.length : x));
    }, EVERY);
    return () => { window.clearTimeout(t); window.clearInterval(id); };
  }, [on]);
  const loaded = (i: number) => (e: SyntheticEvent<HTMLImageElement>) => { void e.currentTarget.decode().catch(() => {}).then(() => ready.current.add(i)); };
  return (
    <div ref={box} className={cx('ad', phone && 'is-phone')} aria-hidden="true">
      {PAGES.map((p, i) => {
        if (i > 0 && !all) return null;
        const side = (i - at + PAGES.length) % PAGES.length;
        return phone
          ? <img key={`p${i}`} className={cx('ad-ph', side === 0 && 'is-on', side === 1 && 'is-r', side === 2 && 'is-l')} src={p.p} width={258} height={558} alt="" decoding="async" onLoad={loaded(i)} />
          : <img key={i} className={cx('ad-pg', side === 0 && 'is-on')} src={p.l} srcSet={`${p.s} 1200w, ${p.l} 2160w`} sizes="min(1440px, 109vw)" width={1440} height={860} alt="" decoding="async" onLoad={loaded(i)} />;
      })}
    </div>
  );
}
