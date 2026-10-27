# TradingView Advanced Charts in ValueDesk

The chart panel runs on **klinecharts** (Apache-2.0, bundled) by default. The
code in `src/chart/tv/` can swap in **TradingView Advanced Charts** instead,
once you have the library and switch it on. With the switch off, which is the
default, none of that code runs. Not even the check for the library files runs.

This page covers:

1. [Getting the library](#1-getting-the-library-application)
2. [Licence obligations](#2-licence-obligations)
3. [Installing and switching it on](#3-installing-and-switching-it-on)
4. [Feature comparison](#4-feature-comparison)
5. [Order and position lines: DIY vs the paid Trading Platform](#5-order-and-position-lines-diy-vs-the-paid-trading-platform)
6. [Failsafes (both charts)](#6-failsafes-both-charts)
7. [Code map](#7-code-map)

---

## 1. Getting the library (application)

Advanced Charts is free, but you do not download it. TradingView grants each
applicant access to its **private** GitHub repository, one applicant at a time.
Never take it from npm, a CDN, a mirror or someone else's fork. Those copies
are unlicensed, and this integration refuses to point at them.

When this was written, the process was as follows. Check it against
tradingview.com when you apply.

1. Go to the Advanced Charts page on **tradingview.com** and open the request
   form ("Get the library").
2. Fill in:
   - the company or project name, and a contact,
   - the **public URL** where the chart will appear. It has to be a live,
     publicly reachable website, and the chart page must be free to open (see
     section 2),
   - what the chart is used for: a crypto trading and copy-trading front end
     for SoDEX, with its own market data,
   - the **GitHub username** that should get access to the repository.
3. TradingView reviews the request. This can take days, and they may ask
   follow-up questions. If they approve it, the GitHub account gets read access
   to the private `charting_library` repository and you accept the licence
   agreement.
4. Pick a release tag from that repository and install it (section 3).

## 2. Licence obligations

These are the obligations to plan for. The binding text is the agreement you
accept in step 3 above, so read it again when you sign. It wins over this list.

| Obligation | What it means here | Status in this code |
|---|---|---|
| **Public, free-access site only** | The chart must be on a public website that anyone can open without paying. It cannot sit behind a paywall or subscription, in an internal tool, or in a closed app. | Your decision on deployment. The `/trade` page must stay free to open. |
| **Library never in a public repo** | The library files must not be committed to a public repository or redistributed in any other way. | `apps/web/public/charting_library/` is in the root `.gitignore`. Keep it there. Check `git status` before every push. |
| **Attribution: TradingView logo and link** | The TradingView logo on the chart stays visible. A link to tradingview.com is shown, and it must **not** carry `rel="nofollow"`. | `widget_logo` can never be disabled (`options.ts` strips it, and `support.test.ts` fails if it is disabled). The footer shows "Chart by TradingView" with `rel="noopener"` only (`TvChart.tsx`). |
| **A TradingView section on the site** | A page or section that says the charts are by TradingView, with a link. | To do on the marketing or about page before launch. |
| **Announcement post** | A public post (blog, X or similar) announcing that the site uses TradingView charts. | To do at launch. |
| **Website-terms clause** | Your terms of use mention the TradingView charts and their terms. | To add to the site's terms before launch. |

Also note: **the library build is not yours to modify.** Change its appearance
only through the widget options, `overrides` and custom CSS, which is what
`theme.ts` and `tv-theme.css` do.

## 3. Installing and switching it on

### Files

```
# from YOUR access to TradingView's private repo, a release tag
cp -r <charting_library checkout>/charting_library  apps/web/public/charting_library
```

The folder must contain `charting_library.standalone.js` and its `bundles/`
directory. It is served from `/charting_library/`. It is **gitignored**, so
never force-add it.

### Headers and CSP

The dev server has to allow framing today. The library draws inside a
**same-origin iframe** (`/charting_library/…`), and two things currently block
that:

- `vite.config.ts` sends `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'` on **every** path.
  `/charting_library/` needs `X-Frame-Options: SAMEORIGIN` and
  `frame-ancestors 'self'` instead. Keep DENY for everything else, because it
  protects the order and withdrawal confirmations against clickjacking.
- The CSP `<meta>` in `index.html` has `frame-src https://verify.walletconnect.org`.
  Add `'self'` to it.

Production has to send the same headers (see `DEPLOYMENT.md`). If framing is
refused, the chart detects it and falls back to klinecharts. The console then
says so and names this section.

### Switch

```
# apps/web/.env.local
VITE_CHART=tradingview
```

Restart `npm run dev`, because Vite reads `.env.local` only at start-up.
Any other value, or no value, keeps klinecharts.

### What happens then

`src/chart/tv/switch.tsx` checks for `/charting_library/charting_library.standalone.js`
once per page. The check reads the content type, because a missing file comes
back as the app's own `index.html` with status 200. If the file is there, the
panel mounts `TvChart`. In any of these cases the panel falls back to the
klinecharts chart for the rest of the page load, and the console prints one
line with the reason:

- the files are missing,
- the script fails to load,
- the frame is refused,
- the widget throws or is not ready within 30 s.

The panel never ends up empty.

### Letting TradingView order lines move orders

The TradingView chart **never sends anything itself**. To let a dragged order
line modify the order, the host passes the app's existing modify path:

```tsx
// dashboard/registry.tsx, both <Chart …/> usages
onModifyOrder={(body) => api.modifyOrder(body)}
```

Without that prop the lines are drawn read-only. The same gates as on the
klinecharts chart apply on top of it: perps only, and only with an unlocked
signing key.

### Official typings

`src/chart/tv/types.ts` is a minimal set of local declarations, written from the
public docs so that the code typechecks without the library. Once the library is
installed, you can import `charting_library.d.ts` and `datafeed-api.d.ts`
instead. The names match one for one.

## 4. Feature comparison

| | klinecharts (default) | TradingView Advanced Charts (free) | TradingView Trading Platform (paid) |
|---|---|---|---|
| Licence | Apache-2.0, bundled from npm | Free, by application, public free-access sites only, attribution | Commercial licence |
| Where it runs | Our canvas, in the panel | Same-origin iframe from `/charting_library/` | Same |
| Indicators | 27 built in | 100+ built in, plus templates | Same as Advanced Charts |
| Drawing tools | ~16, plus our measure tool | 80+ | Same |
| Layout save and load | – | Yes (`saveLoad.ts`, localStorage) | Yes |
| Timeframes | Every gateway interval | Same set (derived from the same table) | Same |
| Live candles | Hub `candle` channel | Same channel, through the JS-API datafeed | Same |
| Loading, retry and stale failsafes | Yes (section 6) | Yes, the same logic (section 6) | – |
| Resting orders on the chart | Drag to modify, with confirm | **DIY drawings** (section 5): drag, then confirm | Native order lines |
| Position entry | Line with label | Locked line with **live PnL** text | Native position line with PnL and close button |
| Right-click to prefill the ticket | Yes | – | Via the broker API |
| Mark / Oracle | Mark (Oracle disabled, no series) | Mark line toggle and Last line toggle | Same |
| Order ticket, DOM, account manager | Our own panels | Our own panels | Built in (broker API) |

## 5. Order and position lines: DIY vs the paid Trading Platform

The owner asked whether order and position lines can be added without the paid
Trading Platform. **Yes, with the free drawings API.** This is implemented
behind the same flag:

| | DIY on Advanced Charts (this code) | Trading Platform |
|---|---|---|
| API | `createMultipointShape` (`horizontal_line`) with text and overrides | `createOrderLine()` / `createPositionLine()` |
| Position line | `lock: true`, cannot be selected. Its text is rewritten in place with the live PnL, `(last − entry) × size × direction`, at most twice a second, and never redrawn. | Built in, with PnL, reverse and close buttons |
| Order line | Draggable when a modify is possible. The widget's `drawing_event` (`move` / `points_changed`) triggers a read of `getShapeById(id).getPoints()`, and the price is snapped to the tick. | Native drag handle, `onMove` callback |
| After a drop | A **confirm bar**, the same one as on klinecharts. Only "Confirm" calls the host's `onModifyOrder`. The line stays where it was dropped until the venue reports the new price. It goes back on cancel, on rejection, or after 15 s without confirmation. | Your broker adapter decides |
| Cancel from the chart | No (use Open orders) | Built-in ✕ button |
| Deleting the line by hand | It is redrawn at once, because deleting a drawing does not change the order | n/a |
| Saved into layouts or undo | Never (`disableSave`, `disableUndo`, hidden from the objects tree) | n/a |
| Styling | Line colour, style and width, and the text | Full label box: quantity, buttons, colours |

What DIY cannot do: a cancel or close button on the line, the quantity box
beside the label, bracket (TP/SL) handles, and the account manager or DOM
widgets. If you need those, you need the Trading Platform licence.

## 6. Failsafes (both charts)

Both charts use the same failsafe logic from `src/chart/feedHealth.ts`.
`FeedOverlay.tsx` provides the shared UI.

- **Loading.** While the first bars of a market load, and on every symbol or
  interval switch, the plot shows skeleton candles and "Loading BTC-USD · 1m".
  The canvas is masked, so the previous market's candles, or a bare 0-10
  price scale, are never visible. The mask also swallows clicks. The chart
  fades in when the first bars land.
- **Timeout and retry.** The first page gets 8 s. A timeout or a failure is
  retried after 1 s, 2 s, 5 s, 10 s, and then every 15 s, with a
  "Reconnecting…" pill and a countdown. After 3 failures an error card says
  only "Chart couldn't load." with a **Retry** button (the reason is in the
  console). The background retries keep going
  either way. A 4xx other than 408/425/429 goes straight to the error card and
  keeps retrying at 15 s. A switch cancels the load in flight and aborts its
  request, so a late answer from the previous market can never land.
- **Stale detection.** The chart counts as stale when:
  - the last traded price moved but no candle update arrived for 30 s. This is
    the one signal that works on every interval, including 1D.
  - the newest bar is older than 2 intervals + 15 s while the stream is open.
  - the stream has been silent for max(2 intervals, 30 s).
- **Auto-recovery.** On stale, the candle channel is re-subscribed and the
  right edge is refetched. The page is sized to the gap (10 to 500 bars). The
  refetched bars are merged so that nothing is duplicated:
  - bars that are new or grew are appended through the realtime path,
  - a live bar is never pulled back by an older REST snapshot (volume only
    grows while a bar is open),
  - a hole in the middle triggers a silent rebuild on klinecharts (no mask,
    scroll position kept), or `onResetCacheNeeded` plus `resetData()` on
    TradingView.

  The same gap-fill runs after a **hub reconnect** and when the **tab becomes
  visible** after 5 s or more hidden. While the hub is down, the chart is
  refreshed from REST every 15 s.
- **Request budget.** Stale checks that find nothing new back off: 15 s, then
  30 s, then 60 s, then every 2 min. A quiet market with no trades therefore
  costs one small request every 2 minutes.
- **Live / Delayed.** A word with a dot in the chart footer. **Delayed** (amber)
  means one of:
  - the stream is reconnecting,
  - candles were missing while the market traded,
  - a refresh failed.

  It returns to **Live** as soon as the stream delivers a candle again. Hover
  the word to see the reason.
- **The chart library itself.** If the klinecharts chunk fails to download,
  for example after a dev-server restart, the panel shows the same "Chart
  couldn't load." card with Retry, and retries on the same schedule.

## 7. Code map

```
src/chart/feedHealth.ts        failsafe logic: retry, staleness, watchdog, merge (pure, tested)
src/chart/FeedOverlay.tsx      skeleton / reconnecting / error / empty overlay + Live·Delayed
src/chart/klines.ts            GET /api/md/{engine}/klines with abort + endTime
src/components/Chart.tsx       klinecharts chart (default) - uses the three above
src/chart/tv/flag.ts           VITE_CHART=tradingview
src/chart/tv/loader.ts         probe + load /charting_library/charting_library.standalone.js
src/chart/tv/switch.tsx        klinecharts or TradingView, with fallback
src/chart/tv/TvChart.tsx       the widget, theme, toggles, failsafe UI, DIY lines + confirm
src/chart/tv/datafeed.ts       JS-API datafeed (symbols, klines, hub candles) + failsafes
src/chart/tv/datafeedCore.ts   resolutions, pricescale/minmov from tick size, paging (pure)
src/chart/tv/lines.ts          line shapes, live PnL text, drag -> modify request (pure)
src/chart/tv/lineManager.ts    diffing + drawing_event handling on the drawings API
src/chart/tv/saveLoad.ts       localStorage save/load adapter
src/chart/tv/theme.ts, tv-theme.css, options.ts, types.ts
```

Tests: `npx tsx --test src/chart/*.test.ts src/chart/tv/*.test.ts`
