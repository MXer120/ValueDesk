# Performance

Phase 1 of the pre-launch performance pass (web runtime and build), and the
server response plugin (Phase 1b). Written 2026-09-30.

**The rule every change here follows: nothing a user can see may change.**
Pixel-identical rendering, identical behaviour, no new loading states,
flashes, font swaps, layout shifts or noticeable timing changes. Faster is
fine. Every change below was measured against that rule, and the ones that
could not pass it are listed under [Not done](#not-done-because-it-would-be-visible)
with the reason.

## Results

Baseline is the pristine `983eb85` tree; "after" is that same tree plus only
the changes in this document (the other agents' work in progress is excluded
from the comparison, so the numbers are attributable). Production builds,
served by `vite preview` and proxied to the live backend.

### Bundle

| | before | after | |
|---|---|---|---|
| JS parsed before the first render (entry + static imports) | 1 chunk, 1,325 kB raw / 426 kB gzip / 344 kB br | 2 chunks, 520 kB / 173 kB / 146 kB | **−61 % / −59 % / −58 %** |
| First-paint JS, landing on **trade** (entry + page + palette chunks) | 1,325 kB / 426 kB | 1,145 kB / 379 kB | −14 % / −11 % |
| … on **explore** | 1,325 / 426 | 971 / 318 | −27 % / −25 % |
| … on **copy** | 1,325 / 426 | 958 / 317 | −28 % / −26 % |
| … on **leaderboard** | 1,325 / 426 | 823 / 274 | −38 % / −36 % |
| … on **portfolio** | 1,325 / 426 | 907 / 299 | −32 % / −30 % |
| … on **scan** | 1,325 / 426 | 949 / 311 | −28 % / −27 % |
| All JS (every chunk, incl. wallet/AppKit, chart) | 124 chunks, 5,699 kB / 1,700 kB | 144 chunks, 5,709 kB / 1,715 kB | +0.2 % (chunk overhead) |
| CSS | 360 kB / 60 kB, one file | **byte-identical file** (same hash) | 0 |
| Fonts | 36 files, 469 kB | unchanged | 0 |
| Logos (`public/logos`) | 586 files, 8,359 kB | 7,779 kB (−437 kB on the wire) | −6.9 % |
| `public/scan` legacy scripts | 102 kB | removed | |

"First paint" counts every chunk the page waits for; they download in
parallel (the palette's are announced in `index.html`, see below), so the
critical path is shorter than the sum suggests.

Where the first-load bytes went (baseline entry, 1,325 kB): app components
319 kB, react-dom 130, app root modules 92, funds sheets 86, chart 82,
palette 77, Explore 76, Copy 56, dashboard 55, trading 53, Scan 49,
@sodex-core 38, react-draggable 28, @noble 46, react-grid-layout 20. The
wallet stack (viem, ethers, AppKit, WalletConnect, Coinbase: ~2.9 MB) and
klinecharts (231 kB) were already loaded on demand and still are.

### Runtime

Headless Chrome 154, 1920×1080, cold cache, median of 3 runs per build with
the two builds interleaved run by run (same backend state). **fast** = no
throttling (localhost); **slow** = 10 Mbit/s, 40 ms RTT, 4× CPU slowdown. TBT
is FCP→TTI (Lighthouse's definition); "TBT incl. load" also counts the
blocking before the first paint. TTI "-" = never quiet for 5 s within 45 s.

| page [profile] | FCP ms | LCP ms | TBT ms | TBT incl. load ms | TTI ms | long tasks ms | requests | transferred kB | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|
| trade [fast] | 328 → 328 | 328 → 328 | 0 → 0 | 106 → 108 | 328 → 328 | 156 → 158 | 32 → 53 | 1905 → 1930 | 11.2 → 11.4 |
| trade [slow] | 1744 → 1768 | 1744 → 1768 | 880 → 647 | 1857 → 1519 | 25167 → 10371 | 3018 → 2169 | 39 → 54 | 1991 → 1939 | 11.6 → 11.5 |
| explore [fast] | 268 → 236 | 268 → 236 | 0 → 0 | 32 → 19 | 272 → 236 | 82 → 69 | 23 → 44 | 1427 → 1453 | 8.7 → 8.9 |
| explore [slow] | 1264 → 1184 | 1264 → 1184 | **4566 → 436** | 5045 → 848 | - → 2452 | 6818 → 1248 | 32 → 44 | 1520 → 1454 | 9.2 → 9.2 |
| cohorts [fast] | 328 → 256 | 396 → 396 | 0 → 0 | 14 → 0 | 328 → 256 | 64 → 0 | 25 → 46 | 1399 → 1418 | 8.0 → 8.4 |
| cohorts [slow] | 1208 → 1204 | 1836 → 1896 | 470 → 420 | 793 → 589 | 2458 → 2386 | 1243 → 889 | 25 → 46 | 1399 → 1418 | 7.9 → 8.0 |
| market map [fast] | 192 → 204 | 448 → 272 | 33 → 0 | 34 → 2 | 318 → 232 | 84 → 52 | 166 → 187 | 2510 → 2445 | 8.7 → 9.2 |
| market map [slow] | 1160 → 1096 | 2484 → 1984 | 1298 → 677 | 1471 → 828 | 6270 → 4241 | 1971 → 1298 | 166 → 187 | 2510 → 2444 | 8.9 → 9.1 |
| leaderboard [fast] | 324 → 220 | 504 → 528 | 15 → 9 | 18 → 9 | 350 → 407 | 68 → 59 | 62 → 83 | 1586 → 1585 | 9.0 → 9.2 |
| leaderboard [slow] | 1060 → 960 | 2200 → 1952 | 951 → 600 | 1166 → 724 | 3702 → 3155 | 1566 → 1124 | 62 → 83 | 1586 → 1585 | 9.4 → 9.5 |
| copy [fast] | 284 → 272 | 284 → 272 | 0 → 0 | 68 → 59 | 284 → 272 | 118 → 109 | 20 → 41 | 1225 → 1250 | 7.6 → 7.6 |
| copy [slow] | 1440 → 1400 | 1440 → 1400 | 374 → 331 | 1055 → 943 | 2230 → 2209 | 1300 → 1193 | 20 → 41 | 1225 → 1250 | 7.5 → 7.6 |
| portfolio [fast] | 264 → 308 | 264 → 308 | 0 → 0 | 65 → 62 | 264 → 308 | 115 → 112 | 31 → 52 | 1452 → 1477 | 8.3 → 8.3 |
| portfolio [slow] | 1512 → 1348 | 1512 → 1348 | 374 → 263 | 1037 → 883 | 2201 → 2089 | 1287 → 1133 | 31 → 52 | 1452 → 1477 | 8.3 → 8.5 |
| scan [fast] | 192 → 188 | 192 → 188 | 0 → 0 | 0 → 0 | 192 → 188 | 0 → 0 | 28 → 49 | 1400 → 1418 | 7.5 → 7.6 |
| scan [slow] | 1020 → 964 | 1020 → 964 | 367 → 366 | 672 → 651 | 2075 → 2029 | 902 → 851 | 28 → 49 | 1400 → 1418 | 7.2 → 7.6 |
| scan, Hyperliquid [fast] | 304 → 272 | 336 → 308 | 0 → 0 | 56 → 54 | 304 → 272 | 106 → 104 | 40 → 61 | 1447 → 1466 | 8.8 → 9.0 |
| scan, Hyperliquid [slow] | 1428 → 1332 | 1460 → 1396 | 505 → 462 | 1119 → 1007 | 2532 → 2307 | 1469 → 1257 | 40 → 61 | 1447 → 1466 | 8.7 → 8.9 |
| palette over trade [fast] | 344 → 328 | 344 → 368 | 0 → 0 | 104 → 124 | 344 → 328 | 154 → 174 | 108 → 125 | 2508 → 2482 | 13.2 → 13.3 |
| palette over trade [slow] | 1808 → 1712 | 1808 → 1712 | 1050 → 732 | 1834 → 1586 | 15867 → 6719 | 3234 → 2394 | 59 → 132 | 2036 → 2502 | 11.9 → 13.4 |

Reading it:

- **Main thread (slow profile): TBT down on every page** - Explore −90 %
  (it never reached TTI before), market map −48 %, leaderboard −37 %,
  palette −30 %, portfolio −30 %, trade −26 %; TTI on trade 25 s → 10 s. Most
  of this is the `Intl` fix (below).
- **First paint (slow profile)**: 3-11 % earlier on most pages (portfolio
  −164 ms, leaderboard −100 ms FCP / −248 ms LCP, market map LCP −500 ms).
  Trade is unchanged: its first paint needs the trade page's own code (chart,
  order ticket, grid, account tables) plus the palette, 86 % of the old bundle.
  The three cells whose median moved the other way are inside the run-to-run
  spread: trade slow FCP 1728-1748 → 1624-1876, cohorts slow LCP
  1588-1856 → 1464-1896, portfolio fast FCP 256-304 → 260-312 (localhost).
- **Requests +21** per page: the page chunks. Bytes are unchanged (±2 %) -
  the prefetch downloads the same code the single bundle contained, just after
  the first paint. On "palette [slow]" the new build simply finished more of
  the page (logos) inside the window.
- On localhost ("fast") both builds are CPU-bound and within noise of each
  other; the split pays off with bandwidth and slower CPUs.

Prefetch: landing on /trade at 10 Mbit/s, every page's chunk was in 0.2 s
after the first paint (landing on /leaderboard: 0.5 s). At 1.5 Mbit/s it takes
~4.4 s; a click in that window on a page not yet in (and not hovered first)
waits for that page's chunk - the only timing that can differ, and only on a
slow link in the first seconds (the baseline's first paint came ~0.6 s later
there in exchange).

### Main thread

CPU profiles (4x CPU slowdown, 10 s of steady state after the page settled,
self time attributed to source through the build's sourcemaps):

| | before | after |
|---|---|---|
| Explore: number/date formatting (`explore/model.ts`) | 531 ms | ~30 ms |
| Trade: `format.ts` `fmt` (book, tape, ticket) | 633 ms | 43 ms |
| Palette open over trade (8 s): all formatting | 658 ms | 85 ms |
| Leaderboard (8 s): all formatting | 352 ms | 23 ms |

## What changed

### 1. Route-level code splitting, with no loading state (`App.tsx`, `lazyPage.ts`)

Each page (trade, explore, copy, leaderboard, portfolio, scan) is its own
chunk. What keeps it invisible:

- **No fallback, ever.** `React.lazy` suspends on the first render of every
  page even when its chunk is already in memory (it cannot read a native
  promise synchronously), which would flash a Suspense fallback on every first
  visit. `lazyPage.ts` keeps the loaded component in a variable instead: once
  `preload()` has resolved, the page renders synchronously, exactly like a
  static import.
- **The first paint is complete.** The landing page's chunk is requested the
  moment the entry runs, and `<App>` renders nothing until it is in, so the
  whole shell and page mount in ONE commit in the same order as before. (This
  matters beyond looks: App's `dash:lock:query` effect relies on the
  Dashboard's effects having run first, and toasts fired by the wallet bridge
  need the provider mounted - both behave exactly as before.) A removed-page
  URL (`/account`, `/money`, ...) also waits for the page it is moved to
  (`router.ts` `landingTab`).
- **Navigation never shows a fallback.** Every other page is fetched after the
  first paint (idle time, at most 1 s later) and on hover/focus/touch of any
  link to it. `setTab` changes page only once the target's code is in (the
  latest request wins), so the URL and the page change together, as before.
  After the prefetch (measured: every chunk in 0.2-0.5 s after the first paint
  at 10 Mbit/s), navigation is the same synchronous render it always was.
- **Failures recover.** A chunk that fails to load is retried once; if a render
  waits on it and it still fails, the page reloads (at most once a minute),
  which also fetches a new build after a redeploy.
- **CSS is not split at all** (`cssOrder.ts`). Vite would give each lazy chunk
  its own stylesheet appended to `<head>` when the page loads - after
  `styles.css`, in visit order - changing which of two equal-specificity rules
  wins. `cssOrder.ts`, App's first import, pins every stylesheet in the exact
  order of the single-bundle build; the built CSS file is byte-identical to the
  baseline's (same content hash). `cssOrder.test.ts` fails if a new stylesheet
  is added without being listed.
- **Import fixes that made the split possible.** The palette imported
  `resolveTarget` from `ScanDashboard.tsx`, which pulled the whole Scan and
  Portfolio pages into the first load; the alias helpers now live in
  `dashboard/scanAliases.ts` (re-exported from `ScanDashboard`, and the
  ScanPanels/HlPanels import cycle is gone). Explore and Copy imported
  `Dashboard` through the `dashboard/index.ts` barrel, which re-exports the
  trade dashboard (chart, order ticket); they import `dashboard/Dashboard`
  directly now.
- Audited: none of the 138 modules that moved out of the first load has a
  module-level side effect (listeners, timers, storage writes, sockets), so
  loading them later changes nothing but when their code is parsed.

### 2. The Cmd+K palette in its own chunk (`components/palette/lazyPalette.tsx`)

The palette module (with, through the venue chooser, the Portfolio page's
shared parts) is its own chunk, loaded **in parallel** with the landing page
and before the first render: a key pressed the moment the page appears must
open it as fast as before. A build-time plugin (`vite.config.ts`
`preloadPalette`) lists its chunks as `modulepreload` links in the built
`index.html`, so they download alongside the entry rather than after it. The
stand-in component only matters if that load fails: it then retries, answers
Cmd/Ctrl+K in the capture phase as the palette does, and treats keys typed
while the open is pending as typing into the search box (appended to the
seed, and kept away from App's single-key shortcuts).

Checked on a 1.5 Mbit/s, 150 ms link with keys sent the instant the shell
appeared: Ctrl+K opened the palette in 68 ms (baseline 73 ms); typing `btc`
opened it with `btc` in the box in 63 ms (baseline 63 ms). An earlier variant
that loaded the palette after the first paint opened 2.5 s late and lost the
`c` (App treats it as a shortcut) - which is why it now loads before it.

### 3. React in its own long-cached chunk (`vite.config.ts`)

`react`, `react-dom` and `scheduler` are one chunk (140 kB), modulepreloaded
with the entry. They change far less often than the app, so after a deploy
returning visitors re-download only the app. The unused `lightweight-charts`
manual chunk entry was dropped (the library is no longer imported).

### 4. Cached `Intl` formatters (`intlCache.ts`)

`n.toLocaleString(locale, options)` constructs a new `Intl.NumberFormat` on
every call (that is its specified behaviour, and V8 does it): ~37 µs per call,
against ~1.7 µs through a kept formatter. It was the largest main-thread cost
on Explore, the trade page's book and tape, the palette and the leaderboard.
`formatNumber` / `formatTime` return exactly the string `toLocaleString` /
`toLocaleTimeString` return (tested across every option set the app uses, in
three locales, including invalid-option errors and invalid dates); the hot
call sites use them: `format.ts` (`fmt`, `fmtUsd`, `fmtQuote`),
`explore/model.ts`, `winRateView.ts`, `LeaderboardPage.tsx`, `lbState.ts`,
`accountTables/cells.tsx`, `palette/model.ts`, `Stats.tsx`.

### 5. Logos: sanitised, and smaller without changing a pixel (`tools/logo-clean.mjs`)

- **Sanitised (audit W-09).** Every SVG the logo tools write goes through
  `cleanSvg`: `<script>`, `<foreignObject>`, `<handler>`, event attributes,
  animations that retarget an href, external/`javascript:` references and CSS
  `@import`/external `url()` are removed and reported. The 434 existing SVGs
  were clean; the tools (`fetch-logos.mjs`, `fetch-venue-logos.mjs`) now
  enforce it on every future download.
- **Minified losslessly.** Only inert bytes go: the XML declaration, comments,
  DOCTYPEs without entities, `<metadata>`, editor namespaces, whitespace
  between tags (never in text content), CR before LF, and redundant path-data
  separators/zeros (`0.50` → `.5`, `1, -2` → `1-2`, repeated command letters).
  Every coordinate keeps its exact value; arcs are left untouched.
- **PNGs recompressed losslessly** (standalone, and the 6 embedded in SVGs):
  re-deflated with the best row filter, alpha dropped only when fully opaque,
  every colour-management chunk (sRGB, gAMA, cHRM, iCCP, cICP, eXIf...) copied
  over, and the result is decoded again and compared pixel for pixel before it
  is used.
- Result: 8,359 kB → 7,779 kB on disk; 437 kB less on the wire (SVGs are served
  compressed). The biggest single win is `ANSEM.svg` (602 → 411 kB, its 1,321 px
  embedded PNG).
- Verification: all 434 changed SVGs rendered as `<img>` at 15 sizes (10-64 CSS
  px) × DPR 1/2/3 in Chrome: **0 differing pixels**. All 101 changed rasters
  decode in Chrome (with colour management, via canvas) to **identical pixels**.
- `logo-clean.mjs` is idempotent; `--check` reports what it would change.

### 6. Dead scripts removed (`public/scan`, audit W-08)

`shell.js`, `cmdk.js`, `ctxmenu.js`, `prefs.js`, `shell.css`, `style.css`:
nothing referenced them (checked across the app, the server and the docs).
`scan/index.html`, the redirect for old links, stays.

### 7. Dev proxy token only for the app's own requests (audit W-04, `vite.config.ts`, `devOrigin.ts`)

The dev/preview proxy now adds the local API token only when the request
carries the server's own origin (http, loopback, the port it actually listens
on) or no Origin at all with `Sec-Fetch-Site` absent / `same-origin` / `none`
(the app's same-origin GETs, curl, the e2e tools). Another localhost page gets
neither the token nor CORS (`server.cors: false`). Verified against a mock
backend: own origin (127.0.0.1 and localhost) and native clients get the
token; `http://127.0.0.1:3000`, `null` and cross-site no-cors requests do not;
the live app on :5180 is unaffected.

## Verification

### Pixels

A record/replay harness makes screenshots deterministic: the baseline was
recorded once against live data (every HTTP response and every hub push), the
clock frozen and `Math.random` seeded; replays answer every request from the
recording and feed each WebSocket subscription its recorded snapshot, then
finish all CSS animations before the capture (software raster, 1920×1080 and
390×844 @2x). 21 states: trade (desktop, mobile), Explore (overview, cohorts,
market map, mobile), leaderboard, copy, portfolio, scan (landing + all 5
venues), the palette (Ctrl+K, and opened by typing), client-side navigations
(trade→explore, explore→leaderboard, leaderboard→portfolio), and a removed-page
URL (`/account`).

Three baseline replays define the envelope a pixel may take (the baseline is
not perfectly deterministic itself: gradient dithering, raster logo
downscaling, a blinking caret). Two replays of the optimised build:

- **Pixel-identical: 16 of 21 states in the first run, 18 of 21 in the
  second** (15 in both). No state deviated in both runs except two whose
  baseline varies on its own (market map, scan-sodex).
- Every deviation was investigated:
  - gradient dither, max channel difference 1 (trade, palette, scan-sodex
    equity fill) - the same regions vary between baseline runs;
  - coin-logo edges on the market map (44 and 109 px) - the baseline's own
    run-to-run noise there is 405 px, in the same logos (Chrome's raster
    downscale of small images is not deterministic, measured: two renders of
    byte-identical PNGs differ);
  - the search box caret, captured in its visible blink phase once;
  - Copy's tab marker, half a pixel apart in one run: a pre-existing race in
    `dashboard/Panel.tsx` `PanelTabs` (the marker is measured before the web
    font arrives and only re-measured when the bar resizes). Loading the
    baseline 5 times shows both positions too (4× at 50 px, 1× at 50.5 px).
- CSS: byte-identical. Logos: see above.

### Behaviour

- Early input: see the palette check above.
- Leaks: a soak test clicking through all six pages five times shows the same
  steady state in both builds (event listeners 617 vs 620 - the three document
  listeners of the hover prefetch; DOM nodes stable; heap growth flattens after
  the first round in both).
- Render census (React DevTools hook, 10 s on trade, live data): ~10 commits/s;
  App itself re-renders only when the last price changes (~0.4/s). Per-tick
  work is confined to the order book (61 renders, 1,342 row renders) and the
  order ticket (32); nothing else re-renders per tick. No memoization was
  added: the book rows receive new level objects on every tick, so a memo
  would need a field-by-field comparator for little gain.
- Tests: web suite 551 passing on the baseline tree plus these changes (532 +
  19 new: `lazyPage`, `cssOrder`, `intlCache`, `devOrigin`); `tools/logo-clean.test.mjs`
  6/6; server `test/perf.test.ts` 9/9.

## Not done because it would be visible

- **Rounding SVG coordinates** (what SVGO does by default): measured at 2 and 3
  decimals, it changed anti-aliased edge pixels in 36 and 25 of the 76 large
  logos. Only lossless minification was applied.
- **Re-encoding embedded rasters at display size × DPR**, and **rasterising the
  huge traced vector logos** (NEIRO.svg 1 MB, GOAT.svg 600 kB, AERO, PNUT):
  Chrome's own downscale from the full-size source is not what a pre-scaled
  image gives; pixels change. Only lossless recompression was applied. (These
  four vector files alone are 2.5 MB; if pixel-identity is ever relaxed for
  logos, they are the place to start.)
- **Font preloading**: fonts are requested at the first render in both builds
  and swap the same way; preloading would put four font files next to the
  entry on the critical path and move the first paint.
- **Dead CSS removal**: the CSS stays byte-identical.
- **Lazy-loading the Deposit/Withdraw/Transfer sheets** (~140 kB still in the
  entry): they are always mounted and run effects while closed ("watch for the
  first deposit to open the account"); deferring their mount changes when those
  start.
- **Deferring the trading/crypto code** (@noble, @sodex-core, `trading/*`, ~130
  kB in the entry): `restoreTrading` runs at App mount and decides whether
  trading shows as enabled; deferring it would change when that appears.
- **The order book's per-tick re-measure** (`Market.tsx` `recomputeRows`, a
  forced layout on every book update): removing it only moves the same layout
  into the frame, and risks a stale row count.
- **The order ticket's glare animation** (`oe-glare`, a registered custom
  property driving a conic gradient, repainted every frame): a design effect;
  it cannot be made compositor-only without changing its pixels.

## Server: `apps/server/src/perf.ts` (Phase 1b)

Not registered by this change (index.ts belongs to the security agent). The
registration, right after the CORS registration and before the routes:

```ts
import { perfPlugin } from './perf.js';
await app.register(perfPlugin);
```

- **Compression**: every JSON response of 1 KiB or more is brotli (quality 5)
  or gzip encoded, negotiated from `Accept-Encoding` with q-values; compression
  runs on zlib's thread pool, never on the event loop; `Vary: Accept-Encoding`.
  Index bodies (identical for everyone until the index moves) are compressed
  once per content and encoding (bounded memory cache).
- **Caching, index routes only.** Everything else keeps index.ts's `no-store`
  (account data never lands in a disk or shared cache; errors are never
  cached).
  - boards, cohorts (all five), screener, Explore - rebuilt about once a minute
    (docs/INDEXER.md): `public, max-age=10, stale-while-revalidate=20`. The web
    polls these every 30-60 s, so its polls never reuse a stale copy; only a
    revisit within seconds does, and never across more than one rebuild.
  - price chart (Hyperliquid candles the server caches 60 s):
    `public, max-age=30, stale-while-revalidate=30`.
  - whale tape and positioning (they move with the trade streams):
    `public, no-cache` - revalidated on every use.
  - Each gets a weak ETag over the JSON; a matching `If-None-Match` is a 304
    with no body.
- Tests: `apps/server/test/perf.test.ts` (negotiation, q=0, `*`, thresholds,
  HEAD, non-JSON, no-store kept for account data and errors, ETag/304, the
  compressed-body cache and its bounds).

### Index payloads

Measured on the live backend (uncompressed → gzip):

| endpoint | raw | gzip |
|---|---|---|
| `/api/vs/explore` | 68 kB | 18 kB |
| `/api/vs/cohorts` | 52 kB | 17 kB |
| `/api/vs/leaderboard` (100 rows) | 36 kB | 8 kB |
| `/api/vs/positioning` | 35 kB | 6.5 kB |
| `/api/vs/screener` (50 rows) | 33 kB | 7 kB |
| `/api/vs/cohorts/detail` | 32 kB | 10 kB |
| `/api/vs/cohorts/map` | 29 kB | 9 kB |
| `/api/vs/cohorts/wallets` (50) | 21 kB | 5 kB |
| `/api/vs/cohorts/focus` | 20 kB | 5 kB |
| `/api/vs/price` | 10 kB | 2.6 kB |
| `/api/vs/whales` (50) | 10 kB | 2.4 kB |

Trimming candidates (fields the web never reads; nothing was changed):

1. **`/api/vs/explore` `segments[].rows[].spark`** - 21 kB of the 68 kB (31 %).
   Explore renders no row sparklines (only the cohort cards and the leaderboard
   read `spark`, from their own endpoints).
2. **Explore rows' other unread fields** - `maxDrawdown`, `lastActive`,
   `accountId`, `winRate`, `trades`, `sharpe`, `tags`, `label` (~11 kB); and
   `pnl`/`roi`/`volume` carry every window while Explore reads `pnl` 30d/7d/all,
   `roi` 30d and `volume` 7d (~11 kB more).
3. **`label: null` in every trader row of every endpoint** - usernames were
   removed for good; ~1.3 kB per 100 rows.
4. **`/api/vs/screener` `rows[].enrichedAt`** and the cohorts endpoints'
   `coverage.*.tailRate` - never read.
5. **Float precision**: PnL/value/volume go out with 9-12 significant digits
   (`81224.992721647`) and are displayed compact or to the cent; two decimals
   would cut roughly 15-20 % of the numeric bytes. Needs a check that no client
   computes with the full precision first.
6. `/api/vs/positioning` repeats `venue` in each of its ~300 rows (6 kB); the
   palette joins on it, so any regrouping needs a client change too.

With compression on, all of these shrink 3-5x on the wire; they matter mostly
for hosted mode.

## Deployment notes

- `/assets/*` is content-hashed: `public, max-age=31536000, immutable`
  (already in docs/deploy/SECURITY-HEADERS.md). The split adds ~20 chunk files;
  over HTTP/2 or HTTP/3 (CloudFront, Caddy) the extra requests cost nothing.
- `/logos/*` and `/addrbook/*` are not hashed and have no Cache-Control in the
  deployment doc; `public, max-age=86400, stale-while-revalidate=604800` would
  spare repeat visitors the logos they already have (the leaderboard loads 43
  of them, 0.35 MB compressed; the market map 150, 1.15 MB), without delaying a
  logo update by more than a day.
- Serve everything compressed (`encode zstd gzip` in the Caddy config; on
  CloudFront, compression on the cache policy). SVG logos compress 2.5-3x.

## Tools

The measurement harness lives outside the repo (it is dev tooling with no
place in the app); ask for it to be added under `apps/web/tools/perf/` if it
should be kept. It is dependency-free (Node 24 built-in WebSocket + CDP):
bundle composition from sourcemaps, per-page runtime metrics (FCP, LCP,
TBT/TTI, long tasks, requests/bytes, heap), CPU profiles attributed to source,
the React render census, the record/replay screenshot comparison, the logo
pixel comparison, a leak soak test and the payload field analysis.

Observations for other owners:

- `dashboard/Panel.tsx` `PanelTabs`: the tab marker is placed before the web
  font loads and not re-placed when it does (a `document.fonts` listener would
  settle it at the font's metrics; it moves by half a pixel).
- The live dev app now serves market data from `/api/v1/...` (browser-direct
  work in progress); `src/exchange/ws/link.test.ts` ("leader election") fails
  in the working tree - it belongs to that work.
