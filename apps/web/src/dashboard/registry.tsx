/**
 * ============================================================================
 *  THE PANEL REGISTRY. Adding a panel is appending one entry to TRADE_PANELS.
 * ============================================================================
 *
 * A panel declares what it IS: its id, its accessible name, what to render, and
 * the limits that stop a user dragging it into a useless shape. It says nothing
 * about where it sits - that is layout.ts, and the two are kept apart on
 * purpose so that rearranging the terminal never means editing a component.
 *
 * To add a panel:
 *   1. append a PanelDefinition here (id must be unique and permanent),
 *   2. add a placement for it in layout.ts for each breakpoint you care about.
 * Step 2 is optional: an unplaced panel is auto-placed full width at the
 * bottom, so you can see it working before deciding where it belongs.
 *
 * Panels are pure functions of TradeContext. They do not fetch app state for
 * themselves and they do not own it - App.tsx still owns every piece of state
 * on this page, exactly as it did before the dashboard existed.
 *
 * `title` is NOT painted anywhere. Panels have no title bar; the string is the
 * region's accessible name and the name an error boundary reports under.
 */
import type { Engine, Symbol as MarketSymbol } from '../api';
import { LiveChart, LiveOrderEntry } from './livePrice';
import { Book, MarketStrip, TickerBar, Trades } from '../components/Market';
import { MarketTypeSwitch } from '../components/MarketTypeSwitch';
import { AccountPanel } from '../components/Account';
import { MobileCarousel, useCarouselPage } from './MobileCarousel';
import { useCallback, type ComponentProps } from 'react';
import { PanelTabs } from './Panel';
import type { BreakpointName, PanelDefinition } from './types';
import { EXTRA_WIDGET_IDS, faceFor } from './widgetCatalog';
import { FOMC_ODDS_ON } from '../components/macro/fomcFlag';
import { widgetBody, widgetBodyShape } from './widgetBodies';
import { ChartCard, TradeAccountBand } from './tradeTabs';
/* The opt-in panels draw with code of their own, like the catalog's widgets (lazyWidgets.tsx). */
import { FeeTier, LazyWidget, Leaderboard, Stats } from './lazyWidgets';
import { Suspense } from 'react';
import { DevPhoneDeck, DevPhonePulse, DevRangeBar } from './versions/dev';
import type { PageVersion } from './versions/store';

/**
 * The two breakpoints where the terminal has no column to spare for the chart.
 *
 * At `sm` and `xs` the measured design is two columns - order book on the left,
 * order ticket on the right, symbol header full width above them - and the
 * chart is not in the default view. It is not GONE, though: `book` picks it up
 * as a third tab at exactly these breakpoints, so the panel that was dropped
 * from the grid is still one click away. Dropping it from both places would be
 * a feature that silently does not exist on a phone.
 */
const isNarrow = (bp: BreakpointName) => bp === 'sm' || bp === 'xs';

/**
 * The order book, whose rows pick the ticket's price. In the phone carousel the ticket is another page, so a pick
 * there also opens it - with that price in it - instead of changing a page nobody can see (phone pass, 2026-11-18).
 * Beside the ticket (a wide screen) there is no carousel and a pick only sets the price, as before.
 */
function BookPick(props: ComponentProps<typeof Book>) {
  const carousel = useCarouselPage();
  const { onPick } = props;
  const pick = useCallback((p: string) => {
    onPick(p);
    carousel?.goTo('exec');
  }, [onPick, carousel]);
  return <Book {...props} onPick={pick} />;
}

/**
 * Everything the trade panels need, in one object. Adding a field here and
 * passing it from App.tsx is how a new panel gets access to new state - which
 * keeps the state itself where it already lives instead of migrating the page
 * to a store nobody asked for.
 */
