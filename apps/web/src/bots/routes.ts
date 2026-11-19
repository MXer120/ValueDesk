/**
 * The Bots section's own pages, under the `bots` tab (router.ts keeps flat tabs; the section reads the rest of the
 * path itself):
 *
 *   /bots            Overview: every bot, the latency chart, the fleet's figures
 *   /bots/new        New bot
 *   /bots/explore    Explore: what a bot costs on every market, estimated from the market's own trades
 *   /bots/savings    Savings: the next fee tier, staking, cheaper markets
 *   /bots/<id>       One bot, with full control
 *
 * BOTS_ON (docs/BOTS-UI.md): dev builds and VITE_BOTS=1 have the section; any other build leaves it out, so other
 * work ships without it (owner, 2026-11-07).
 */
import { useEffect, useState } from 'react';
import { openPath, scrollPageTop } from '../nav';

const env = (import.meta as { env?: { DEV?: boolean; VITE_BOTS?: string; VITE_CHANNEL?: string } }).env;
export const BOTS_ON: boolean = !!env?.DEV || env?.VITE_BOTS === '1';

export type BotsView = { page: 'overview' } | { page: 'new'; market: string | null; kind: string | null } | { page: 'explore' } | { page: 'savings' } | { page: 'bot'; id: string };

const SUBS = new Set(['new', 'explore', 'savings']);

/** The Bots page a pathname (and query) names. Anything not a sub-page under /bots is a bot's id. */
export function botsViewFor(pathname: string, search = ''): BotsView {
  const segs = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs[0]?.toLowerCase() !== 'bots' || segs.length < 2) return { page: 'overview' };
  const sub = segs[1]!.toLowerCase();
  if (sub === 'new') { const q = new URLSearchParams(search); return { page: 'new', market: q.get('market'), kind: q.get('kind') }; }
  if (sub === 'explore') return { page: 'explore' };
  if (sub === 'savings') return { page: 'savings' };
  // A malformed escape (/bots/%E0) is a bot id nobody has, not a page that throws.
  let id = segs[1]!;
  try { id = decodeURIComponent(id); } catch { /* kept as typed */ }
  return { page: 'bot', id };
}

export function pathForBots(v: BotsView): string {
  if (v.page === 'overview') return '/bots';
  if (v.page === 'new') { const q = new URLSearchParams(); if (v.market) q.set('market', v.market); if (v.kind) q.set('kind', v.kind); const s = q.toString(); return `/bots/new${s ? `?${s}` : ''}`; }
  if (v.page === 'bot') return `/bots/${encodeURIComponent(v.id)}`;
  return `/bots/${v.page}`;
}

/** Go to a Bots page: a history entry of its own, and every listener (the router's included) reads the URL again. */
export function goBots(v: BotsView): void {
  const path = pathForBots(v);
  // From another page: the app's own navigation (nav.ts), which waits for the Bots code with the tab lit.
  if (!/^\/bots(\/|$)/.test(window.location.pathname)) {
    openPath(path);
    return;
  }
  if (window.location.pathname + window.location.search !== path) window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  // The page scroller, not the window (which never scrolls: styles.css .appcontent).
  scrollPageTop();
}

export function useBotsView(): BotsView {
  const [v, setV] = useState<BotsView>(() => botsViewFor(window.location.pathname, window.location.search));
  useEffect(() => {
    const read = () => setV(botsViewFor(window.location.pathname, window.location.search));
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  return v;
}

export const isSubPage = (seg: string): boolean => SUBS.has(seg);

/** The bell's "Renew the key" (Notices.tsx, key-expiry notices): the Bots page renews the trading key once it is open. */
export const RENEW_KEY_FLAG = 'vd.bots.renewKey';
export const RENEW_KEY_EVENT = 'vd:bots-renew-key';
export function renewKeyFromBell(): void {
  try { sessionStorage.setItem(RENEW_KEY_FLAG, '1'); } catch { /* private mode: the event below still reaches an open page */ }
  goBots({ page: 'overview' });
  window.dispatchEvent(new Event(RENEW_KEY_EVENT));
}
