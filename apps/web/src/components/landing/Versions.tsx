/**
 * /home and everything under it (owner 2026-11-23):
 *   /home = version 1 (Home.tsx), /home/2..4 = versions 2-4 (first round), /home/5..7 = versions 5-7 built from the
 *   parts the owner liked (site/Versions.tsx);
 *   /home/bots, /home/copy-trading, /home/analytics, /home/cross-venue, /home/pricing = the site's pages (site/Pages.tsx).
 * Each is its own chunk. On localhost a pill switches between the versions (shared.tsx VersionSwitcher).
 */
import { lazy, Suspense } from 'react';
import { versionOfPath, VersionSwitcher } from './shared';

const PAGES = {
  1: lazy(() => import('./Home').then((m) => ({ default: m.Home }))),
  2: lazy(() => import('./v2/V2').then((m) => ({ default: m.V2 }))),
  3: lazy(() => import('./v3/V3').then((m) => ({ default: m.V3 }))),
  4: lazy(() => import('./v4/V4').then((m) => ({ default: m.V4 }))),
  5: lazy(() => import('./site/Versions').then((m) => ({ default: m.V5 }))),
  6: lazy(() => import('./site/Versions').then((m) => ({ default: m.V6 }))),
  7: lazy(() => import('./site/Versions').then((m) => ({ default: m.V7 }))),
} as const;

const SITE = {
  bots: lazy(() => import('./site/Pages').then((m) => ({ default: m.BotsPage }))),
  'copy-trading': lazy(() => import('./site/Pages').then((m) => ({ default: m.CopyPage }))),
  analytics: lazy(() => import('./site/Pages').then((m) => ({ default: m.AnalyticsPage }))),
  'cross-venue': lazy(() => import('./site/Pages').then((m) => ({ default: m.CrossVenuePage }))),
  pricing: lazy(() => import('./site/Pages').then((m) => ({ default: m.PricingPage }))),
} as const;

export function HomeVersions() {
  const seg = (window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean)[1] ?? '').toLowerCase();
  const Site = SITE[seg as keyof typeof SITE];
  if (Site) return <Suspense fallback={null}><Site /></Suspense>;
  const v = versionOfPath(window.location.pathname) as keyof typeof PAGES;
  const Page = PAGES[v] ?? PAGES[1];
  return (
    <>
      <Suspense fallback={null}><Page /></Suspense>
      <VersionSwitcher current={v} />
    </>
  );
}
