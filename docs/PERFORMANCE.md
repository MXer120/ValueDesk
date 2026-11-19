# Performance

Two passes before public hosting: pass 1 (2026-09-30: page chunks, `Intl`
cache, logos, the server's compression and caching plugin) and pass 2
(2026-10-02: requests to our own server, index payloads, a server stall, and a
second look at what every page loads first).

**The rule every change here follows: nothing a user can see may change.**
Pixel-identical rendering, identical behaviour, no new loading states,
flashes, font swaps, layout shifts or noticeable timing changes. Faster is
fine. Every change below was measured against that rule; the ones that could
not pass it are listed under "Not done" with the reason.

The tools that produced every number here are in `apps/web/tools/perf/`; its
README says how to rerun each comparison.

## Pass 2 (2026-10-02)

### What was compared

"Before" is `6ba2705` (pass 1, the server plugin, browser-direct exchange
traffic, the SharedWorker socket host and the stored history tables all in);
"after" is that same tree plus only the pass-2 changes (`4d5fa69` server,
`67fcd8e` web). Both are production builds from clean exports, served side by
side by `vite preview` and proxied to the same backend, so only the code
differs. Request counts and payloads compare the dev backend before and after
the server changes went in.

### Bundle

What a page waits for before its first render (deterministic; from the built
files and their sourcemaps, `bundle-report.mjs`):

| | before | after | |
|---|---|---|---|
| JS before any page chunk (entry + its static imports) | 13 chunks, 920 kB raw / 307 kB gzip / 263 kB br | 10 chunks, 746 / 253 / 215 | **−19 % / −17 % / −18 %** |
| first render, landing on **leaderboard** | 939 / 314 / 269 | 776 / 265 / 225 | −17 % / −16 % / −16 % |
| … on **copy** | 1,074 / 357 / 306 | 905 / 305 / 260 | −16 % / −15 % / −15 % |
| … on **explore** | 1,087 / 358 / 307 | 926 / 309 / 264 | −15 % / −14 % / −14 % |
| … on **trade** | 1,261 / 419 / 360 | 1,207 / 403 / 346 | −4 % / −4 % / −4 % |
| … on **portfolio** | 1,023 / 339 / 290 | 1,026 / 340 / 292 | +0.3 % |
| … on **scan** | 1,065 / 351 / 301 | 1,068 / 352 / 302 | +0.3 % |
| all JS | 147 chunks, 5,853 kB | 148 chunks, 5,856 kB | +3 kB |
| CSS | `index-B0a27mIV.css` | the same file (same hash) | 0 |

Portfolio and Scan need the moved parts anyway; they pay 3 kB of chunk
overhead and the two new helpers. Separately from the first render, the wallet
stack (AppKit, WalletConnect, viem, ethers: 545 kB gzip, 1.8 MB raw) no longer
downloads and evaluates in the middle of the first page load (item 14).

### Runtime

Headless Chrome, 1920×1080, cold loads in fresh profiles, the two builds
interleaved run by run, median of 3 (`metrics.mjs`, 2026-10-03). **fast** = no
throttling; **slow** = 10 Mbit/s, 40 ms RTT, 4× CPU. "Data shown" = the page's
own rows on screen; TBT is FCP→TTI, "incl. load" also counts the blocking
before the first paint.

**Noise.** The machine was shared with four other agents running test suites
(1.6 of 8 cores busy when the run started, more at times), and the API behind
both builds was the dev backend under their load. Single runs of either build
stalled on a slow index answer (Explore's rows at 15 s in one baseline run and
2.5 s in one final run, cohorts at 6.5 s, the trade page's TTI at 18 s), and
Explore's rows did not appear within the window once in each build. Read
differences under ~100 ms, and every TTI on the trade page (its order book
never lets the main thread rest for 5 s), as noise.

| page [profile] | FCP ms | LCP ms | data shown ms | TBT ms | TBT incl. load ms | TTI ms | long tasks ms | JS heap MB |
|---|---|---|---|---|---|---|---|---|
| trade [fast] | 316 → 332 | 316 → 376 | 1378 → 1391 | 0 → 0 | 96 → 101 | 316 → 332 | 146 → 151 | 12.4 → 12.4 |
| trade [slow] | 1848 → 1732 | 1848 → 1732 | 3252 → 2886 | 757 → 778 | 1803 → 1626 | 4708 → 17766 | 2883 → 2626 | 12.7 → 12.5 |
| explore [fast] | 272 → 280 | 272 → 304 | (328 → 1402) | 0 → 0 | 13 → 26 | 272 → 280 | 63 → 76 | 8.8 → 8.8 |
| explore [slow] | 1516 → 1244 | 1516 → 1244 | 2024 → 1592 | 686 → 473 | 1431 → 986 | 3431 → 4149 | 1831 → 1336 | 8.8 → 8.8 |
| cohorts [fast] | 304 → 240 | 384 → 376 | 441 → 297 | 0 → 0 | 0 → 0 | 304 → 240 | 0 → 0 | 8.1 → 8.1 |
| cohorts [slow] | 1332 → 1220 | 1812 → 1400 | 1817 → 1629 | 487 → 470 | 682 → 661 | 2393 → 4205 | 1032 → 961 | 8.1 → 8.1 |
| market map [fast] | 272 → 268 | 576 → 332 | 399 → 352 | 27 → 0 | 42 → 0 | 477 → 268 | 142 → 0 | 8.8 → 8.8 |
| market map [slow] | 1628 → 1100 | 3228 → 2000 | 2634 → 1625 | 1706 → 690 | 2029 → 818 | 7363 → 4690 | 2679 → 1218 | 8.8 → 8.8 |
| leaderboard [fast] | 216 → 208 | 416 → 392 | 290 → 260 | 2 → 4 | 5 → 4 | 291 → 262 | 55 → 54 | 9.3 → 9.2 |
| leaderboard [slow] | 996 → 932 | 1996 → 2088 | 1492 → 1620 | 770 → 780 | 896 → 914 | 3332 → 3872 | 1526 → 1508 | 9.4 → 9.4 |
| copy [fast] | 256 → 276 | 256 → 276 | 335 → 263 | 0 → 0 | 63 → 59 | 256 → 276 | 113 → 109 | 7.8 → 7.8 |
| copy [slow] | 1456 → 1452 | 1456 → 1452 | 1940 → 1678 | 325 → 379 | 981 → 1074 | 2132 → 3879 | 1181 → 1324 | 7.8 → 7.8 |
| portfolio [fast] | 284 → 272 | 284 → 272 | - | 0 → 0 | 69 → 53 | 284 → 272 | 119 → 103 | 8.5 → 8.6 |
| portfolio [slow] | 1476 → 1476 | 1476 → 1476 | - | 333 → 366 | 1031 → 1060 | 2257 → 3870 | 1231 → 1310 | 8.6 → 8.6 |
| scan [fast] | 204 → 200 | 204 → 200 | - | 0 → 0 | 6 → 0 | 204 → 200 | 56 → 0 | 7.4 → 7.4 |
| scan [slow] | 1012 → 1056 | 1012 → 1056 | - | 383 → 424 | 659 → 756 | 2028 → 4177 | 909 → 1006 | 7.4 → 7.4 |
| scan, Hyperliquid wallet [fast] | 316 → 276 | 316 → 276 | 1005 → 959 | 0 → 0 | 73 → 51 | 316 → 276 | 123 → 101 | 9.2 → 9.1 |
| scan, Hyperliquid wallet [slow] | 1432 → 1448 | 1568 → 1580 | 2484 → 1985 | 496 → 445 | 1114 → 1127 | 2503 → 3985 | 1416 → 1577 | 9.2 → 9.2 |
| palette over trade [fast] | 332 → 292 | 332 → 292 | 1338 → 626 | 0 → 0 | 104 → 88 | 332 → 292 | 154 → 138 | 14.2 → 14.2 |
| palette over trade [slow] | 1716 → 1676 | 1716 → 1676 | 2949 → 2765 | 550 → 501 | 1379 → 1355 | 11584 → 4278 | 2192 → 2097 | 14.3 → 14.3 |

(Explore [fast] "data shown" is the median of the two runs that showed rows:
318-339 ms in the baseline, 334 ms and a stalled 2.5 s in the final build.)

Reading it:

- **The page's data is on screen sooner on the slow profile**: market map
  −1.0 s, Scan of a Hyperliquid wallet −0.5 s, Explore −0.4 s, trade −0.4 s,
  copy −0.3 s, cohorts −0.2 s, palette −0.2 s. The leaderboard's +0.1 s is
  inside its runs' spread (1.47-1.57 s → 1.42-1.64 s). Unthrottled the pages
  were already as fast as the backend answers; cohorts and copy gained 70-140 ms.
- **First paint (slow)**: market map −0.5 s FCP / −1.2 s LCP, Explore −0.27 s,
  cohorts −0.11 s FCP / −0.41 s LCP, trade −0.12 s; the rest within ±70 ms.
- **Main thread during the load (slow, TBT incl. load)**: market map −1.2 s,
  Explore −0.45 s, trade −0.18 s; the rest within ±100 ms.
- **TTI is later on the slow profile** (copy 2.1 → 3.9 s, portfolio 2.3 → 3.9 s,
  Scan 2.0 → 4.2 s, cohorts 2.4 → 4.2 s, Explore 3.4 → 4.1 s, leaderboard
  3.3 → 3.9 s). This is the wallet code (item 14): it is now evaluated after the
  page has shown its data, 2-3 s after the header mounted, instead of in the
  middle of the load - and TTI waits for the last long task. The work did not
  grow, it moved: the longest task is the same size in both builds (618-694 ms
  at 4× CPU on copy, portfolio and Scan; total script time per page within
  ±10 %, lower on Explore, market map and trade). Unthrottled, TTI equals the
  first paint in both builds. A visitor on a slow machine who clicks in that
  second waits for it, as one who clicked during the load waited before.
- Requests in the first 10 s (fast) / 20 s (slow): our API one fewer on
  portfolio, Scan and a Scan wallet page (the shared health read); one site
  file more (the parts chunk, 1-2 kB); exchange traffic unchanged. Heap
  unchanged.

### Requests to our server

Requests per minute that left the browser for our API (what its HTTP cache
answered is not counted), per page: the first minute, a steady minute, 45 s
with the tab hidden, and the first 5 s after it is shown again
(`rates.mjs`, `rates-compare.mjs`). Before: 2026-10-02 19:52, the baseline
build against the server as it was. After: 23:36, the final build against the
final server.

| page | first minute | steady minute | hidden 45 s | on return 5 s |
|---|---|---|---|---|
| trade | 4 → 4 | 3 → 3 | 0 → 0 | 2 → 2 |
| explore | 19 → 19 | 18 → 18 | 0 → 0 | 5 → 5 |
| cohorts | 5 → 5 | 4 → 4 | 0 → 0 | 2 → **3** |
| market map | 6 → 6 | 5 → 5 | 0 → 0 | 2 → **4** |
| leaderboard | 9 → 9 | 7 → 7 | 0 → 0 | 3 → 3 |
| copy | 5 → 5 | 3 → 3 | 0 → 0 | 2 → 2 |
| portfolio | 5 → **4** | 3 → 3 | 0 → 0 | 2 → 2 |
| scan | 5 → **4** | 3 → 3 | 0 → 0 | 2 → 2 |
| scan, Hyperliquid wallet | 6 → **5** | 4 → 4 | 0 → 0 | 3 → 3 |
| palette over trade | 12 → **11** | 9 → 9 | 1 → **0** | 6 → **8** |

The counts were already lean - every poll is something a page shows (health
30 s for the kill switch and the footer, maintenance 45 s, whale tape 5 s,
positioning 30 s, Explore and cohorts 60 s, leaderboard 15 s) and nothing
polled while hidden except the palette's heat map. What changed:

- **Portfolio and Scan send one `/api/health` fewer**: they no longer read it
  on their own next to the app's own read; identical reads in flight share one
  request (item 8).
- **Nothing is polled in a hidden tab** (the palette's heat map was).
- **A tab shown again catches up at once** on the cohort pages and the palette,
  as Trade and Explore already did: the polls it missed run when it is shown
  (the extra requests "on return"), instead of the screen waiting up to a
  minute with data from before the tab was hidden.
- **Polls get the server's current answer.** Before, the boards' cache policy
  (`max-age=10, stale-while-revalidate=20`) let the browser answer each 15 s
  leaderboard poll with the copy the previous poll had left (4 of the 4 polls a
  minute, `revisit.mjs`), revalidating behind it: the board ran one poll late
  for as long as it was open. Now a poll is a conditional request: a 304 with
  no body when nothing changed, the new board when it did.

### Index payloads

Bytes of the index answers (`payloads.mjs`). On identical data - the same
recorded answers, rewritten by the server's own trim functions - Explore goes
from 64.9 kB to 24.9 kB (**−62 %**), the screener's 50 rows −5 %, the
leaderboard's 100 rows −3.4 %. Live, before and after the server change
(raw / gzip / brotli; the data moved in between):

| endpoint | before | after |
|---|---|---|
| `/api/vs/explore` | 64.1 / 17.1 / 15.3 kB | 24.5 / 6.3 / 6.3 kB |
| `/api/vs/leaderboard` (page: 5 venues, 100 rows) | 35.5 / 7.8 / 7.5 | 34.2 / 7.7 / 7.5 |
| `/api/vs/screener` (50 rows) | 33.1 / 7.6 / 7.5 | 31.0 / 7.0 / 6.9 |
| `/api/vs/screener` (palette, 12 rows) | 6.7 / 1.7 / 1.6 | 6.3 / 1.5 / 1.5 |
| `/api/vs/cohorts/wallets` (50) | 18.7 / 3.9 / 3.8 | 18.1 / 3.8 / 3.8 |
| `/api/vs/lbrow` | `no-store` | cached like the boards, 304 when unchanged |

The other endpoints are unchanged apart from their data.

### The server's once-a-minute stall

The cohort pages' data was rebuilt INSIDE a request once a minute: the first
request after the minute read the cohort book of ~270k wallets from SQLite and
netted 257k of them on the event loop. That request took 3.0-8.1 s (12 s under
load), and for that time no other request was answered - the health check,
the boards, the trade page's index reads all waited.

| 2.5 min of 100 samples × 3 routes (`cohorts`, `cohorts/map`, `health`) | before | after |
|---|---|---|
| slowest answer | 8.1 s (and 3.0 s a minute later) | 26 ms |
| the rebuild | 2.6-3.3 s read + 1.4 s netting, blocking | ~2.5 s in 8 ms slices, longest hold 54-80 ms |

### What changed

8. **`serverFetch.ts`: every index read in one place** (`vsApi.ts` and the
   palette's reads go through it).
   - Identical reads in flight share one request; each caller keeps its own
     abort (the request is cancelled only when every caller has gone) and
     parses its own copy of the body.
   - HTTP cache: a page's first read is left to the browser's cache, as any
     fetch was - a page reopened within 30 s has its rows at once. A poll
     (hooks.ts `useAsync` ticks and the cohort pages' `usePolled` ticks, marked
     with `revalidating()`) asks the server: `cache: 'no-cache'`, so the
     browser revalidates its copy, and an unchanged answer is a 304.
   - First reads started early, on return visits: what a landing page read
     first is remembered per URL (localStorage, paths only) and sent as the app
     boots, before the page's code has run; the page's own read takes that
     answer. One reader, within 10 s; a failed answer is not handed over; URLs
     with a wallet or a search are neither remembered nor started early;
     nothing is started in a tab opened in the background. Measured gap it
     closes: on the slow profile a page's first index read left 380-630 ms
     after its code had arrived (550-820 ms after the entry); 30-180 ms
     unthrottled. A first visit is unchanged (nothing to go by yet).
9. **Polling.** The cohort pages' `usePolled` polls through `pollEvery`
   (`exchange/visibility.ts`: paused while hidden, catches up when shown); the
   palette's heat map through `visibleTimeout` (it polled hidden tabs);
   Portfolio reads `/api/health` through `api.health()`, which shares one
   request in flight. Cadences unchanged.
10. **Server payload trims** (only fields no web source reads - checked with
    `payloads.mjs --web=src`, which greps `apps/web/src` including the palette):
    - Explore rows carry what Explore shows: venue, address, account value,
      PnL 30d/7d/all, ROI 30d, volume 7d, nulls left out
      (`valuedesk/explore.ts` `wireRow`). Gone: `spark`, the other windows,
      `maxDrawdown`, `lastActive`, `accountId`, `winRate`, `trades`, `sharpe`,
      `tags`, `label`.
    - `label: null` leaves every index answer (`perf.ts` `omitNullLabels`, on
      the way out, before the ETag and the compression; a row that does carry a
      name is sent as is). Usernames were removed for good.
    - Screener rows: `enrichedAt`. Cohorts coverage: `tailRate`.
11. **Cache policy** (`perf.ts`): `/api/vs/lbrow` (Scan's Hyperliquid rank)
    gets the boards' policy, `public, max-age=10, stale-while-revalidate=20`,
    and an ETag (it sent `no-store`). An index route's failure answered as
    HTTP 200 `{ok:false}` is `no-store` with no ETag (it was cacheable for
    10 s: a cache would have gone on serving "unavailable").
12. **The cohort load, out of the request path** (`indexer/read.ts`,
    `indexer/store.ts`, `valuedesk/cohorts/model.ts`): the wallets are read in
    pages of 2,000 in key order and netted in 8 ms slices between other work;
    the next load is built behind the current one, 15 s before it expires,
    while the cohort pages are being asked for (5 min). Requests are answered
    from the built load and never wait for a build unless there is none yet.
13. **The Portfolio page's shared parts in their own module**
    (`components/portfolio/parts.tsx`, moved byte for byte from
    `Portfolio.tsx`: `Card`, `Row`, `Stat`, `Tag`, `EquityCurve`, ...). The
    palette's venue chooser and five other modules imported them from
    `Portfolio.tsx`, which put the whole Portfolio page - with the account
    tabs, history tables, fee tier and leaderboard modules behind it - into the
    first render of every page. 21 modules left the first-render set; none has
    a module-level side effect (the history table store opens IndexedDB on
    first use, not on import).
14. **The wallet code after the first page load** (`walletconnect.ts`,
    `startLater.ts`). AppKit and the chain libraries were imported the moment
    the header mounted: 545 kB gzip on the wire next to the page's own chunks
    and data, and their evaluation next to the page's first data render. They
    now start 2 s after the header mounts, at the next idle moment (within
    1 s more) - or at once when the pointer reaches or the keyboard focuses
    the Connect button (`warmWalletModal`). A click on Connect waits on the
    same import as before. The one case not measured: a click in the first
    two seconds on a slow link, where the download now starts with the
    pointer's approach instead of at boot - but no longer shares the line
    with the page's own files.

### HTTP caching as shipped

`revisit.mjs`, leaderboard, 60 ms emulated round trip, both builds against the
final server:

| | before | after |
|---|---|---|
| first read | network | network |
| polls (every 15 s) | the HTTP cache's copy from the poll before, plus a revalidation behind it | network, conditional (304 or the new board) |
| reopened 7 s after the server last answered | HTTP cache, rows 51 ms after the click | HTTP cache, rows 56 ms after the click |
| reopened 20 s after | HTTP cache (and a revalidation behind it), 78 ms | the same, 64 ms |
| reopened 42 s after | network, 155 ms | network (304), 123 ms |

The cohort list's 60 s poll is a conditional request as well
(`Cache-Control: max-age=0`, 18.5 kB when the board had changed).

### Verification

**Pixels and layout** (`shots.mjs`; recording of 2026-10-02 23:36, 21 states:
every page, all five Scan venues, the palette opened two ways, three
client-side navigations, a removed-page URL, two phone layouts). Five replays
of the baseline define what a pixel may be; three replays of the final build:

- **Layout (every element's box to 1/100 px, classes and text): the same as
  the baseline in every state**, in all three runs - with two exceptions that
  the baseline shows between its own runs too: the Copy/legacy-account tab
  marker at 520 or 521.5 px (`PanelTabs`, see "Observations"), and the SoDEX
  Scan account chart, which under the harness's frozen clock sometimes shows
  "couldn't load" and sometimes its spinner.
- Pixels outside the five-run envelope: the market map's coin logos (5-51 px,
  every run; the baseline itself varies by 165 px there - Chrome's raster
  downscale of small images is not deterministic) and, each in one run only,
  1-12 px of anti-aliased edges (leaderboard, portfolio, copy, palette) or a
  gradient off by 1-3 grey levels (Scan). No deviation shows in all three
  runs except the logos.
- A server payload change was checked the same way: the same build replayed
  from the recording as it is and from a copy whose index answers were
  rewritten by the server's trim functions - the same layout in all 10 states
  that read the index.

**Behaviour.**

- HTTP caching: the table above.
- Typing the moment the page appears (`early-keys.mjs`, trade page, 1.5 Mbit/s,
  24 loads per build, interleaved; measured on the final build before its last
  change, which only concerns how polls are sent):

  | | whole word typed | search box focused after the first key: median / p90 / max |
  |---|---|---|
  | `btc`, keys 40 ms apart, at once | 24/24 → 24/24 | 35 / 44 / 53 ms → 34 / 39 / 43 ms |
  | `btc`, keys 80 ms apart, 300 ms after | 24/24 → 24/24 | 39 / 52 / 129 ms → 37 / 52 / 137 ms |

- Hidden tabs and the return: the request table above.
- `smoke.mjs` on the dev app after the swap: every page renders.
- Tests: web suite 664 passing on the clean final tree (637 + 27 new:
  `serverFetch` 22, `startLater` 5), server 454 (440 + 14 new: the trims, the
  cohort load, the cache policies). The coordinator's clean checkout of the
  commits: web 756/756, server 505/505.

### Not done because it would be visible

- **Loading the wallet code only when someone reaches for Connect** (545 kB
  gzip saved for every visitor who never connects): on a slow link the modal
  would then open seconds after the click.
- **Polling less often** (health, whale tape, positioning, boards): each
  cadence is how soon something appears on screen.
- **Starting the exchange reads from `index.html`**: it would bypass the
  per-visitor exchange budget (`exchange/`), which decides what may be sent.
- **The trade page's forced layouts** (`PanelTabs` placing its marker,
  `Dashboard` `useBox`, `DrawingRail` `readBox`, the order book's
  `recomputeRows`): moving them changes when layout is read; a stale
  measurement would show.
- **Rounding floats in the index answers** and the cohort sparklines'
  precision: a value computed from them could change in its last displayed
  digit.
- **Delaying the idle page prefetch** further: a click in the first second
  would then wait for its page's code.

## Pass 1 (2026-09-30)

Baseline is the pristine `983eb85` tree; "after" is that same tree plus only
the pass-1 changes. Production builds, served by `vite preview` and proxied to
the live backend. (The app has changed a lot since - browser-direct exchange
traffic, the socket host, stored history - so these numbers do not chain with
pass 2's.)

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

### What changed

#### 1. Route-level code splitting, with no loading state (`App.tsx`, `lazyPage.ts`)

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

#### 2. The Cmd+K palette in its own chunk (`components/palette/lazyPalette.tsx`)

The palette module is its own chunk, loaded **in parallel** with the landing
page and before the first render: a key pressed the moment the page appears
must open it as fast as before. A build-time plugin (`vite.config.ts`
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

#### 3. React in its own long-cached chunk (`vite.config.ts`)

`react`, `react-dom` and `scheduler` are one chunk (140 kB), modulepreloaded
with the entry. They change far less often than the app, so after a deploy
returning visitors re-download only the app. The unused `lightweight-charts`
manual chunk entry was dropped (the library is no longer imported).

#### 4. Cached `Intl` formatters (`intlCache.ts`)

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

#### 5. Logos: sanitised, and smaller without changing a pixel (`tools/logo-clean.mjs`)

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

#### 6. Dead scripts removed (`public/scan`, audit W-08)

`shell.js`, `cmdk.js`, `ctxmenu.js`, `prefs.js`, `shell.css`, `style.css`:
nothing referenced them (checked across the app, the server and the docs).
`scan/index.html`, the redirect for old links, stays.

#### 7. Dev proxy token only for the app's own requests (audit W-04, `vite.config.ts`, `devOrigin.ts`)

The dev/preview proxy now adds the local API token only when the request
carries the server's own origin (http, loopback, the port it actually listens
on) or no Origin at all with `Sec-Fetch-Site` absent / `same-origin` / `none`
(the app's same-origin GETs, curl, the e2e tools). Another localhost page gets
neither the token nor CORS (`server.cors: false`). Verified against a mock
backend: own origin (127.0.0.1 and localhost) and native clients get the
token; `http://127.0.0.1:3000`, `null` and cross-site no-cors requests do not;
the live app on :5180 is unaffected.

### Verification (pass 1)

**Pixels.** The same record/replay harness as pass 2 (then without the layout
check): 21 states, three baseline replays defining the envelope, two replays of
the optimised build. Pixel-identical in 16 of 21 states in the first run and
18 of 21 in the second; every deviation was traced to noise the baseline shows
on its own (gradient dither of one grey level, Chrome's raster downscale of
small logos on the market map, the caret's blink phase once, and the `PanelTabs`
marker half a pixel apart - see "Observations"). CSS byte-identical.

**Behaviour.** Early input: see item 2. Leaks: a soak test clicking through
all six pages five times shows the same steady state in both builds (event
listeners 617 vs 620 - the three document listeners of the hover prefetch; DOM
nodes stable; heap growth flattens after the first round in both). Render
census (10 s on trade, live data): ~10 commits/s; App re-renders only when the
last price changes (~0.4/s); per-tick work is confined to the order book and
the order ticket. Tests: web 551 (532 + 19 new), `tools/logo-clean.test.mjs`
6/6, server `test/perf.test.ts` 9/9.

### Not done because it would be visible (pass 1)

- **Rounding SVG coordinates** (what SVGO does by default): measured at 2 and 3
  decimals, it changed anti-aliased edge pixels in 36 and 25 of the 76 large
  logos. Only lossless minification was applied.
- **Re-encoding embedded rasters at display size × DPR**, and **rasterising the
  huge traced vector logos** (NEIRO.svg 1 MB, GOAT.svg 600 kB, AERO, PNUT):
  Chrome's own downscale from the full-size source is not what a pre-scaled
  image gives; pixels change. (These four vector files alone are 2.5 MB; if
  pixel-identity is ever relaxed for logos, they are the place to start.)
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

## Server: `apps/server/src/perf.ts`

Registered in `index.ts` right after CORS (`ec5b8d6`).

- **Compression**: every JSON response of 1 KiB or more is brotli (quality 5)
  or gzip encoded, negotiated from `Accept-Encoding` with q-values; compression
  runs on zlib's thread pool, never on the event loop; `Vary: Accept-Encoding`.
  Index bodies (identical for everyone until the index moves) are compressed
  once per content and encoding (bounded memory cache).
- **Caching, index routes only.** Everything else keeps index.ts's `no-store`
  (account data never lands in a disk or shared cache; errors are never
  cached).
  - boards, cohorts (all five), screener, Explore, `lbrow` - rebuilt about once
    a minute (docs/INDEXER.md): `public, max-age=10, stale-while-revalidate=20`.
    A page reopened within that half minute has its rows at once. The price: a
    client that polls inside the window is handed the copy its previous poll
    left behind (the leaderboard polls every 15 s), so the web's polls
    revalidate instead (pass 2, item 8). (Pass 1 said the web's polls never
    reuse a stale copy because they come every 30-60 s. The leaderboard's come
    every 15 s: they did, until pass 2.)
  - price chart (Hyperliquid candles the server caches 60 s):
    `public, max-age=30, stale-while-revalidate=30`. The web now reads candles
    from Hyperliquid directly; the route stays for other clients.
  - whale tape and positioning (they move with the trade streams):
    `public, no-cache` - revalidated on every use.
  - Each gets a weak ETag over the JSON as sent; a matching `If-None-Match` is
    a 304 with no body.
  - An index route's failure (`{ok:false}`, sent as HTTP 200) is `no-store`
    with no ETag.
- **Trims**: `label: null` is dropped from index answers on the way out (pass
  2, item 10).
- Tests: `apps/server/test/perf.test.ts` (negotiation, q=0, `*`, thresholds,
  HEAD, non-JSON, no-store kept for account data and errors, ETag/304, the
  compressed-body cache and its bounds, the board policy, failures, the label
  trim), `payloadTrims.test.ts`, `cohortsLoad.test.ts`.

## Deployment notes

- `/assets/*` is content-hashed: `public, max-age=31536000, immutable`
  (docs/deploy/SECURITY-HEADERS.md). Over HTTP/2 or HTTP/3 (CloudFront, Caddy)
  the page chunks cost nothing extra.
- CloudFront's API cache policy (`deploy/aws/edge.yaml`) honours the origin's
  Cache-Control, at most 60 s. With `stale-while-revalidate` the edge may hand
  a lone visitor's 15 s leaderboard poll a copy up to 30 s old while it fetches
  the next one - what the policy allows, on boards rebuilt once a minute. The
  web's polls send `Cache-Control: max-age=0`, which CloudFront ignores: for
  hosted visitors the edge decides how fresh a poll is. If boards must be
  fresher at the edge, drop `stale-while-revalidate` from `perf.ts` `BOARD` -
  at the price of a round trip to the origin for every page reopened 10-30 s
  after its last read.
  On Vercel (2026-11-18, phone pass) longer edge stale windows by rebuild cadence
  (the boards 60 s in all, the cohort load 120 s) were tried in
  `deploy/vercel/api-proxy.cjs` and taken back on review: the leaderboard, the
  market map, Explore > Markets, Home's map, the terminal heatmap and the cohort
  focus/detail charts show no as-of time, the copy cards' `age`/`fresh` are set
  when the origin answers, and an edge copy's age adds to the data's own (a cohort
  answer may come from a load already 120 s old, indexer/read.ts STALE_MAX_MS).
  The edge keeps the origin's own windows; a longer one is a `perf.ts` change
  once every screen of that route shows the answer's time.
- `/logos/*` and `/addrbook/*` are not hashed and have no Cache-Control in the
  deployment doc; `public, max-age=86400, stale-while-revalidate=604800` would
  spare repeat visitors the logos they already have (the leaderboard loads 43
  of them, 0.35 MB compressed; the market map 150, 1.15 MB), without delaying a
  logo update by more than a day.
- Serve everything compressed (`encode zstd gzip` in the Caddy config; on
  CloudFront, compression on the cache policy). SVG logos compress 2.5-3x.

## Observations for other owners

- **The palette drops a key typed before its search box has the focus**
  (`palette/CommandPalette.tsx`). The first printable key opens the palette
  with that key; the box is focused on the next frame (or after 100 ms). A key
  that arrives in between goes to App's shortcut handler, which opens the
  already open palette again (the seed is ignored) - or, for `c`, is a
  reserved shortcut. It only shows when the main thread is busy for longer
  than the gap between two keys, in every build (`early-keys.mjs`: on a
  heavily loaded machine a third to a half of the loads lost a key, both
  builds alike; on a quieter one, none in 48 loads per build).
  A fix belongs in the palette: while open, append printable keys that land
  outside the dialog to the query, as `onKeyDown` already does for keys inside
  it.
- `dashboard/Panel.tsx` `PanelTabs`: the tab marker is placed before the web
  font loads and not re-placed when it does (it lands at 520 or 521.5 px from
  load to load in every build; a `document.fonts` listener would settle it).
- `/api/health`'s `hub.upstreams` and `serverSigning`, and the screener's
  `dormant`, are not read by the web; they could be trimmed with the next
  server change that touches those routes.
