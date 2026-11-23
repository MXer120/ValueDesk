/**
 * The marketing site's shell (owner 2026-11-23): one nav with a Products dropdown that leads to real pages (bots, copy
 * trading, analytics, cross-venue) plus Pricing and FAQ, V1's footer (the owner liked it), and the parts every page of
 * the site shares. Root class `h vd`: V1's vocabulary applies; borrowed sections of versions 2-4 go in <Embed>.
 *
 * Paths: the versions are /home/5..7, the pages /home/<page>. The logo and FAQ go back to the version the visitor came
 * from (kept for the tab in sessionStorage), so a review on localhost stays on the version under review.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandMark } from '../../BrandMark';
import { dropBootShell } from '../../../bootShell';
import { Arrow, Reveal } from '../Home';
import { HeatGlass } from '../v4/heat';
import { FeatureFx } from '../v3/V3';
import '../v3/v3.css';
import { bp, FEES, startFromText, useLiveDesk } from '../shared';
import '../home.css';
import './site.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

/* ---------------------------------------------------------------------------------------------- paths ----- */

export const PAGE_PATHS = { bots: '/home/bots', copy: '/home/copy-trading', analytics: '/home/analytics', cross: '/home/cross-venue', pricing: '/home/fees' } as const;
const HOME_KEY = 'vd.home';
/** The landing version this tab came from (/home/5 ...), for the logo and the FAQ link. */
export function homePath(): string {
  try { return sessionStorage.getItem(HOME_KEY) ?? '/home'; } catch { return '/home'; }
}
export function rememberHome(path: string): void {
  try { sessionStorage.setItem(HOME_KEY, path); } catch { /* storage off: the logo goes to /home */ }
}

/* ---------------------------------------------------------------------------------------------- icons ----- */

export const IC = {
  bot: <svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="3.5" /><path d="M12 7V4" /><circle cx="9" cy="12.6" r="1" /><circle cx="15" cy="12.6" r="1" /><path d="M9.5 16h5" /></svg>,
  copy: <svg viewBox="0 0 24 24"><path d="M3 16c3-6 5-8 8-4s5 2 9-5" /><path d="M3 20c3-6 5-8 8-4s5 2 9-5" opacity=".45" /></svg>,
  heat: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M3 14h18" opacity=".5" /><path d="M6 17l4-5 3 2 5-6" /></svg>,
  cross: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.6" /><circle cx="4.5" cy="6" r="1.8" /><circle cx="19.5" cy="6" r="1.8" /><circle cx="4.5" cy="18" r="1.8" /><circle cx="19.5" cy="18" r="1.8" /><path d="M6 7l4 3.4M18 7l-4 3.4M6 17l4-3.4M18 17l-4-3.4" /></svg>,
  tag: <svg viewBox="0 0 24 24"><path d="M3.5 12.2V4h8.2l8.8 8.8-8.2 8.2-8.8-8.8Z" /><circle cx="8" cy="8.5" r="1.4" /></svg>,
  check: <svg viewBox="0 0 20 20"><path d="m5 10.4 3.2 3.1L15 6.7" /></svg>,
  chevron: <svg viewBox="0 0 12 12"><path d="M3 4.5 6 7.5 9 4.5" /></svg>,
  menu: <svg viewBox="0 0 24 24"><path d="M4 8h16M4 16h16" /></svg>,
  close: <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>,
};

export const PRODUCTS = [
  { key: 'bots', href: PAGE_PATHS.bots, t: 'Bots', s: 'Market maker and grid bots on SoDEX, running around the clock', ic: IC.bot },
  { key: 'copy', href: PAGE_PATHS.copy, t: 'Copy trading', s: 'Follow any Hyperliquid or SoDEX wallet at your size', ic: IC.copy },
  { key: 'analytics', href: PAGE_PATHS.analytics, t: 'Analytics', s: 'Liquidation map, who traded each candle, news and calendar. Free', ic: IC.heat },
  { key: 'cross', href: PAGE_PATHS.cross, t: 'Cross-venue', s: 'Five venues side by side: traders, liquidations, funding', ic: IC.cross },
] as const;

/* ------------------------------------------------------------------------------------------------ nav ----- */

