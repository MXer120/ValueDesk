/**
 * ============================================================================
 *  THE LAYOUT KNOB. This is the file you edit to rearrange the terminal.
 * ============================================================================
 *
 * Everything here is data. Moving the order book, making the chart wider,
 * changing where things land on a laptop - all of it is editing numbers below.
 * No component changes, no JSX.
 *
 * Reading a placement:  { i: 'chart', x: 0, y: 8, w: 28, h: 52 }
 *   i  panel id, must match a `PanelDefinition.id` in registry.tsx
 *   x  column of its left edge   (0 .. cols-1)
 *   y  row of its top edge       (0 = top; rows are pushed up by compaction)
 *   w  width in columns
 *   h  height in rows
 *
 * Rules that will save you time:
 *
 *  - The grid is 48 columns at every breakpoint. x + w must be <= 48; anything
 *    wider is clamped rather than wrapped.
 *  - Panels compact UPWARD. A gap above a panel closes; you cannot leave
 *    deliberate whitespace by choosing a large y. Order and adjacency is what
 *    you control, not absolute offsets.
 *  - Min/max sizes are NOT here - they belong to the panel and live in
 *    registry.tsx. If a placement is smaller than the panel's minimum, the
 *    minimum wins.
 *  - A panel with no placement at a breakpoint is auto-placed full width at the
 *    bottom. So you can register a panel and it will show up somewhere sane
 *    before you have decided where it belongs.
 *  - A placement for a panel id that no longer exists is ignored.
 *  - Users' dragged layouts are saved per breakpoint and override these
 *    defaults. Bump `version` below to force everyone back onto new defaults.
 *
 * ---------------------------------------------------------------------------
 * WHY 48 COLUMNS AND NOT 12
 *
 * The lg arrangement is not a taste decision any more, it is a transcription of
 * a measured design at 1920x1080: a 1114px chart column, then the order book
 * and the order ticket at 395px EACH - the two are the same width - with a 4px
 * gutter between every pair and 4px of page padding outside.
 *
 * With a uniform gutter `m`, a panel of `w` columns in a `C`-column grid of
 * width `W` satisfies (panelW + m) / (W + m) = w / C. At W=1912 and m=4:
 *
 *   chart  (1114 + 4) / 1916 = 0.5835  ->  x48 = 28.01
 *   book   ( 395 + 4) / 1916 = 0.2082  ->  x48 =  9.996
 *   ticket ( 395 + 4) / 1916 = 0.2082  ->  x48 =  9.996
 *
 * 28 / 10 / 10 of 48. Every one of those is within 0.01 of an integer, and they
 * sum to 48 exactly. Feeding the widths back through: 1113.7 / 395.2 / 395.2.
 *
 * There is no 12-column split that comes close - the nearest is 7 / 2 / 3,
 * which is 1087 / 306 / 462, and it makes the book and the ticket different
 * widths, which is the specific error the measurement was taken to fix (we
 * shipped 308 and 464).
 * ---------------------------------------------------------------------------
 */
import type { DashboardConfig, PanelPlacement } from './types';

/* Small-screen behaviour that cannot be expressed as placements - disabling
   drag/resize below `md`, touch-sized controls, popups that would otherwise be
   clipped by the panel box. Imported here rather than from Dashboard.tsx
   because this file is the only one in the directory that owns per-breakpoint
   decisions; see the header of responsive.css for the window-width mapping. */
import './responsive.css';

