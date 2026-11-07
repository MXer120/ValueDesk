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
  return { page: 'bot', id: decodeURIComponent(segs[1]!) };
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
  if (window.location.pathname + window.location.search !== path) window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo?.({ top: 0 });
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
