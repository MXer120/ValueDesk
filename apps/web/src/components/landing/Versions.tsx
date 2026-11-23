/**
 * /home and its versions (owner 2026-11-23: four landing pages to pick from): /home = version 1 (Home.tsx), /home/2..4
 * = versions 2-4, each its own page and chunk. On localhost a pill switches between them (shared.tsx VersionSwitcher).
 */
import { lazy, Suspense } from 'react';
import { versionOfPath, VersionSwitcher } from './shared';

const PAGES = {
  1: lazy(() => import('./Home').then((m) => ({ default: m.Home }))),
  2: lazy(() => import('./v2/V2').then((m) => ({ default: m.V2 }))),
  3: lazy(() => import('./v3/V3').then((m) => ({ default: m.V3 }))),
  4: lazy(() => import('./v4/V4').then((m) => ({ default: m.V4 }))),
} as const;

export function HomeVersions() {
  const v = versionOfPath(window.location.pathname) as keyof typeof PAGES;
  const Page = PAGES[v] ?? PAGES[1];
  return (
    <>
      <Suspense fallback={null}><Page /></Suspense>
      <VersionSwitcher current={v} />
    </>
  );
}