/**
 * Breakpoints are measured against the DASHBOARD's own width, not the
 * window's - the app has a max-width content column, so those two diverge on
 * very wide monitors and the container is the one that decides whether three
 * columns actually fit.
 *
 * `.app` in styles.css is a max-width column with side padding, so the
 * container is always narrower than the window: 12px of padding a side above a
 * 760px window and 8px below it, so `container = window - 24` and
 * `container = window - 16` respectively. Measured `.dash-scroll` clientWidths
 * on the running app, against the tiers the design was measured at:
 *
 *   window   container   breakpoint
 *    1920      1876         lg    three columns, 28/10/10
 *    1440      1416         lg
 *    1280      1256         lg    <- the reason lg is 1200 and not 1360. The
 *    1024      1000         md       measured design is still three columns at
 *     768       744         sm       1280; it collapses to two at 1024.
 *     390       374         xs
 *
 * The four tiers, and what each one IS:
 *
 *   lg  three columns - chart, book, ticket - with the account band under the
 *       first two and the account summary under the ticket.
 *   md  TWO columns. Chart full width, book and ticket side by side beneath it.
 *       Nothing is hidden; the page scrolls.
 *   sm  TWO columns of book and ticket, symbol header full width above them,
 *       and the chart is a tab of the book rather than a panel. This is the
 *       measured 768 layout.
 *   xs  the same two columns, roomier rows for touch. The measured 390 layout.
 *
 * `md` is 800 rather than 960 so that a 1024 tablet clears it with 200px of
 * headroom rather than 30, and `sm` is 552 so a 568px window - the narrowest
 * phone in landscape - still gets two columns of ~180px rather than falling to
 * xs. If you change `.app`'s padding, re-measure and move these with it, and
 * move the media queries in responsive.css, which convert back the other way.
 */
const BREAKPOINTS = {
  lg: 1200, // three columns: chart, book, ticket
  md: 800,  // two columns: chart full width, book and ticket beneath it
  sm: 552,  // two columns: book and ticket; chart becomes a tab of the book
  xs: 0,    // the same two columns, roomier rows for touch
} as const;

/**
 * Row height drives the whole vertical rhythm.
 *
 * lg uses `fitRows: 90`, meaning "the default arrangement is exactly 90 rows
 * tall, so make a row 1/90th of the available height". That is what makes the
 * terminal fill the screen with no page scroll on a desktop, at any monitor
 * height, without hardcoding pixel heights anywhere. Keep the tallest column in
 * the lg layout below summing to 90 or you reintroduce a scrollbar.
 *
 * WHAT N DECIDES, AND WHAT IT DOES NOT.
 *
 * Measured at 1920x1080 the grid gets 988px between the navbar's gutter and the
 * status bar, and the design splits it 656 / 4 / 328 - the trading row is
 * EXACTLY twice the bottom drawer. A uniform grid of N rows and a 4px gutter
 * makes a band of k rows measure `k*(H+4)/N - 4`, so an exact 2:1 split needs
 * the top band at 165/248ths of N; only N = 248 hits it and that puts a row at
 * 0px. Every N divisible by 3 lands the boundary on the SAME pixel instead -
 * 657.3 above it and 326.7 below, 1.3px off the design - because 2/3 is the
 * nearest simple fraction and the residual does not depend on N. (At 50 rows,
 * which is not divisible by 3, the split was 33/17 and the drawer came out 5px
 * tall and the trading row 5px short. Reported independently, twice.)
 *
 * So N is not what places the drawer boundary. N is how FINELY the three bands
 * of the left column can be cut, and 48 was too coarse for two of them. At 48 a
 * row plus its gutter is 20.67px and the strips could only be bought in that
 * size: the market strip took 2 rows (37.3px) to hold an 18px row of chips, the
 * symbol header 3 rows (58px) to hold 35px of content. That is ~42px of the
 * chart's height sitting as air inside two panels, with no smaller purchase
 * available - one row less clipped both.
 *
 * 90 is 48 x 15/8, and that is the whole point of the number: every band that is
 * NOT being re-cut keeps a whole number of rows and therefore its exact pixel
 * height - book and ticket 32 -> 60, the two drawer panels 16 -> 30 - while the
 * left column's 32 rows become 60 and can be spent 11.02px at a time. A row is
 * (988 - 89*4) / 90 = 7.02px, and a band of k rows is k*11.02 - 4:
 *
 *   band          design   rows  ->  actual   miss    was
 *   market strip    36px     3        29.1    -6.9    37.3  (2 rows)
 *   symbol header   56px     5        51.1    -4.9    58.0  (3 rows)
 *   chart+toolbar  556px    52       569.2   +13.2   554.0  (27 rows)
 *   book / ticket  656px    60       657.3    +1.3   657.3  (32 rows)
 *   bottom drawer  328px    30       326.7    -1.3   326.7  (16 rows)
 *
 * THE TWO STRIPS ARE DELIBERATELY UNDER THEIR MEASURED BAND, and that is the
 * one place this file departs from the transcription. Measured on the running
 * app their content is now 18px of chips and 35px of header - the insets inside
 * `.mkt-strip` and `.mkt-header` have been taken in - so a 36px strip and a 56px
 * header would be holding 18px and 21px of air. At 29.1 and 51.1 they keep 5.5px
 * and 8px a side, which is air the eye reads as breathing room rather than as a
 * panel that failed to fill.
 *
 * ONE ROW LESS CLIPS, and that is what fixes these two counts rather than taste.
 * The bands scale with the window, so the binding case is the shortest screen
 * that still fits - 808px of grid, the 900px laptops. There a row plus gutter is
 * 9.02px: the strip's 3 rows are 23.1px against 18px of chips and the header's 5
 * are 41.1px against 35px, both still clear. Two rows and four would be 14.0 and
 * 32.1, i.e. under the content on the screens most people are looking at this
 * on. The ~15px that comes off the two of them goes to the chart, which is the
 * one panel here that can always use it.
 *
 * A FINER GRID USED TO COST SOMETHING AND NO LONGER DOES. The floor in
 * Dashboard.tsx was a floor on the ROW (12px), so raising the row count raised
 * the height at which the terminal gives up fitting and scrolls: 764px of
 * container at 48 rows, 812 at 51, and it would have been 1436 here. That is why
 * the count sat at 48 - 51 rows would have put a scrollbar on every 900px
 * laptop. The floor is now stated as a minimum DASHBOARD HEIGHT (764px, exactly
 * what 48 rows at a 12px row floor produced), so the scroll threshold is the
 * same number at 48 rows, at 90, and at whatever this becomes next.
 *
 * md/sm/xs use fixed row heights and let the page scroll - see the note on
 * GridMetrics.fitRows for why deriving one there does not work. 26px is one
 * `--fs-base` line plus its leading, so a row is a natural unit of table. Only
 * lg derives a row, so those three tiers are untouched by the 48 -> 90 change;
 * their own strip heights move for the separate reason given at MD below.
 *
 * The gutter is 4px everywhere now, at every breakpoint, because the design has
 * exactly one gutter and it is 4px. It used to be 6px above xs, which quietly
 * spent ~1.5% of a 1920px screen and, worse, meant the terminal had a different
 * rhythm at every size.
 */