export interface TradeContext {
  engine: Engine;
  symbol: string;
  sym: MarketSymbol | undefined;
  /** 'mainnet' means real money; order entry demands an extra confirmation. */
  network: string;
  unlocked: boolean;
  /** Wallet selected in the UI - drives every account READ. */
  address: string | null;
  /** Address the backend's unlocked key signs as - drives every WRITE. */
  signingAddress: string | null;
  byName: Map<string, MarketSymbol>;
  refreshToken: number;
  price: string;
  /* The last price is not here: it changes on every ticker push, so the panels
     that read it subscribe to lastPrice.ts themselves (livePrice.tsx). */
  favorites: string[];
  positionCount: number;
  orderCount: number;
  onPrice: (p: string, how?: 'snap') => void;
  onLastPrice: (p: string) => void;
  onChanged: () => void;
  onToggleFavorite: (key: string) => void;
  onOpenSearch: (seed?: string) => void;
  /** Where the dashboard's layout menu sends its "Notification settings"
   *  item. Optional so a caller with nowhere to send this yet gets no item
   *  rather than a dead one - see the same OPTIONAL reasoning on
   *  `onSelectSymbol` below. */
  onOpenNotificationSettings?: () => void;
  /** Where the trade tape's per-print search icon sends an account id - see
   *  the same OPTIONAL reasoning as `onOpenNotificationSettings` above. */
  onOpenScan?: (accountId: number) => void;
  onPositionCount: (n: number) => void;
  onOrderCount: (n: number) => void;
  /**
   * Switch the active market directly - what a click on a market-strip chip
   * wants to do. OPTIONAL because App.tsx owns `symbol` and does not have to
   * expose its setter for the dashboard to work: without it a chip click falls
   * back to opening the symbol search seeded with that market, which is a real
   * route to the same place rather than a dead control.
   */
  onSelectSymbol?: (symbol: string) => void;
  /** Futures or Spot (App.tsx switchEngine). */
  onEngine?: (e: Engine) => void;
  /**
   * The navbar has no Futures / Spot switch (a phone, below the rail: its bar is one row), so the ticker's market
   * row carries it. Never both: the e2e specs find ONE "Market type" switch at every width.
   */
  marketTypeInPage?: boolean;
  /** The page's version on localhost (versions/store.ts; TradeDashboard.tsx sets it). Absent: the original. */
  pageVersion?: PageVersion;
}

/** The prop bag the Account.tsx components take. Pulled out once, not six times. */
const accountCtx = (c: TradeContext) => ({
  engine: c.engine,
  address: c.address,
  unlocked: c.unlocked,
  byName: c.byName,
  refreshToken: c.refreshToken,
  onChanged: c.onChanged,
});

/** Accessible name. The painted heading is Account, with the book chosen beside it. */

