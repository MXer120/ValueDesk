/**
 * A trader, opened from the Copy page (owner 2026-11-27: "when clicking on a wallet dont go directly to scan, there
 * should be a very big, but not fullscreen, pop up, needs to be able to be made into a sidebar in the top right, is
 * just like the scan page. Smooth open and close."). The Scan page itself (dashboard/ScanDashboard ScanEmbed: the same
 * header, venues and panels) in a large window over the page; one button docks it as a sidebar at the top right, where
 * the page beside it stays usable, and back. It glides between the two (one transform, no layout per frame), eases in
 * and out, and closes with Escape, the backdrop or its close button. "Scan" opens the full page. On a phone it is a
 * sheet from the bottom, without the dock.
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStored } from '../../hooks';
import { VenueLogo } from '../VenueLogo';
import type { Venue } from '../../vsApi';
import type { PortfolioProps } from '../Portfolio';
import { Button, Icon, IconButton } from '../bots/kit/kit';

const ScanEmbed = lazy(() => import('../../dashboard/ScanDashboard').then((m) => ({ default: m.ScanEmbed })));

export interface PeekTarget { address: string; venue: Venue }
export type ScanCtx = Omit<PortfolioProps, 'address'> & { address: string | null };

const VENUE_NAME: Record<string, string> = { sodex: 'SoDEX', hyperliquid: 'Hyperliquid', tradexyz: 'trade.xyz', lighter: 'Lighter', arcus: 'Arcus' };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** The way out (Copy.css .cpk: --cpk-out). */
const OUT_MS = 240;
/** The glide between window and sidebar. */
const GLIDE_MS = 360;
const PHONE = '(max-width: 760px)';
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where the sidebar starts: under the top bar while it is on screen, else 12px from the window's top. */
function topEdge(): number {
  const bar = document.querySelector('.navbar');
  const b = bar ? bar.getBoundingClientRect().bottom : 0;
  return Math.max(12, Math.round(b) + 8);
}

export function TraderPeek({ target, ctx, onClose, onOpenScan }: { target: PeekTarget | null; ctx: ScanCtx | null; onClose: () => void; onOpenScan: (t: PeekTarget) => void }) {
  const [docked, setDocked] = useStored<boolean>('vs.copy.peek.docked', false);
  // The trader stays on screen while the panel leaves.
  const [shown, setShown] = useState<PeekTarget | null>(target);
  const [inView, setInView] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const from = useRef<DOMRect | null>(null);

  useEffect(() => {
    if (target) {
      setShown(target);
      const f = requestAnimationFrame(() => requestAnimationFrame(() => setInView(true)));
      return () => cancelAnimationFrame(f);
    }
    setInView(false);
    const t = window.setTimeout(() => setShown(null), OUT_MS);
    return () => window.clearTimeout(t);
  }, [target]);

  const open = target != null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    panel.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /* Docked, the sidebar starts under the top bar, and rises with it as the page beside it scrolls (one style write a
   * frame, no render). */
  useLayoutEffect(() => {
    if (!shown) return;
    let f = 0;
    const place = () => { f = 0; root.current?.style.setProperty('--cpk-top', `${topEdge()}px`); };
    const soon = () => { if (!f) f = requestAnimationFrame(place); };
    place();
    window.addEventListener('resize', soon);
    document.addEventListener('scroll', soon, { capture: true, passive: true });
    return () => { cancelAnimationFrame(f); window.removeEventListener('resize', soon); document.removeEventListener('scroll', soon, { capture: true }); };
  }, [shown]);

  // As a window (and as a phone's sheet) it holds the page still behind it; docked, the page beside it scrolls as ever.
  useEffect(() => {
    if (!open || (docked && !window.matchMedia(PHONE).matches)) return;
    const html = document.documentElement;
    const was = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = was; };
  }, [open, docked]);

  // Docked, the page makes room for the sidebar (Copy.css html.cpk-docked).
  useEffect(() => {
    if (!open || !docked) return;
    const html = document.documentElement;
    html.classList.add('cpk-docked');
    return () => html.classList.remove('cpk-docked');
  }, [open, docked]);

  /* The glide: the panel takes its new place at once and is drawn from where it was (one uniform scale, so the page
   * inside is never stretched), then moves home. */
  const toggle = useCallback(() => {
    from.current = panel.current?.getBoundingClientRect() ?? null;
    setDocked(!docked);
  }, [docked, setDocked]);
  useLayoutEffect(() => {
    const el = panel.current, a = from.current;
    from.current = null;
    if (!el || !a || still()) return;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return;
    const k = Math.sqrt((a.width * a.height) / (b.width * b.height));
    const dx = a.left + a.width / 2 - (b.left + b.width / 2);
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0.55 }, { transform: 'none', opacity: 1 }],
      { duration: GLIDE_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [docked]);

  if (!shown || !ctx) return null;
  const name = VENUE_NAME[shown.venue] ?? shown.venue;
  return createPortal(
    <div ref={root} className={`cpk${docked ? ' is-docked' : ' is-window'}${inView ? ' is-in' : ''}`}>
      <div className="cpk__veil" onClick={onClose} aria-hidden="true" />
      <section ref={panel} className="cpk__panel" role="dialog" aria-modal={!docked} aria-label={`Trader ${short(shown.address)} on ${name}`} tabIndex={-1}>
        <header className="cpk__h tf">
          <span className="cpk__who">
            <VenueLogo venue={shown.venue} size={18} />
            <b className="sx-num">{short(shown.address)}</b>
            <small>{name}</small>
          </span>
          <span className="cpk__acts">
            <Button variant="quiet" icon={docked ? 'window' : 'dock'} className="cpk__dock" onClick={toggle} title={docked ? 'Open as a window' : 'Dock to the right side'}>
              {docked ? 'Window' : 'Dock'}
            </Button>
            <Button variant="secondary" className="cpk__scan" onClick={() => onOpenScan(shown)} title="Open this wallet on the Scan page">Scan<Icon name="arrowRight" size={14} /></Button>
            <IconButton icon="x" label="Close" onClick={onClose} />
          </span>
        </header>
        <div className="cpk__body">
          <Suspense fallback={<div className="cpk__wait" aria-busy="true" aria-label="Loading the wallet"><span /><span /><span /></div>}>
            <ScanEmbed {...ctx} embed={shown} />
          </Suspense>
        </div>
      </section>
    </div>,
    document.body,
  );
}