const GRID: DashboardConfig['grid'] = {
  // `rowHeight` here is only the fallback for the degenerate case `fitRows`
  // cannot serve - a dashboard that has a width but no measurable height yet.
  // It is 7 rather than the 16 it was at 48 rows for the obvious reason: 90 rows
  // of 16px is a 1796px grid, and the point of the fallback is to be roughly the
  // size the real thing will be (7 gives 986px against the 956 that 48 x 16 did).
  lg: { cols: 48, rowHeight: 7, fitRows: 90, margin: [4, 4], containerPadding: [0, 0] },
  // ONLY lg derives a row height. `fitRows` divides the dashboard's measured
  // height, so it needs that height to be DEFINITE - and it only is where
  // styles.css pins the shell to the viewport, which it does from a 994px
  // window up. `md` now starts at an 824px window, so half of its range has an
  // auto-height scroller whose height is its own content height: dividing that
  // to size the rows that produce it is a fixed point of itself, and the guard
  // in Dashboard.tsx only catches the height-zero case, not that one.
  //
  // So md/sm/xs use a fixed row and let the page scroll. 26px is one
  // `--fs-base` line plus its leading, which makes a row a natural unit of
  // table. The md layout is sized so the chart band still lands on the fold at
  // 1024x768 - see MD below - which is what the derived row was there to do.
  md: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
  sm: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
  xs: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
};