export function SiteNav({ current }: { current?: string }) {
  const [solid, setSolid] = useState(false);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const dd = useRef<HTMLDivElement>(null);
  const closeT = useRef(0);
  const live = useLiveDesk();
  useEffect(() => {
    const s = () => setSolid(window.scrollY > 12);
    s();
    window.addEventListener('scroll', s, { passive: true });
    return () => window.removeEventListener('scroll', s);
  }, []);
  useEffect(() => {
    if (!open && !sheet) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setSheet(false); } };
    const click = (e: MouseEvent) => { if (dd.current && !dd.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', click);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousedown', click); };
  }, [open, sheet]);
  useEffect(() => { document.body.style.overflow = sheet ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [sheet]);
  const enter = () => { window.clearTimeout(closeT.current); setOpen(true); };
  const leave = () => { closeT.current = window.setTimeout(() => setOpen(false), 160); };
  const home = homePath();
  const start = startFromText(live.startFrom);

  return (
    <header className={cx('vd-nav', solid && 'is-solid')}>
      <div className="vd-nav__in">
        <a href={home} className="h-logo"><BrandMark size={22} /><span>ValueDesk</span></a>
        <nav className="vd-links" aria-label="Site">
          <div ref={dd} className={cx('vd-dd', open && 'is-open')} onMouseEnter={enter} onMouseLeave={leave}>
            <button type="button" className="vd-dd__btn" aria-expanded={open} aria-controls="vd-products" onClick={() => setOpen((o) => !o)}>Products{IC.chevron}</button>
            <div id="vd-products" className="vd-dd__panel" role="menu">
              {PRODUCTS.map((p) => (
                <a key={p.key} href={p.href} className="vd-dd__item" role="menuitem">
                  <span className="vd-ic">{p.ic}</span>
                  <div><b>{p.t}</b><span>{p.s}</span></div>
                </a>
              ))}
              <a href="/bots/new" className="vd-dd__feat" role="menuitem">
                <HeatGlass layout="card" rib={18} />
                <small>Bots on SoDEX</small>
                <b>Start with {start}</b>
                <small>From {bp(FEES.botLowest)} per order (VIP)</small>
              </a>
            </div>
          </div>
          <a href={PAGE_PATHS.pricing} className={cx(current === 'fees' && 'is-on')}>Fees</a>
          <a href="/points">SoPoints</a>
          <a href={`${home}#faq`}>FAQ</a>
        </nav>
        <div className="vd-nav__cta">
          <a href="/trade" className="h-btn is-glass is-sm">Open app</a>
          <a href="/bots/new" className="h-btn is-light is-sm">Start a bot<Arrow /></a>
          <button type="button" className="vd-burger" aria-label="Menu" onClick={() => setSheet(true)}>{IC.menu}</button>
        </div>
      </div>
      {sheet && (
        <div className="vd-sheet" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="vd-sheet__top">
            <a href={home} className="h-logo"><BrandMark size={22} /><span>ValueDesk</span></a>
            <button type="button" className="vd-burger" aria-label="Close menu" onClick={() => setSheet(false)}>{IC.close}</button>
          </div>
          <p className="vd-sheet__k">Products</p>
          {PRODUCTS.map((p) => (
            <a key={p.key} href={p.href} className="vd-dd__item"><span className="vd-ic">{p.ic}</span><div><b>{p.t}</b><span>{p.s}</span></div></a>
          ))}
          <div className="vd-sheet__links">
            <a href={PAGE_PATHS.pricing}>Fees</a><a href="/points">SoPoints</a><a href={`${home}#faq`} onClick={() => setSheet(false)}>FAQ</a>
          </div>
          <div className="vd-sheet__cta">
            <a href="/bots/new" className="h-btn is-light is-block">Start a bot with {start}<Arrow /></a>
            <a href="/trade" className="h-btn is-glass is-block">Open the app</a>
          </div>
        </div>
      )}
    </header>
  );
}

/* --------------------------------------------------------------------------------------------- footer ----- */

