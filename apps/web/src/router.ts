/**
 * The URL is the page.
 *
 * This app kept its current page in a `useState<Tab>` for its whole life, which
 * meant every page was the same URL: you could not link to the portfolio, could
 * not open two pages in two windows, and the back button walked out of the app
 * instead of to the page you came from. The tab state is now derived from
 * `location.pathname` and pushed back into history when it changes.
 *
 * NO ROUTER DEPENDENCY. This is six flat, parameterless routes with no nesting,
 * no loaders and no route-level code splitting; react-router is ~20KB gzipped to
 * express what fits in the file you are reading. The same reasoning that took
 * WalletConnect from 227 packages to 78 applies here.
 *
 * SCAN IS A ROUTE NOW. It used to be a standalone static document; it is the
 * portfolio page pointed at another address, so it lives in the SPA where those
 * components do. The old /scan/index.html is kept only as a redirect for links
 * anyone already saved.
 *
 * VERIFY IS STILL NOT A ROUTE. It is deliberately one dependency-free static
 * file you can read end to end - a page whose job is to let you audit this app
 * should not be built out of this app.
 */
import { useCallback, useEffect, useState } from 'react';

/**
 * Every page the SPA itself serves, IN NAV ORDER.
 *
 * `portfolio` is last on purpose. `useKeyboardShortcuts` maps the number keys
 * against its own list, so moving portfolio up would silently shift every
 * existing shortcut onto a different page. A new page goes at the END for the
 * same reason: `knowledge` (the knowledge folders, knowledge/) is 7.
 *
 * THERE IS NO WALLET PAGE. Connecting is a modal - the official one - and the
 * things that used to sit on that page (enable trading, turn it off, the local
 * key) are account actions, not a destination: they open from the header button
 * over whatever you were already looking at. A whole route whose only job was to
 * hold a Connect button made connecting a place you had to navigate to first.
 */
export const TABS = ['trade', 'explore', 'copy', 'leaderboard', 'portfolio', 'scan', 'knowledge'] as const;

/**
 * Pages that were removed, and where their old links now land (Account's
 * positions, orders, balances and history live on the portfolio page).
 */
const MOVED: Record<string, Tab> = { account: 'portfolio', money: 'portfolio', stats: 'trade', points: 'trade', verify: 'trade' };

export type Tab = (typeof TABS)[number];

/** The page a bare `/` lands on. */
export const DEFAULT_TAB: Tab = 'trade';

/** Human label for the nav. Derived, so a new route cannot ship without one. */
export const TAB_LABELS: Record<Tab, string> = {
  trade: 'Trade',
  explore: 'Explore',
  copy: 'Copy',
  leaderboard: 'Leaderboard',
  portfolio: 'Portfolio',
  scan: 'Scan',
  knowledge: 'Knowledge',
};

export const pathForTab = (tab: Tab): string => `/${tab}`;

/**
 * Change page from outside the shell's own props (the rail's quick drop, the
 * save sheet's "Open in Knowledge"): App.tsx listens and navigates as its own
 * links do, once the page's code is in.
 */
export const OPEN_TAB_EVENT = 'vs:open-tab';
export const openTab = (tab: Tab): void => {
  window.dispatchEvent(new CustomEvent<Tab>(OPEN_TAB_EVENT, { detail: tab }));
};

/**
 * The legal texts (src/legal): pages of their own, but NOT tabs. They are not
 * in the nav, have no number-key shortcut and no dashboard; the status bar at
 * the bottom of every page links them. Kept out of TABS so the nav, the
 * shortcuts and the per-tab layout code never see them.
 *
 * `copy-terms` (/copy-terms) is the copy trading terms and risk disclosure
 * that every follower signs before copying (legal/copyTerms.ts). One path
 * segment, so `legalForPath` reads it like the others, and not a tab: /copy
 * stays the Copy page. `risk` (/risk) is the risk disclosure, part of what
 * every visitor accepts with the terms (legal/acceptance.ts); `cookies`
 * (/cookies) the cookie and storage notice with the switches for the Live
 * Feed's players. The edge serves all of them even where the rest of the site
 * is blocked (legal/jurisdictions.mjs LEGAL_PATHS - docs.test.ts checks the
 * two lists agree).
 */