/**
 * lg - the full terminal, transcribed from the measurement at 1920x1080.
 *
 *   x0          28        38     48
 *   y0  +--------+---------+------+   markets  29   (3 rows)
 *    3  +--------|         |      |   ticker   51   (5 rows)
 *    8  +--------|  book / | order|
 *       |        |  trades | entry|   chart   569  (52 rows)
 *       | chart  |         |      |
 *   60  +--------+---------+------+
 *       | account activity | acct |   bottom  327  (30 rows)
 *   90  +------------------+------+
 *
 * Pixels this resolves to at a 1912px content width and a 988px grid height,
 * measured on the running app rather than predicted:
 *
 *   markets   x4    y60    1114 x  29
 *   ticker    x4    y93    1114 x  51
 *   chart     x4    y148   1114 x 569   (its own 48px toolbar + the canvas)
 *   book      x1122 y60     395 x 657
 *   exec      x1521 y60     395 x 657
 *   positions x4    y721   1513 x 327
 *   account   x1521 y721    395 x 327
 *
 * The drawer boundary has not moved: the left column still totals 657.3px, so
 * `positions` starts at y721 exactly as it did when the strips were 37 and 58.
 * The 15.2px they gave up is inside the chart, not under it.
 *
 * `positions` at w38 spans the chart column AND the book column - 1512.8px -
 * which is the measured 1513, and leaves the account panel alone under the
 * ticket. That is the one asymmetry in the design and it is deliberate: the
 * account summary is a statement about you, the band beside it is the flow.
 *
 * THREE independent column budgets, all of which must total 90 or a panel
 * lands out of line with its neighbour:
 *   cols  0-27   3 + 5 + 52 + 30 = 90
 *   cols 28-37   60 + 30         = 90
 *   cols 38-47   60 + 30         = 90
 *
 * Column widths at the two ends of the lg range (colW = (C - 188) / 48). The
 * narrow end is a 1280px window, which the measured design still gives three
 * columns; the wide end is 1920:
 *                      C=1256   C=1876
 *   chart      w28      731      1093    always the widest panel
 *   book       w10      258       391    >= 200 ok
 *   exec       w10      258       391    the ticket wraps below ~330, so at the
 *                                        1280 end its labelled rows are taller;
 *                                        it is `scroll: auto`, so that is a
 *                                        scroll, never a clipped submit button
 *   positions  w38      993      1484
 *   account    w10      258       391
 *
 * Those are ~20px narrower than the measured 1114/395/395 at 1920, and all of
 * the difference is page margin: the design insets its panels 4px from the
 * window and `.app` in styles.css insets ours 12px, with another 10px a side
 * lost to `--content-max` above a 1900px window. Both live outside this
 * directory. The RATIO is exact - 28/10/10 of 48 - so the columns land right
 * the moment that inset does.
 */
const LG: DashboardConfig['layouts']['lg'] = [
  { i: 'markets',   x: 0,  y: 0,  w: 28, h: 3 },
  // 5 -> 4 rows. The gate that shipped this file's "deliberately under-band"
  // strip/header pair reduced .mkt-header's own CSS floor from 40px to 35px
  // (Market.css) in the same pass but did not follow through here, so the
  // grid kept reserving the OLD floor's row count and the header sat at
  // 51.1px instead of moving with its own content. h:4 -> 4*11.02-4 = 40.08px,
  // still 5px clear of the 35px floor. Chart absorbs the freed row.
  { i: 'ticker',    x: 0,  y: 3,  w: 28, h: 4 },
  { i: 'chart',     x: 0,  y: 7,  w: 28, h: 53 },
  { i: 'book',      x: 28, y: 0,  w: 10, h: 60 },
  { i: 'exec',      x: 38, y: 0,  w: 10, h: 60 },
  { i: 'positions', x: 0,  y: 60, w: 38, h: 30 },
  { i: 'account',   x: 38, y: 60, w: 10, h: 30 },
];

