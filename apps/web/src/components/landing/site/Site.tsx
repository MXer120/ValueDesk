/**
 * The marketing site's shell (owner 2026-11-23): one nav with a Products dropdown that leads to real pages (bots, copy
 * trading, analytics, cross-venue) plus Pricing and FAQ, V1's footer (the owner liked it), and the parts every page of
 * the site shares. Root class `h vd`: V1's vocabulary applies; borrowed sections of versions 2-4 go in <Embed>.
 * Paths: the home page is /home (and / on a first visit), the pages /home/<page>.
 */
import { FEEDBACK_URL } from '../../../feedback/url';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandMark } from '../../BrandMark';
import { dropBootShell } from '../../../bootShell';
import { Arrow, Reveal } from '../Home';
import { HeatGlass } from '../v4/heat';

import '../v3/v3.css';
import { bp, FEES, liteDevice } from '../shared';
import '../home.css';
import './site.css';
import './pages.css';

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(' ');

/* ---------------------------------------------------------------------------------------------- paths ----- */

export const PAGE_PATHS = { bots: '/home/bots', copy: '/home/copy-trading', analytics: '/home/analytics', cross: '/home/cross-venue', pricing: '/home/fees', faq: '/home/faq' } as const;

/** The page's own first step: a bot on Bots, a copy on Copy trading, the app everywhere else (owner 2026-11-24). */
const CTA: Record<string, { href: string; label: string }> = { bots: { href: '/bots/new', label: 'Start a bot' }, copy: { href: '/copy', label: 'Copy a trader' } };
const APP = { href: '/trade', label: 'Launch app' };
/** The home page: / shows it to a first visit only, so links name its own path. */
export const homePath = (): string => '/home';

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
  x: <svg viewBox="0 0 24 24"><path d="M4 4l16 16M20 4 4 20" opacity="0" /><path d="M5 4.5h4.2l9.8 15H14.8z" /><path d="M18.6 4.5 13.4 10.4M10.6 13.6 5.4 19.5" /></svg>,
  chat: <svg viewBox="0 0 24 24"><path d="M7.2 6.2c3.2-1.4 6.4-1.4 9.6 0 1.6 2.6 2.4 5.4 2.2 8.6-1.4 1.2-3 2-4.6 2.4l-1-1.8c-.9.2-1.9.2-2.8 0l-1 1.8c-1.6-.4-3.2-1.2-4.6-2.4-.2-3.2.6-6 2.2-8.6Z" /><circle cx="9.6" cy="12" r="1.1" /><circle cx="14.4" cy="12" r="1.1" /></svg>,
};

/** The community (owner 2026-11-28: "on landing page, add a community dropdown with X & Discord invite"): the same
 * accounts the app's More menu links (NavMore.tsx). */
export const COMMUNITY = [
  { key: 'x', href: 'https://x.com/ValueDeskdotso', t: 'X', s: 'News, releases and market notes · @ValueDeskdotso', ic: IC.x },
  { key: 'discord', href: FEEDBACK_URL ?? 'https://discord.gg/TVJKHY9vhK', t: 'Discord', s: 'Join the community: questions, feedback, beta access', ic: IC.chat },
] as const;

export const PRODUCTS = [
  { key: 'bots', href: PAGE_PATHS.bots, t: 'Bots', s: 'Market makers, grids and hedges on SoDEX perps and spot', ic: IC.bot },
  { key: 'copy', href: PAGE_PATHS.copy, t: 'Copy trading', s: 'Follow any Hyperliquid or SoDEX wallet at your size', ic: IC.copy },
  { key: 'analytics', href: PAGE_PATHS.analytics, t: 'Analytics', s: 'Liquidation map, who traded each candle, news and calendar. Free', ic: IC.heat },
  { key: 'cross', href: PAGE_PATHS.cross, t: 'Cross-venue', s: 'Five venues side by side: traders, liquidations, funding', ic: IC.cross },
] as const;

/* ------------------------------------------------------------------------------------------------ nav ----- */