export const TRADE_PANELS: PanelDefinition<TradeContext>[] = [
  {
    // The market strip. Built and exported months ago and registered nowhere,
    // so it rendered on no page at all; this is the entry that mounts it.
    // `pad: false` because the strip owns its own insets; the card's fill and
    // radius come from the panel around it, like every other panel's.
    id: 'markets',
    title: 'Markets',
    pad: false,
    scroll: 'hidden',
    resize: 'horizontal',
    minW: 8,
    minH: 1,
    maxH: 8,
    render: (c) => (
      <MarketStrip
        engine={c.engine}
        symbol={c.symbol}
        favorites={c.favorites}
        byName={c.byName}
        // App.tsx may not expose a symbol setter (see TradeContext); seeding the
        // search with the chip's market gets you there either way.
        onSelect={(s) => (c.onSelectSymbol ? c.onSelectSymbol(s) : c.onOpenSearch(s))}
        onToggleFavorite={c.onToggleFavorite}
        onAdd={() => c.onOpenSearch()}
      />
    ),
  },

  {
    // Symbol / price header - the page's subject line. Horizontal-only resize
    // so it cannot be dragged into a 400px-tall box that says nothing more than
    // it does at 52px.
    id: 'ticker',
    title: 'Market summary',
    // Its own strip only at the two narrow breakpoints, where the chart is a page
    // of the book's carousel; from md up the coin info row is the chart card's
    // head (the chart panel below renders it).
    when: (_c, bp) => isNarrow(bp),
    resize: 'horizontal',
    minW: 16,
    minH: 2,
    maxH: 10,
    render: (c) => (
      <>
        <TickerBar
          engine={c.engine}
          symbol={c.symbol}
          sym={c.sym}
          onLast={c.onLastPrice}
          onSymbolClick={() => c.onOpenSearch()}
          favorites={c.favorites}
          onToggleFavorite={c.onToggleFavorite}
          aside={c.marketTypeInPage && c.onEngine ? <MarketTypeSwitch engine={c.engine} onEngine={c.onEngine} /> : undefined}
        />
        {/* Pulse (localhost only): the 24-hour line under the coin row, as on a wide screen (tradeTabs.tsx). */}
        {c.pageVersion === 'pulse' && DevRangeBar && <Suspense fallback={null}><DevRangeBar engine={c.engine} symbol={c.symbol} sym={c.sym} /></Suspense>}
      </>
    ),
  },

  {
    id: 'chart',
    title: 'Chart',
    // The chart sizes its canvas from the container and re-measures with a
    // ResizeObserver. A scrollbar would let it grow instead of fit, so the
    // body must never scroll. `pad: false` because the chart brings its own
    // toolbar insets, and because the measured design is a 48px toolbar sitting
    // flush on a 508px canvas - 16px of body padding is 16px off both.
    scroll: 'hidden',
    pad: false,
    minW: 12,
    minH: 8,
    // NOT PLACED at the two narrow breakpoints: below `md` the design is two
    // columns of book and ticket, and a chart squeezed into a third of a phone
    // is a thumbnail nobody can read a candle off. It is still reachable there -
    // `book` mounts it as a third tab at exactly these breakpoints, which is the
    // condition on dropping a panel at all. See `isNarrow`.
    when: (_c, bp) => !isNarrow(bp),
    // The extra props are the order layer: the chart draws your resting orders
    // and your position entry on the price axis, and a drag can modify one. It
    // reads through `address` on its own (the Positions/Orders panels may be on
    // an unselected tab and unmounted), reports back through `onChanged` so
    // those panels re-read, and prefills the shared ticket price through
    // `onPrice` - the same channel the order book's click-to-price already uses.
    // `unlocked` false keeps the whole thing read-only: lines still draw, but
    // nothing can be dragged and the right-click menu does not open.
    // The card's head is the coin info row (the owner's reference: the coin,
    // the price, the day's figures, then the chart in the same card).
    // Tabs at the coin row's end (tradeTabs.tsx): other markets' charts and widgets, added with +.
    render: (c) => <ChartCard c={c} />,
  },

  {
    // ONE panel, two tabs at md/lg. The book and the tape used to be two
    // panels in two different columns; on the reference they are one module
    // with a tab bar, and they should be - they are two readings of the same
    // flow at the same width, and only one of them is worth looking at at a
    // time.
    //
    // At sm/xs this renders something else entirely - MobileCarousel, three
    // FULL-WIDTH swipeable pages (Chart, this same Book+Trades tab pair,
    // Execution) instead of a panel squeezed to half a phone's width beside a
    // second one. See layout.ts's `pair()`: at these two breakpoints `exec`
    // is not placed in the grid at all, because this panel now spans the
    // full 48 columns and renders it directly as the carousel's third page.
    id: 'book',
    title: 'Order book and trades',
    scroll: 'hidden',
    pad: false,
    minW: 8,
    minH: 10,
    /*
     * 250px, because rows are what this panel is FOR.
     *
     * `minH: 10` is ten GRID rows, and at lg a grid row is about 7px - so the
     * panel's own declared minimum was ~70px. The tab bar takes 41 of those, the
     * book's padding 22 and its grouping control 24, which left NINETEEN pixels
     * for the ladder: a panel dragged to its documented minimum showed zero
     * price levels. 250px keeps roughly five levels a side plus the spread.
     */
    minPx: 250,
    render: (c, bp) => {
      const bookTrades = (
        <PanelTabs
          tabs={[
            {
              key: 'book',
              label: 'Order Book',
              // The book divides its own clientHeight by a measured row
              // height to decide how many levels fit; give it a scrollbar
              // and it grows instead of fitting.
              scroll: 'hidden',
              content: (
                <BookPick engine={c.engine} symbol={c.symbol} sym={c.sym} onPick={c.onPrice} showTitle={false} address={c.address} />
              ),
            },
            {
              key: 'trades',
              label: 'Trades',
              // The tape DOES scroll, and deliberately: it walks up to the
              // nearest scrollable ancestor to compensate scrollTop when new
              // prints prepend. That ancestor is this tab's body.
              scroll: 'auto',
              content: (
                <Trades
                  engine={c.engine}
                  symbol={c.symbol}
                  sym={c.sym}
                  showTitle={false}
                  onOpenScan={c.onOpenScan}
                />
              ),
            },
          ]}
        />
      );

      if (!isNarrow(bp)) return bookTrades;

      // A version's own phone screen (localhost only): the same book, chart and ticket, composed another way.
      if (c.pageVersion === 'deck' && DevPhoneDeck) return <Suspense fallback={null}><DevPhoneDeck c={c} bookTrades={bookTrades} /></Suspense>;
      if (c.pageVersion === 'pulse' && DevPhonePulse) return <Suspense fallback={null}><DevPhonePulse c={c} bookTrades={bookTrades} /></Suspense>;

      return (
        <MobileCarousel
          pages={[
            {
              key: 'chart',
              label: 'Chart',
              scroll: 'hidden',
              content: (
                <LiveChart
                  engine={c.engine}
                  symbol={c.symbol}
                  sym={c.sym}
                  address={c.address}
                  unlocked={c.unlocked}
                  refreshToken={c.refreshToken}
                  onChanged={c.onChanged}
                  onPrice={c.onPrice}
                />
              ),
            },
            { key: 'book', label: 'Order Book', scroll: 'hidden', content: bookTrades },
            {
              key: 'exec',
              name: 'Order entry',
              label: 'Trade',
              scroll: 'auto',
              content: (
                <LiveOrderEntry
                  engine={c.engine}
                  symbol={c.symbol}
                  sym={c.sym}
                  network={c.network}
                  unlocked={c.unlocked}
                  showTitle={false}
                  connectedAddress={c.address}
                  signingAddress={c.signingAddress}
                  price={c.price}
                  onPrice={c.onPrice}
                  onPlaced={c.onChanged}
                />
              ),
            },
          ]}
        />
      );
    },
  },

  {
    id: 'exec',
    title: 'Order entry',
    scroll: 'auto',
    pad: false,
    minW: 8,
    minH: 12,
    // NOT PLACED at sm/xs - same reasoning as `chart` above it. The `book`
    // panel's carousel renders OrderEntry directly as its third page there;
    // a second grid cell squeezed to half a phone's width made every labelled
    // row in the ticket wrap.
    when: (_c, bp) => !isNarrow(bp),
    render: (c) => (
      <LiveOrderEntry
        engine={c.engine}
        symbol={c.symbol}
        sym={c.sym}
        network={c.network}
        unlocked={c.unlocked}
        showTitle={false}
        connectedAddress={c.address}
        signingAddress={c.signingAddress}
        price={c.price}
        onPrice={c.onPrice}
        onPlaced={c.onChanged}
      />
    ),
  },

  {
    id: 'positions',
    title: 'Account activity',
    // PanelTabs owns its own scrolling body and tab bar, so the panel body just
    // gives it the box.
    scroll: 'hidden',
    pad: false,
    minW: 16,
    minH: 8,
    /*
     * THE BAND IS SHARED WITH THE PORTFOLIO PAGE - components/AccountTabs.tsx.
     *
     * It used to be declared inline here, which made it a fact about the trade
     * page, and the portfolio page grew its own tab card over the same
     * endpoints. Two implementations of "your open orders" is two things to fix
     * whenever the account API moves, and it made one feature look like two
     * depending on which page you were on. Everything the band needs that this
     * page happens to know - the market the filter narrows to, the counts in
     * the tab labels - is passed in; a page that does not know them omits them
     * and the band drops the control rather than inventing a value for it.
     */
    // With a + after the band's own tabs for a widget tab (tradeTabs.tsx).
    render: (c) => <TradeAccountBand c={c} />,
  },

  {
    // A summary of what you have, so it reads as a statement rather than as
    // part of the flow.
    id: 'account',
    title: 'Account',
    // THE ONE PANEL IN THE BAND WITH A VISIBLE HEADING.
    //
    // Every other panel here is unlabelled, which is the reference's rule and
    // ours - but this one sits beside a tab row, and a card whose content
    // starts where its neighbour's tabs start reads as a misprint rather than
    // as a quieter panel. Measured, the reference labels it for exactly that
    // reason and puts the label on the tab row's own baseline.
    //
    // `scroll: 'hidden'` and `pad: false` for the same reason `positions` has
    // them: PanelHeading owns the band, the rule and the scrolling body, so the
    // panel body's job is only to hand it the box. The 16px content inset moves
    // with it - see `--acct-inset` in Account.css, which the tab body already
    // sets and which this body now shares.
    scroll: 'hidden',
    pad: false,
    minW: 8,
    minH: 6,
    render: (c) => <AccountPanel {...accountCtx(c)} />,
  },

  /* ---------------------------------------------------------------------------
   * OPT-IN PANELS.
   *
   * Real surfaces that already existed in the app but had no way onto a
   * dashboard - they were reachable only as whole pages. They ship
   * `defaultHidden` so an existing workspace is untouched until someone adds
   * them from the layout menu.
   * ------------------------------------------------------------------------ */
  {
    id: 'leaderboard',
    title: 'Leaderboard',
    defaultHidden: true,
    minW: 12,
    minH: 8,
    render: (c) => <LazyWidget><Leaderboard address={c.address} /></LazyWidget>,
  },
  {
    id: 'feetier',
    title: 'Fee tier',
    defaultHidden: true,
    minW: 10,
    minH: 6,
    render: (c) => <LazyWidget><FeeTier address={c.address} engine={c.engine} /></LazyWidget>,
  },
  {
    id: 'venue',
    title: 'Venue status',
    defaultHidden: true,
    minW: 10,
    minH: 6,
    render: (c) => <LazyWidget><Stats address={c.address} showTitle={false} /></LazyWidget>,
  },

  ...EXTRA_WIDGET_IDS.map((id): PanelDefinition<TradeContext> => {
    const name = faceFor(id)?.name ?? id;
    const quick = id === 'quick';
    // Each draws what its page draws, with that page's props (widgetBodies.tsx); the
    // body's scroll and insets are the widget's own. `probe` reads them without a context.
    const probe = widgetBodyShape(id);
    return {
      id,
      title: name,
      defaultHidden: true,
      minW: quick ? 8 : 10,
      minH: quick ? 12 : 8,
      pad: probe.pad,
      scroll: probe.scroll,
      // The FOMC odds are off until the markets license them (FedWatch.tsx).
      when: quick ? (_c, bp) => !isNarrow(bp) : id === 'fedwatch' ? () => FOMC_ODDS_ON : undefined,
      render: (c, bp) => widgetBody(id, c, { bp })?.content ?? null,
    };
  }),
];
