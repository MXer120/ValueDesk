/**
 * THE TERMINAL'S WIDGETS THAT NO DEFAULT LAYOUT PLACES, IN CHUNKS OF THEIR OWN (phone pass, 2026-11-18).
 *
 * widgetBodies.tsx imported every widget of the catalog - the liquidation map, cohorts, the leaderboards, news,
 * the Fed, the copies - so /trade's first render carried all of them (~277 KB of code, ~79 KB brotli) although
 * a phone's layout places none of them and a desktop's places them only once someone adds one. Each is a
 * lazyPage now (lazyPage.ts): once its chunk is in it renders synchronously, exactly like a static import, so
 * nothing on screen tells. Which chunks are in when:
 *   - the ones the stored layout puts on screen at the first commit (TradeDashboard.tsx tradeWidgetsReady):
 *     App's loader for /trade waits for them with the page's own code, so a desktop layout with a news
 *     panel, or the liquidation map as the chart's open tab, mounts in the same single commit as before;
 *   - the rest after the page's load event (afterLoad.ts): every one on a wide screen, where the chart's tabs,
 *     the terminals on the rail and edit mode are a tap away; on a phone only the ones already added as tabs;
 *   - all of them when the widget list (a tab's +) or edit mode opens.
 * A widget rendered before its chunk is in (a tap in the first seconds of a slow load) waits inside its own
 * panel (components/LazyWait.tsx), never the page.
 */
import { Suspense, type ComponentProps, type ReactNode } from 'react';
import { LazyWait } from '../components/LazyWait';
import { lazyPage, type LazyPage } from '../lazyPage';
import { baseOf } from './tabIds';
import type { LiveFeed as LiveFeedComponent } from '../components/livefeed/LiveFeed';

/* One per module; the names are what the log says on a failed load. */
export const LiqHeatmap = lazyPage('widget liqmap', () => import('../components/liqmap/LiqHeatmap').then((m) => m.LiqHeatmap));
export const FundingScanner = lazyPage('widget funding', () => import('../components/explore/FundingScanner').then((m) => m.FundingScanner));
export const Cohorts = lazyPage('widget cohorts', () => import('../components/explore/cohorts/Cohorts').then((m) => m.Cohorts));
export const Leaderboard = lazyPage('widget leaderboard', () => import('../components/Leaderboard').then((m) => m.Leaderboard));
export const LeaderboardPage = lazyPage('widget toptraders', () => import('../components/leaderboard/LeaderboardPage').then((m) => m.LeaderboardPage));
export const NewsFeed = lazyPage('widget news', () => import('../components/news/NewsFeed').then((m) => m.NewsFeed));
// Typed by hand: the props' `= {}` default does not survive the inference.
export const LiveFeed = lazyPage<NonNullable<ComponentProps<typeof LiveFeedComponent>>>('widget livefeed', () => import('../components/livefeed/LiveFeed').then((m) => m.LiveFeed));
export const FedLive = lazyPage('widget fedlive', () => import('../components/fedlive/FedLive').then((m) => m.FedLive));
export const FedWatch = lazyPage('widget fedwatch', () => import('../components/macro/FedWatch').then((m) => m.FedWatch));
export const IndicatorWidget = lazyPage('widget indicator', () => import('../components/macro/IndicatorView').then((m) => m.IndicatorWidget));
export const EtfFlows = lazyPage('widget etfflows', () => import('../components/macro/EtfFlows').then((m) => m.EtfFlows));
export const MyCopiesCard = lazyPage('widget copy', () => import('../components/scan/MyCopies').then((m) => m.MyCopiesCard));
export const FeeTier = lazyPage('widget feetier', () => import('../components/FeeTier').then((m) => m.FeeTier));
export const Stats = lazyPage('widget venue', () => import('../components/Stats').then((m) => m.Stats));

/** Widget id (widgetCatalog.ts, and the opt-in panels') -> the code it draws with. Ids not here are in the page's chunk. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WIDGET_CODE: Readonly<Record<string, LazyPage<any>>> = {
  liqmap: LiqHeatmap,
  funding: FundingScanner,
  cohorts: Cohorts,
  leaderboard: Leaderboard,
  toptraders: LeaderboardPage,
  news: NewsFeed,
  livefeed: LiveFeed,
  fedlive: FedLive,
  fedwatch: FedWatch,
  indicator: IndicatorWidget,
  etfflows: EtfFlows,
  copy: MyCopiesCard,
  feetier: FeeTier,
  venue: Stats,
};

/** The chunk a widget, panel or tab id draws with (`news#2` and `x:news` are `news`), or null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function widgetCodeOf(id: string): LazyPage<any> | null {
  const base = baseOf(id.startsWith('x:') ? id.slice(2) : id);
  return WIDGET_CODE[base] ?? null;
}

/** Load the code of these widgets (unknown ids and ones already in are skipped). Never rejects. */
export function preloadWidgets(ids: Iterable<string>): Promise<void> {
  const wait: Promise<void>[] = [];
  for (const id of ids) {
    const code = widgetCodeOf(id);
    if (code && !code.ready) wait.push(code.preload().catch(() => undefined));
  }
  return Promise.all(wait).then(() => undefined);
}

/** Every widget's code: the widget list or edit mode is open, or the screen is wide (see the header). */
export const preloadAllWidgets = (): Promise<void> => preloadWidgets(Object.keys(WIDGET_CODE));

/** A lazy widget's boundary: what it renders once its code is in; LazyWait until then. */
export function LazyWidget({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LazyWait />}>{children}</Suspense>;
}