export function SiteNav({ current }: { current?: string }) {
  const [solid, setSolid] = useState(false);
  const [open, setOpen] = useState(false);
  const [comm, setComm] = useState(false);
  const [sheet, setSheet] = useState(false);
  const dd = useRef<HTMLDivElement>(null);
  const cd = useRef<HTMLDivElement>(null);
  const commT = useRef(0);
  const closeT = useRef(0);
  useEffect(() => {
    const s = () => setSolid(window.scrollY > 12);
    s();
    window.addEventListener('scroll', s, { passive: true });
    return () => window.removeEventListener('scroll', s);
  }, []);
  useEffect(() => {
    if (!open && !comm && !sheet) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setComm(false); setSheet(false); } };
    const click = (e: MouseEvent) => {
      if (dd.current && !dd.current.contains(e.target as Node)) setOpen(false);
      if (cd.current && !cd.current.contains(e.target as Node)) setComm(false);
    };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', click);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousedown', click); };
  }, [open, comm, sheet]);
  useEffect(() => { document.body.style.overflow = sheet ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [sheet]);
  const enter = () => { window.clearTimeout(closeT.current); setOpen(true); };
  const leave = () => { closeT.current = window.setTimeout(() => setOpen(false), 160); };
  const home = homePath();
  const cta = CTA[current ?? ''] ?? APP;

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
                <b>Start with your first bot</b>
                <small>From {bp(FEES.botLowest)} per order (VIP)</small>
              </a>
            </div>
          </div>
          <a href={PAGE_PATHS.pricing} className={cx(current === 'fees' && 'is-on')}>Fees</a>
          <a href="/points">SoPoints</a>
          <a href={PAGE_PATHS.faq} className={cx(current === 'faq' && 'is-on')}>FAQ</a>
          <div ref={cd} className={cx('vd-dd vd-dd--comm', comm && 'is-open')} onMouseEnter={() => { window.clearTimeout(commT.current); setComm(true); }} onMouseLeave={() => { commT.current = window.setTimeout(() => setComm(false), 160); }}>
            <button type="button" className="vd-dd__btn" aria-expanded={comm} aria-controls="vd-community" onClick={() => setComm((o) => !o)}>Community{IC.chevron}</button>
            <div id="vd-community" className="vd-dd__panel" role="menu">
              {COMMUNITY.map((c) => (
                <a key={c.key} href={c.href} target="_blank" rel="noopener noreferrer" className="vd-dd__item" role="menuitem">
                  <span className="vd-ic">{c.ic}</span>
                  <div><b>{c.t}</b><span>{c.s}</span></div>
                </a>
              ))}
            </div>
          </div>
        </nav>
        <div className="vd-nav__cta">
          {cta !== APP && <a href="/trade" className="h-btn is-glass is-sm">Open app</a>}
          <a href={cta.href} className="h-btn is-light is-sm">{cta.label}<Arrow /></a>
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
          <p className="vd-sheet__k">Community</p>
          {COMMUNITY.map((c) => (
            <a key={c.key} href={c.href} target="_blank" rel="noopener noreferrer" className="vd-dd__item"><span className="vd-ic">{c.ic}</span><div><b>{c.t}</b><span>{c.s}</span></div></a>
          ))}
          <div className="vd-sheet__links">
            <a href={PAGE_PATHS.pricing}>Fees</a><a href="/points">SoPoints</a><a href={PAGE_PATHS.faq}>FAQ</a>
          </div>
          <div className="vd-sheet__cta">
            <a href={cta.href} className="h-btn is-light is-block">{cta.label}<Arrow /></a>
            {cta !== APP && <a href="/trade" className="h-btn is-glass is-block">Open the app</a>}
          </div>
        </div>
      )}
    </header>
  );
}

/* --------------------------------------------------------------------------------------------- footer ----- */

/** V1's footer: the closing call, the columns and the chrome wordmark. */
export function SiteFooter({ title, sub, cta = APP }: { title?: ReactNode; sub?: ReactNode; cta?: { href: string; label: string } }) {
  return (
    <footer className="h-foot">
      <div className="h-foot__cta">
        <div>
          <h2 className="h-h2">{title ?? <>Put the market<br /><span>on your desk.</span></>}</h2>
          {sub && <p className="h-lead">{sub}</p>}
        </div>
        <div className="h-cta">
          <a href={cta.href} className="h-btn is-light">{cta.label}<Arrow /></a>
          {cta.href !== '/trade' && <a href="/trade" className="h-btn is-glass">Open the app</a>}
        </div>
      </div>
      <div className="h-foot__cols">
        <div><a href={homePath()} className="h-logo"><BrandMark size={20} /><span>ValueDesk</span></a><p className="h-dim">Bots, copy trading and analytics for SoDEX.</p></div>
        <div><p>Products</p>{PRODUCTS.map((p) => <a key={p.key} href={p.href}>{p.t}</a>)}<a href={PAGE_PATHS.pricing}>Fees</a><a href={PAGE_PATHS.faq}>FAQ</a></div>
        <div><p>Legal</p><a href="/terms">Terms of use</a><a href="/risk">Risk disclosure</a><a href="/privacy">Privacy</a><a href="/copy-terms">Copy and bot terms</a></div>
        <div><p>More</p><a href="/trade">Open the app</a><a href="/leaderboard">Leaderboard</a><a href="/status">Status</a><a href="/licenses">Licences</a></div>
      </div>
      <p className="h-risk">Trading perpetual futures carries a high risk of loss. Bots and copies can lose money, and past results of any trader or market say nothing about future ones. SoPoints are SoDEX's programme; ValueDesk's estimates of them are not a promise.</p>
      <div className="h-word" aria-hidden="true">ValueDesk</div>
    </footer>
  );
}

/* ----------------------------------------------------------------------------------------------- page ----- */

/** A site page: ground, nav, content, footer. */
export function SitePage({ title, children, current, footer }: { title: string; children: ReactNode; current?: string; footer?: ReactNode }) {
  useEffect(() => {
    dropBootShell();
    document.title = title;
  }, [title]);
  return (
    <div className={cx('h vd', liteDevice() && 'is-lite')} data-no-i18n="">
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