/**
 * md - TWO columns, 800..1199px of container (roughly an 824px window through a
 * 1223px one; a 1024 tablet lands here at 1000px).
 *
 * The measured design collapses to two columns at 1024, and the shape it
 * collapses INTO is the chart full width with the book and the ticket side by
 * side beneath it. Nothing is hidden - the third column's contents move down
 * rather than away, which is the rule: a panel dropped at a breakpoint has to
 * stay reachable, and here none is dropped at all.
 *
 * Why book and exec are 24 columns each rather than the 12/16 split the old
 * three-column md used: they are the same panel width in the design at every
 * tier, and at C=1000 half the width is 490px - more than either has ever had
 * below lg, so the ticket's labelled rows stop wrapping and the book's three
 * columns stop being a horizontal scroller.
 *
 * Heights (30n - 4 px at 26px rows, 4px gutters), and where the fold lands on
 * the commonest window at this tier, 1024x768, whose scroller measures ~646px:
 *
 *   markets   2 =  56   ONE row would be 26px and is not enough. The chips are
 *                       18px of text, but responsive.css gives every control in
 *                       `.dash` a 40px touch target below a 994px window - and
 *                       md reaches down to an 808px one, so half this tier
 *                       renders a 40px chip row and would have it clipped.
 *                       56px is the floor, not a choice.
 *   ticker    2 =  56   was 4 = 116, on the since-corrected belief that the
 *                       header wraps to two lines here. `.mkt-header` is a
 *                       nowrap horizontal scroller (Market.css) and does not
 *                       wrap at any width: it measures 35px, or 40px below a
 *                       994px window where its market button becomes a touch
 *                       target. 56px holds either; 116 held 76px of nothing.
 *   chart    17 = 506   56 + 4 + 56 + 4 + 506 = 626, so the chart band still
 *                       ends 20px ABOVE the fold and keeps its whole time axis -
 *                       the 60px the ticker gave up went straight into it
 *   book/exec 18 = 536  one band, both the same height, or the panels under
 *                       them compact to different heights per column
 *   positions 12 = 356
 *   account   8 = 236   full width, so the summary is two columns
 *
 * Everything from `book` down keeps its row, because markets + ticker + chart
 * still totals 21.
 */
const MD: DashboardConfig['layouts']['md'] = [
  { i: 'markets',   x: 0,  y: 0,  w: 48, h: 2 },
  { i: 'ticker',    x: 0,  y: 2,  w: 48, h: 2 },
  { i: 'chart',     x: 0,  y: 4,  w: 48, h: 17 },
  { i: 'book',      x: 0,  y: 21, w: 24, h: 18 },
  { i: 'exec',      x: 24, y: 21, w: 24, h: 18 },
  { i: 'positions', x: 0,  y: 39, w: 48, h: 12 },
  { i: 'account',   x: 0,  y: 51, w: 48, h: 8 },
];

/**
 * sm / xs - TWO columns: order book left, order ticket right, symbol header
 * full width above them. That is the measured layout at both 768 and 390, and
 * it is not a stack: the two things you need at once on a small screen are the
 * price ladder and the box you type a size into, and stacking them puts the
 * submit button a scroll away from the depth you are reading it against.
 *
 * The chart is NOT here. It is a tab of the book panel at these two
 * breakpoints - see `isNarrow` in registry.tsx - which is what makes dropping
 * it from the grid legitimate. A panel that is dropped and not picked up
 * somewhere else is a feature that silently does not exist on a phone.
 *
 * Drag and resize are off below `md` (responsive.css): the arrangement is fixed
 * and a drag gesture on touch only ever competes with the scroll.
 *
 * `pair` lays out the shared spine - full-width strip, full-width header, then
 * the two-column band, then the full-width tables - keeping a running `y` so
 * changing one height never means renumbering everything below it.
 */
const pair = (h: {
  markets: number; ticker: number; band: number; positions: number; account: number;
}): DashboardConfig['layouts']['sm'] => {
  let y = 0;
  const full = (i: string, rows: number) => {
    const row = { i, x: 0, y, w: 48, h: rows };
    y += rows;
    return row;
  };
  const out = [full('markets', h.markets), full('ticker', h.ticker)];
  // FULL WIDTH, not a 24/24 split with `exec`. Chart, book+trades and the
  // order ticket are each a full-width page of a horizontal swipe carousel
  // at this width now (see MobileCarousel.tsx, wired in through the `book`
  // panel's own render at isNarrow breakpoints) - `exec` is not placed here
  // at all any more (`when: !isNarrow` on its definition), because the
  // carousel renders it directly as its third page instead of a second grid
  // cell squeezed to half a phone's width.
  out.push({ i: 'book', x: 0, y, w: 48, h: h.band });
  y += h.band;
  out.push(full('positions', h.positions), full('account', h.account));
  return out;
};

