/**
 * The Wealth page's own pages (owner 2026-11-28: "a full info page for every asset", "pages for every custom index"):
 *
 *   /wealth                    the overview
 *   /wealth/fund/<fundId>      one SoDEX Wealth fund: SoDEX's info, its whole history, how it trades, the way in
 *   /wealth/indexes            every index: ValueDesk's, published ones, this browser's drafts
 *   /wealth/index/new          make an index
 *   /wealth/index/<id>         one index: history, constituents, allocation, buy once or on a schedule
 *   /wealth/index/<id>/edit    change a draft or one of the wallet's published indexes
 *
 * router.ts decides the page by the first segment only, so all of these are the Wealth page; it reads the rest here,
 * on mount and on popstate (openPath pushes, then dispatches one).
 */
import { useEffect, useState } from 'react';

export type WealthRoute =
  | { kind: 'home' }
  | { kind: 'fund'; id: string }
  | { kind: 'indexes' }
  | { kind: 'new' }
  | { kind: 'index'; id: string }
  | { kind: 'edit'; id: string };

const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

export function parseWealthPath(pathname: string): WealthRoute {
  const seg = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (seg[0]?.toLowerCase() !== 'wealth') return { kind: 'home' };
  const [, a, b, c] = seg;
  if (a === 'fund' && b) return { kind: 'fund', id: dec(b) };
  if (a === 'indexes' && !b) return { kind: 'indexes' };
  if (a === 'index' && b === 'new' && !c) return { kind: 'new' };
  if (a === 'index' && b && c === 'edit') return { kind: 'edit', id: dec(b) };
  if (a === 'index' && b && !c) return { kind: 'index', id: dec(b) };
  return { kind: 'home' };
}

const read = (): WealthRoute => (typeof window === 'undefined' ? { kind: 'home' } : parseWealthPath(window.location.pathname));

export function useWealthRoute(): WealthRoute {
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => setR(read());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return r;
}

const enc = encodeURIComponent;
export const WEALTH_PATH = {
  home: '/wealth',
  indexes: '/wealth/indexes',
  newIndex: '/wealth/index/new',
  fund: (id: string) => `/wealth/fund/${enc(id)}`,
  index: (id: string) => `/wealth/index/${enc(id)}`,
  edit: (id: string) => `/wealth/index/${enc(id)}/edit`,
} as const;