export const LEGAL_PAGES = ['impressum', 'privacy', 'cookies', 'terms', 'risk', 'copy-terms', 'licenses'] as const;
export type LegalPage = (typeof LEGAL_PAGES)[number];
export const LEGAL_LABELS: Record<LegalPage, string> = {
  impressum: 'Impressum',
  privacy: 'Privacy',
  cookies: 'Cookies',
  terms: 'Terms',
  risk: 'Risk',
  'copy-terms': 'Copy terms',
  licenses: 'Licences',
};
export const pathForLegal = (page: LegalPage): string => `/${page}`;

/** The legal page a pathname names, or null. Tolerant like `tabForPath`. */
export function legalForPath(pathname: string): LegalPage | null {
  const seg = pathname.replace(/\/+$/, '').split('/').filter(Boolean)[0]?.toLowerCase();
  return (LEGAL_PAGES as readonly string[]).includes(seg ?? '') ? (seg as LegalPage) : null;
}

/**
 * The page a pathname ends up on once `useRoute` has normalised it: its own
 * tab, or where a removed page moved to, or the default. App.tsx uses it to
 * fetch that page's code before the first render.
 */
export function landingTab(pathname: string): Tab {
  const tab = tabForPath(pathname);
  if (tab) return tab;
  const seg = pathname.replace(/\/+$/, '').split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
  return MOVED[seg] ?? DEFAULT_TAB;
}

/**
 * Resolve a pathname to a tab, or null when it is not one of ours.
 *
 * Tolerates a trailing slash and is case-insensitive, because a URL a person
 * typed or a link a person pasted is not required to be canonical. Returns null
 * rather than a default so the caller can tell "unknown path" from "the trade
 * page", which is what makes the redirect below possible.
 */
export function tabForPath(pathname: string): Tab | null {
  const seg = pathname.replace(/\/+$/, '').split('/').filter(Boolean)[0]?.toLowerCase();
  return (TABS as readonly string[]).includes(seg ?? '') ? (seg as Tab) : null;
}

/**
 * The current page, and a way to change it.
 *
 * `navigate` pushes, so every page change is a back-button stop. `popstate`
 * covers back/forward. An unknown path (including `/`) is REPLACED, not pushed,
 * with the default page: pushing would put a URL that renders nothing into the
 * history stack, and going "back" to it would be a dead end.
 */
export function useRoute(): [Tab, (tab: Tab) => void, LegalPage | null, (page: LegalPage) => void] {
  const [tab, setTab] = useState<Tab>(() => tabForPath(window.location.pathname) ?? DEFAULT_TAB);
  /* A legal page is shown INSTEAD of the tab's page; `tab` keeps the default
     there, so everything keyed on it (the nav, the shortcuts) is unchanged. */
  const [legal, setLegal] = useState<LegalPage | null>(() => legalForPath(window.location.pathname));

  useEffect(() => {
    /*
     * Normalise an unknown path to the default page - on ARRIVAL and on every
     * back/forward, not just on mount. `/wallet` is the case that made this
     * matter: it was a real route until the wallet became a modal, so old links
     * and history entries still point at it. Rendering the trade page while the
     * address bar still said /wallet meant copying the URL handed someone a link
     * to a page that no longer exists.
     */
    const normalise = () => {
      const path = window.location.pathname;
      if (tabForPath(path) === null && legalForPath(path) === null) {
        const seg = path.replace(/\/+$/, '').split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
        window.history.replaceState(null, '', pathForTab(MOVED[seg] ?? DEFAULT_TAB));
      }
      setTab(tabForPath(window.location.pathname) ?? DEFAULT_TAB);
      setLegal(legalForPath(window.location.pathname));
    };
    normalise();
    window.addEventListener('popstate', normalise);
    return () => window.removeEventListener('popstate', normalise);
  }, []);

  const navigate = useCallback((next: Tab) => {
    // Re-clicking the current tab must not stack duplicate history entries -
    // otherwise five clicks on "Trade" is five presses of Back to leave it.
    if (tabForPath(window.location.pathname) !== next) {
      window.history.pushState(null, '', pathForTab(next));
    }
    setTab(next);
    setLegal(null);
  }, []);

  const openLegal = useCallback((page: LegalPage) => {
    if (legalForPath(window.location.pathname) !== page) {
      window.history.pushState(null, '', pathForLegal(page));
    }
    setLegal(page);
  }, []);

  return [tab, navigate, legal, openLegal];
}