/**
 * sm - 552..799px of container (a 568px window through an 823px one; a 768
 * tablet lands here at 744px, giving two 370px columns).
 *
 * Heights (30n - 4 px at 26px rows, 4px gutters):
 *   markets 2 = 56   one row of chips. 40px of it below a 994px window, which
 *                    is all of this tier - see MD - so 2 rows is the floor.
 *   ticker  2 = 56   was 4 = 116. `.mkt-header` does not wrap at this width or
 *                    any other: it is a nowrap horizontal scroller, and here it
 *                    measures 40px because its market button is a touch target.
 *                    The 60px this returns is 60px less to scroll past on the
 *                    way to the book, which is the panel this tier exists for.
 *   band   22 = 656  book and ticket. The ticket is the taller of the two at
 *                    370px of panel and it is `scroll: 'auto'`, so anything
 *                    short of its measured height is an internal scroll rather
 *                    than a clipped submit button; the book fills whatever it
 *                    is given, ~14 levels a side here.
 *   positions 12 = 356
 *   account 7 = 206  full width, so the summary is two columns and 124px tall
 */
const SM = pair({ markets: 2, ticker: 2, band: 22, positions: 12, account: 7 });

/**
 * xs - below 552px of container. The measured 390 phone: two 185px columns.
 *
 * Heights (30n - 4 px at 26px rows, 4px gutters):
 *   markets 2 = 56   chips scroll sideways, and each one is a 40px touch target
 *                    at this width, so two rows is the floor rather than the
 *                    room for a scrollbar (the strip hides its own)
 *   ticker  3 = 86   the name and the price take the first line; the stats
 *                    wrap onto a second. Two rows left them a 20px sliver.
 *   band   24 = 716  larger than sm on purpose: the 40px touch targets applied
 *                    below `md` make the ticket taller than it is on desktop,
 *                    and `.booktable td` is 6px-padded there too, so a book row
 *                    is 30px against 27px on desktop - at 185px wide the book
 *                    needs the height to show both sides, which it must.
 *   positions 11 = 326
 *   account  9 = 266 narrow, so the summary is ONE column and 206px tall
 */
const XS = pair({ markets: 2, ticker: 3, band: 24, positions: 11, account: 9 });

/** The trade page dashboard. */
export const TRADE_DASHBOARD: DashboardConfig = {
  // Bump to invalidate every saved layout and push these defaults to everyone.
  // v2: retuned every breakpoint against measured content minimums, and moved
  // the lg threshold down to 1360 so a 1440px laptop gets the real terminal.
  // v3: md becomes three columns so the order book is on the first screen at
  // 1024; lg gives the chart/book band a row back from the positions band.
  // v4: lg's right column is re-cut - the ticket drops to the rows it measures,
  // the account moves up under it, and the tape takes the bottom of that column.
  // v5: the grid itself changes shape. 48 columns and a 4px gutter at every
  // breakpoint, 50 rows at lg, so the measured 1114/395/395 split and the
  // 40/52/48+508 row rhythm land within a few pixels; the market strip is
  // mounted for the first time; the tape stops being a panel and becomes a tab
  // of the book. A saved layout from v4 refers to a 12-column grid and to a
  // `trades` panel that no longer exists, so this bump is not optional.
  // v6: the responsive tiers are re-cut against the measured design. lg reaches
  // down to 1280 (three columns there, not two); md becomes TWO columns with
  // the chart full width; sm and xs stop being a single stack and become the
  // measured two-column phone/tablet layout - book left, ticket right, header
  // full width above - with the chart moving into the book's tab bar. A saved
  // sm/xs layout from v5 places a `chart` panel that is not mounted at those
  // breakpoints and stacks everything full width, so this bump is not optional
  // either.
  // v7: lg's row budget goes 50 -> 48 so the trading row and the bottom drawer
  // land on the measured 2:1 split instead of 5px off it - see the note on
  // GRID above. A saved lg layout from v6 is written in 33/17 rows against a 48
  // row grid, which would run 2 rows past the bottom of the viewport and put a
  // scrollbar on the terminal, so this bump is not optional either.
  // v8: the two header strips give back the air they were holding. lg's row
  // budget goes 48 -> 90 - the finest cut that keeps every unchanged band on a
  // whole number of rows - so the market strip can be 29px instead of 37 and the
  // symbol header 51 instead of 58, with the 15px going to the chart; md, sm and
  // xs drop the ticker from 4 rows to 2, which is 60px each. A saved layout from
  // v7 is written in 48-row units against a 90-row grid: every lg panel would be
  // 47% short and the whole terminal would end in a 460px dead band, so this
  // bump is not optional either.
  id: 'trade',
  version: 11, // xs ticker is 3 rows so the price stays put and the stats wrap under it
  breakpoints: BREAKPOINTS,
  grid: GRID,
  layouts: { lg: LG, md: MD, sm: SM, xs: XS },
};

