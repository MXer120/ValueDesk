/**
 * The home page and everything under it: / (a first visit) and /home = site/HomePage.tsx; /home/bots, copy-trading,
 * analytics, cross-venue, fees, faq = site/Pages.tsx and site/FaqPage.tsx. Each is its own chunk. Any other /home path
 * (the old /home/2..5 of the review) shows the home page.
 */
import { lazy, Suspense } from 'react';

const Front = lazy(() => import('./site/HomePage').then((m) => ({ default: m.HomePage })));
const pages = () => import('./site/Pages');
const SITE = {
  bots: lazy(() => pages().then((m) => ({ default: m.BotsPage }))),
  'copy-trading': lazy(() => pages().then((m) => ({ default: m.CopyPage }))),
  analytics: lazy(() => pages().then((m) => ({ default: m.AnalyticsPage }))),
  'cross-venue': lazy(() => pages().then((m) => ({ default: m.CrossVenuePage }))),
  fees: lazy(() => pages().then((m) => ({ default: m.PricingPage }))),
  pricing: lazy(() => pages().then((m) => ({ default: m.PricingPage }))),
  faq: lazy(() => import('./site/FaqPage').then((m) => ({ default: m.FaqPage }))),
} as const;

export function HomeSite() {
  const seg = (window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean)[1] ?? '').toLowerCase();
  const Page = SITE[seg as keyof typeof SITE] ?? Front;
  return <Suspense fallback={null}><Page /></Suspense>;
}
