/**
 * EVERY STYLESHEET, IN CASCADE ORDER, LOADED UP FRONT.
 *
 * The pages are code-split (App.tsx loads each one when it is first needed),
 * but their CSS is deliberately NOT. Vite gives a lazily loaded chunk its own
 * stylesheet and appends it to <head> when the chunk arrives - after
 * styles.css and after every other sheet already on the page. Rules of equal
 * specificity are decided by source order, so the same element could render
 * differently depending on which pages you happened to open first. Keeping
 * one stylesheet, in one fixed order, makes that impossible.
 *
 * Vite emits a chunk's CSS in the order its modules are first reached, so this
 * file - App.tsx's first import - pins that order: it is exactly the order the
 * single-bundle build produced, and styles.css still comes last (main.tsx
 * imports it after App). The components keep their own CSS imports; importing
 * a sheet twice is a no-op.
 *
 * ADDING A STYLESHEET: add it here too, at the position of its first import.
 * `cssOrder.test.ts` fails when a CSS file imported anywhere under src/ is
 * missing from this list.
 */
import './components/motion.css';
import './components/CoinIcon.css';
import './components/account/account.css';
import './components/TapeFilter.css';
import './components/Market.css';
import './components/StatusFooter.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './dashboard/dashboard.css';
import './dashboard/sketches.css';
import './dashboard/editMode.css';
import './dashboard/responsive.css';
import './components/Leaderboard.css';
import './components/FeeTier.css';
import './components/Account.css';
import './components/Portfolio.css';
import './components/scan/scan.css';
import './components/palette/CommandPalette.css';
import './chart/rail.css';
import './components/MarketPanels.css';
import './chart/chart.css';
import './components/ReviewPosition.css';
import './components/OrderEntry.css';
import './components/algo/algo.css';
import './dashboard/carousel.css';
import './components/Stats.css';
import './dashboard/sourceWidgets.css';
import './components/IndexPrompt.css';
import './components/Points.css';
import './components/account/ConnectDialog.css';
import './components/funds/funds.css';
import './components/FeeSchedule.css';
import './setup/setup.css';
import './components/dev/DevPanel.css';
import './components/explore/Explore.css';
import './components/leaderboard/LeaderboardPage.css';
import './components/explore/cohorts/Cohorts.css';
import './components/copy/Copy.css';
import './components/copy/CopyHome.css';
import './copy/copy.css';

/* Not listed, on purpose: styles.css (main.tsx imports it last, after App),
   the four @fontsource sheets (main.tsx, first), chart/tv/*.css, which
   belong to the optional TradingView chart and were already loaded on demand,
   and legal/legal.css: it arrives with the legal pages' chunk, and every rule
   in it is scoped to `.legal*` classes no other page has, so where it lands in
   the cascade cannot change anything else - and the first load stays as it was. */
export {};