/* ===========================================================================
 *  THE PORTFOLIO DASHBOARD
 *
 *  Same machinery as the trade terminal, different furniture. The page was a
 *  hand-written CSS grid - a 320px rail and a three-band main column - which
 *  meant the one page a user most wants to rearrange was the one page whose
 *  arrangement was a constant in a stylesheet.
 *
 *  A FIXED ROW HEIGHT AT EVERY BREAKPOINT, unlike the trade page's derived
 *  `fitRows` at lg. The terminal pins itself to the viewport and divides that
 *  height into rows; this page scrolls, so its height is its own content height
 *  and dividing that to size the rows that produce it is a fixed point of
 *  itself. 26px is one --fs-base line plus leading, so a row is a natural unit
 *  of the 20px stat rows these panels are built from.
 * ======================================================================== */

/** 12 of 48 columns is the 320px rail the design measured, at a 1440px page. */
const PF_LG: PanelPlacement[] = [
  // The account card carries the fee rate and 7-day volume itself now; the
  // separate fees panel is opt-in (Edit layout).
  { i: 'account',     x: 0,  y: 0,  w: 12, h: 22 },
  { i: 'performance', x: 0,  y: 22, w: 12, h: 10 },
  { i: 'value',       x: 12, y: 0,  w: 18, h: 13 },
  { i: 'pnl',         x: 30, y: 0,  w: 18, h: 13 },
  { i: 'capital',     x: 12, y: 13, w: 18, h: 9 },
  { i: 'exposure',    x: 30, y: 13, w: 18, h: 9 },
  // The band carries eight account tabs (positions through account history), so
  // it runs to row 40 - where the rail ends once My copies sits under it.
  { i: 'band',        x: 12, y: 22, w: 36, h: 18 },
  { i: 'copies',      x: 0,  y: 32, w: 12, h: 8 },
];

/** Two columns. The charts keep their pairing; the rail's three cards break up
 *  and fill the width rather than staying a 320px ribbon on a 900px page. */
const PF_MD: PanelPlacement[] = [
  { i: 'value',       x: 0,  y: 0,  w: 24, h: 13 },
  { i: 'pnl',         x: 24, y: 0,  w: 24, h: 13 },
  { i: 'capital',     x: 0,  y: 13, w: 24, h: 9 },
  { i: 'exposure',    x: 24, y: 13, w: 24, h: 9 },
  { i: 'account',     x: 0,  y: 22, w: 24, h: 22 },
  { i: 'performance', x: 24, y: 22, w: 24, h: 10 },
  { i: 'band',        x: 0,  y: 40, w: 48, h: 18 },
  { i: 'copies',      x: 0,  y: 58, w: 24, h: 8 },
];

/** One column. A two-up chart on a phone is two unreadable charts. Order is
 *  reading order: what the account is worth, then how it got there, then the
 *  risk on it, then the ledger. */
const PF_SM: PanelPlacement[] = [
  { i: 'value',       x: 0, y: 0,  w: 48, h: 13 },
  { i: 'pnl',         x: 0, y: 13, w: 48, h: 13 },
  { i: 'account',     x: 0, y: 26, w: 48, h: 15 },
  { i: 'capital',     x: 0, y: 41, w: 48, h: 9 },
  { i: 'exposure',    x: 0, y: 50, w: 48, h: 9 },
  { i: 'performance', x: 0, y: 59, w: 48, h: 10 },
  { i: 'band',        x: 0, y: 69, w: 48, h: 18 },
  { i: 'copies',      x: 0, y: 87, w: 48, h: 8 },
];