/** V1's footer: the closing call, the columns and the chrome wordmark. */
export function SiteFooter({ title, sub }: { title?: ReactNode; sub?: ReactNode }) {
  return (
    <footer className="h-foot">
      <div className="h-foot__cta">
        <div>
          <h2 className="h-h2">{title ?? <>Put the market<br /><span>on your desk.</span></>}</h2>
          {sub && <p className="h-lead">{sub}</p>}
        </div>
        <div className="h-cta">
          <a href="/bots/new" className="h-btn is-light">Start a bot<Arrow /></a>
          <a href="/trade" className="h-btn is-glass">Open the app</a>
        </div>
      </div>
      <div className="h-foot__cols">
        <div><a href={homePath()} className="h-logo"><BrandMark size={20} /><span>ValueDesk</span></a><p className="h-dim">Bots, copy trading and analytics for SoDEX.</p></div>
        <div><p>Products</p>{PRODUCTS.map((p) => <a key={p.key} href={p.href}>{p.t}</a>)}<a href={PAGE_PATHS.pricing}>Fees</a></div>
        <div><p>Legal</p><a href="/terms">Terms of use</a><a href="/risk">Risk disclosure</a><a href="/privacy">Privacy</a><a href="/copy-terms">Copy and bot terms</a></div>
        <div><p>More</p><a href="/trade">Open the app</a><a href="/leaderboard">Leaderboard</a><a href="/status">Status</a><a href="/licenses">Licences</a></div>
      </div>
      <p className="h-risk">Trading perpetual futures carries a high risk of loss. Bots and copies can lose money, and past results of any trader or market say nothing about future ones. SoPoints are SoDEX's programme; ValueDesk's estimates of them are not a promise.</p>
      <div className="h-word" aria-hidden="true">ValueDesk</div>
    </footer>
  );
}

/* ----------------------------------------------------------------------------------------------- page ----- */

type Whale = { from: [number, number, number, number]; to: [number, number, number, number]; opacity?: number; color?: string };

/** A site page: ground, the swimming whale, nav, content, footer. */
export function SitePage({ title, children, whale, current, footer, home }: { title: string; children: ReactNode; whale?: Whale | null; current?: string; footer?: ReactNode; home?: string }) {
  useEffect(() => {
    dropBootShell();
    document.title = title;
    if (home) rememberHome(home);
  }, [title, home]);
  return (
    <div className="h vd" data-no-i18n="">
      <div className="h-bg" aria-hidden="true"><div className="h-bg__grid" /><div className="h-bg__beam" /></div>
      <SiteNav current={current} />
      <main className="vd-layer">{children}</main>
      {footer ?? <SiteFooter />}
    </div>
  );
}

/** A section borrowed from version 2, 3 or 4, in its own style scope. */
export function Embed({ scope, children, className }: { scope: 'v2' | 'v3' | 'v4'; children: ReactNode; className?: string }) {
  return <div className={cx(scope, 'vd-embed', className)}>{children}</div>;
}

/* ------------------------------------------------------------------------------------------ small parts ----- */

export function Ticks({ items }: { items: ReactNode[] }) {
  return <ul className="vd-ticks">{items.map((t, i) => <li key={i}>{IC.check}<span>{t}</span></li>)}</ul>;
}

export function Row({ k, title, children, vis, flip, visClass }: { k: string; title: ReactNode; children: ReactNode; vis: ReactNode; flip?: boolean; visClass?: string }) {
  return (
    <Reveal className={cx('vd-row', flip && 'is-flip')}>
      <FeatureFx v={1 + ([...k].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 5)} />
      <div className="vd-row__t">
        <p className="vd-row__k">{k}</p>
        <h3>{title}</h3>
        {children}
      </div>
      <div className={cx('vd-vis', visClass)}>{vis}</div>
    </Reveal>
  );
}

/** The four products as cards, each with its own drawing, linking to its page. */
export function ProductCards({ art }: { art: Partial<Record<(typeof PRODUCTS)[number]['key'], ReactNode>> }) {
  return (
    <div className="vd-prods">
      {PRODUCTS.map((p, i) => (
        <Reveal key={p.key} delay={i * 80}><a href={p.href} className="vd-prod">
          {art[p.key] && <div className="vd-prod__art" aria-hidden="true">{art[p.key]}</div>}
          <h3>{p.t}</h3>
          <p>{p.s}.</p>
          <span className="h-link">See {p.t.toLowerCase()}<Arrow /></span>
        </a></Reveal>
      ))}
    </div>
  );
}