export const PORTFOLIO_DASHBOARD: DashboardConfig = {
  id: 'portfolio',
  // 3: the phone column's account card was 22 rows, most of them empty, so
  // the margin card sat a long blank scroll below the buttons.
  version: 3,
  breakpoints: { lg: 1200, md: 800, sm: 552, xs: 0 },
  grid: {
    lg: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
    md: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
    sm: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
    xs: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
  },
  // xs reuses sm: both are the single column, and the difference the trade page
  // makes between them (roomier touch rows) is carried by the panels' own
  // content here, not by their boxes.
  layouts: { lg: PF_LG, md: PF_MD, sm: PF_SM, xs: PF_SM },
};

/* ===========================================================================
 *  THE POINTS DASHBOARD
 *
 *  Same machinery, same fixed 26px row as the portfolio - this page scrolls, so
 *  it cannot derive a row height from a container whose height is its own
 *  content height.
 * ======================================================================== */

/*
 * A LEFT RAIL AND A MAIN COLUMN, which is a different shape from the other two
 * dashboards on purpose.
 *
 * The points card is the one object on this page you would screenshot, and the
 * per-point rail is what explains it - so those two own a narrow column and stay
 * together. Everything that is a chart or a grid needs width, and gets the rest.
 */
const PT_LG: PanelPlacement[] = [
  { i: 'mine',        x: 0,  y: 0,  w: 12, h: 11 },
  { i: 'economics',   x: 0,  y: 11, w: 12, h: 13 },
  { i: 'standing',    x: 0,  y: 24, w: 12, h: 9 },
  { i: 'difficulty',  x: 12, y: 0,  w: 36, h: 16 },
  { i: 'weeks',       x: 12, y: 16, w: 36, h: 13 },
  { i: 'tiers',       x: 12, y: 29, w: 18, h: 9 },
  { i: 'programme',   x: 30, y: 29, w: 18, h: 9 },
];

/** Two columns. The rail's cards pair off; the chart and the grid go full width. */
const PT_MD: PanelPlacement[] = [
  { i: 'mine',        x: 0,  y: 0,  w: 24, h: 11 },
  { i: 'economics',   x: 24, y: 0,  w: 24, h: 11 },
  { i: 'difficulty',  x: 0,  y: 11, w: 48, h: 15 },
  { i: 'weeks',       x: 0,  y: 26, w: 48, h: 13 },
  { i: 'standing',    x: 0,  y: 39, w: 24, h: 9 },
  { i: 'tiers',       x: 24, y: 39, w: 24, h: 9 },
  { i: 'programme',   x: 0,  y: 48, w: 48, h: 8 },
];

/** One column, in reading order: what you have, what it cost, how it moved. */
const PT_SM: PanelPlacement[] = [
  { i: 'mine',        x: 0, y: 0,  w: 48, h: 11 },
  { i: 'economics',   x: 0, y: 11, w: 48, h: 13 },
  { i: 'difficulty',  x: 0, y: 24, w: 48, h: 14 },
  { i: 'weeks',       x: 0, y: 38, w: 48, h: 13 },
  { i: 'standing',    x: 0, y: 51, w: 48, h: 9 },
  { i: 'tiers',       x: 0, y: 60, w: 48, h: 9 },
  { i: 'programme',   x: 0, y: 69, w: 48, h: 8 },
];

export const POINTS_DASHBOARD: DashboardConfig = {
  id: 'points',
  /* Bumped: the rail/main split and the new `economics` panel make every saved
     v1 layout wrong, and a stale one would place the chart in a 12-column slot. */
  version: 2,
  breakpoints: { lg: 1200, md: 800, sm: 552, xs: 0 },
  grid: {
    lg: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
    md: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
    sm: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
    xs: { cols: 48, rowHeight: 26, margin: [4, 4], containerPadding: [0, 0] },
  },
  layouts: { lg: PT_LG, md: PT_MD, sm: PT_SM, xs: PT_SM },
};
