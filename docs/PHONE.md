# Phones

The phone pass of 2026-11-18 (branch `claude/phone-optimization-40f0cf`, on `feat/bots`). Most phone visitors
come from Nigeria, Brazil, Ethiopia and Morocco (Vercel Analytics): mid-range Android phones on slow mobile data.
Nothing here is shipped yet.

## Second pass: everything on the phone path (2026-11-18, evening)

Nine packages, each built on its own branch and reviewed, merged here: `perf/shell` (first pixels), `perf/diet` (code
a first render does not need), `perf/chart` (candles and book), `perf/data` (index data on the client), `perf/server`
(index API), `perf/liq` (liquidation data), `perf/nav` (navigation and motion), `perf/ux` (phone UX), `perf/edge`
(Vercel, caching and cost; see **Cost** below).

### Before and after

Measured on one laptop, one run after another: a production build served over HTTP/2 with brotli like Vercel
(`/api` to a dev server on production's data); DevTools' own presets (Slow 4G: 1.6 Mbit/s x 0.9, 562 ms round trip;
Fast 4G: 9 Mbit/s x 0.9, 165 ms), 4x CPU slowdown, 375x812 Android Chrome, cold profile, 2 runs each (ranges are the
two runs). **Before** = `6556aee3` (feat/bots before any phone work), **first pass** = `706c1a26`, **after** = this branch.
Harness: `tools/perf/phone-data.mjs`, `phone-load.mjs`, `tap-lit.mjs`, `filmstrip.mjs`.

| Slow 4G | before | first pass | after |
|---|---|---|---|
| First pixels /trade | 7.7-8.4 s | 7.1-9.1 s | **1.3-1.4 s** |
| First pixels /points, /explore, /leaderboard | 5.2-6.1 s | 4.7-5.5 s | **1.3 s** |
| Chart's candles on screen, cold /trade | 13.1-15.2 s | 9.5-11.4 s | **9.3-10.6 s** |
| Cohorts' data, cold | 9.5-9.7 s | 6.6 s | **5.4 s** |
| Leaderboard's data, cold | 8.3 s | 6.0 s | **4.4-4.6 s** |
| SoPoints' data, cold | 6.7 s | 6.2 s | **5.1-5.2 s** |
| Portuguese visitor: /trade in Portuguese | 9.8 s | 8.3 s (HTTP/1.1, first report) | **6.7 s** |
| Portuguese visitor: /points in Portuguese | 9.4-9.7 s | 5.8 s (HTTP/1.1, first report) | **5.0-5.1 s** |
| Bytes before first pixels, /trade | 1,003 KB | ~885 KB | **7-11 KB** |
| Bytes before the largest paint, /trade | 1,036 KB | - | **709 KB** |
| Switch to /trade from another page, data on screen | 2.2-2.3 s | 4.3-4.7 s (regression) | **1.3-1.4 s** |
| Switch to Cohorts / Leaderboard / Points, data on screen | 0.7-1.2 s | 0.8-2.5 s | **0.7-1.2 s** |
| Tap on a tab -> the tab lit | 80-98 ms (navbar link) | - | **9-17 ms** |
| Tap on a tab -> next page drawn, its code already in (Bots, Portfolio) | 89-98 ms | - | **88-112 ms** |
| Tap -> Trade drawn with its chart | 979-982 ms | - | **180-241 ms** |

| Fast 4G | before | after |
|---|---|---|
| First pixels, every page | 1.5-2.3 s | **0.47-0.49 s** |
| Data on screen, cold: trade / cohorts / leaderboard / points | 3.4 / 2.4-2.5 / 2.1-2.2 / 2.1 s | **2.3-2.4 / 1.7 / 1.4-1.5 / 1.7-2.4 s** |
| Switch to /trade | 0.9-1.1 s | **0.7-0.8 s** |

**What "under 100 ms" means here, honestly.** A tap answers in under 100 ms: the tab lights in 9-17 ms, a page
whose code is in draws in ~90-110 ms, a kept series or a kept answer paints in the next frame. Anything that needs the
network cannot: one Slow 4G round trip is 562 ms by definition, so a cold page's own data is bounded by the round
trips it needs (HTML, code, data) and the bytes at 180 KB/s. The work went into cutting round trips and bytes from
that path (first pixels from 7.7 s to 1.3 s), not into hiding them. On the server, the index answers the phone reads
are now built once and served from memory: cohorts 0.24 -> 0.008 ms, leaderboard page 8.0 -> 0.19 ms, map 0.21 ->
0.006 ms per answer (perf/server, unit-measured), and a cold liquidation tile index answers in under 4 s instead of a
504 after 30 s.

### What changed, by package

- **First pixels (`perf/shell`)**: a static app shell in `index.html` (bars, cards, the tab bar; its own tokens; no
  text to translate) paints before the stylesheet and the code; `src/bootShell.ts` fades it out under the app.
  Re-laid on the final phone layout within 1 px on every page, both themes. `theme-boot.js` served from an immutable
  hashed URL; theme-color meta; metric-matched fallback faces (Plex/Space Grotesk/Asap within 0.3%/0.01%/1.8% width);
  the terms popup opens over the shell without waiting for the landing page; /points preconnects SoDEX's biz host.
  Per-route critical CSS measured and not done (at most 0.3-0.4 s, costs a second download and a full restyle).
- **Code diet (`perf/diet`)**: /trade first render 690 -> 528 KB br (widgets no phone layout places are chunks of
  their own, prefetched after load), entry 323 -> 255 KB br (wallet-only code loads with a wallet), /points 421 ->
  285 KB br, /explore 439 -> 284 KB br; 13 oversized logos/pictures re-encoded at their drawn size (-746 KB, e.g. a
  297 KB JPEG drawn at 20 px -> 5 KB).
- **Chart (`perf/chart`)**: candle and ticker reads start when the trade code runs; klinecharts imported then too;
  closed bars kept per series in memory and IndexedDB, so a seen market/timeframe or a return draws in the next frame
  (Slow 4G reload: candles 2.6 -> 1.4-1.8 s); older history only at the first pan; reads start on pointer-down; no
  redraws while the chart is swiped away (5 -> 0 clears/s); the ticket's glare paused off screen (style recalcs
  61 -> 24/s, main thread 437 -> 240 ms/s).
- **Index data (`perf/data`)**: the landing page's first reads start from the route script while the HTML is read;
  what a URL read last time is remembered and started early; a kept answer paints at once with its as-of time and is
  replaced by the fresh one; the live socket replaces in-flight reads; translations in two files (shared shell text +
  the page's), `dist/i18n` 70.6 -> 40.4 MB.
- **Index API (`perf/server`)**: Server-Timing; ETag/304 and a compressed-body cache for routes with their own
  Cache-Control; leaderboard pages memoised per board version (43x), cohort answers built once per load (30x),
  screener pools warm while idle (first search after a quiet night 6.8-20.5 s -> at once).
- **Liquidations (`perf/liq`)**: no 504 for a cold venue set (concurrent builds deduped, answer with what is held);
  slim and per-bar tiles (phone 1h study 508 -> 75 KB, 4h 2,222 -> 117 KB, every drawn rectangle identical); final
  tiles at brotli 11 (-29%); the Liq. map polls the step it draws (50 -> 20 KB); the widget is its own chunk.
- **Navigation and motion (`perf/nav`)**: the tapped tab lights in the same frame, the app's spinner after 250 ms if
  the page is not ready; 14 in-app links no longer reload the app; one scroll manager (a new page at its top, Back
  restores); the incoming page fades on the chart's curve (opacity only, compositor); phone sheets slide from the
  bottom with drag-to-dismiss; press feedback on pointer-down; no sticky hover on touch; no pull-to-refresh on the
  page scroller; blur dropped on phones where it blurred a smooth gradient (<= 2/255 pixel difference); motion tokens
  share the chart's easing.
- **Phone UX (`perf/ux`)**: one navbar row on phones, so the chart gets ~360 px of candles instead of 206; dialogs
  fit short phones and scroll; the carousel keeps its page and hints once; Points without a wallet gets a real
  connect card; the browser's language is the default for a visitor who never chose (pt-BR -> Portuguese); no iOS
  zoom on focusing a field; offline shown as offline, not as our outage; cards no longer sit under the tab bar.
- **After merging (this branch)**: a kept liquidation snapshot gives way to the HTTP answer and lapses after 10 s;
  a landed tap or Back always clears the lit tab's pending state; every page's code is prefetched after the tab bar's
  pages on every connection but Save-Data (left to intent on Slow 4G, a switch to Cohorts took 2.2-5.3 s).

### Screenshots

`desk/screenshots/phone-2026-11-18/` (gitignored): `compare-1-trade-load-slow4g.png` (the cold /trade load at 1, 2, 4,
6, 8 and 10 s, before above, after below), `compare-2-trade-settled.png`, `compare-3-navigation.png`,
`compare-4-connect.png`, `compare-5-bots-new.png`; the single pictures in `before/`, `before-h2/` and `after-phase2/`.

### Not done, and why

- **Cold data under 100 ms**: not possible over a 562 ms round trip (above). What remains on the cold /trade path is
  the 709 KB before the largest paint (the trade page's code and its chart library) at 180 KB/s.
- **Frame timing of the sheet and page transitions** (dropped frames at 4x CPU) was not recorded; the transitions
  were moved to opacity/transform on the compositor and off layout properties, but no number proves it yet.
- **Fallback face for Android's Roboto**: needs Roboto's metrics from its own file (a download).
- **Back/forward cache**: blocked by the leader tab's WebSockets and Web Lock (the live layer, not touched).
- **Real phones**: everything here is emulated; nothing was tried on a real Android phone or iPhone.

## Speed on a slow phone

### How it was measured

- **Profile**: Chrome DevTools' "Slow 4G" preset, the values from its own source (`NetworkManager.ts` Slow4GConditions:
  1.6 Mbit/s x 0.9 down, 750 kbit/s x 0.9 up, 150 ms x 3.75 latency), plus 4x CPU slowdown; 375x812 at 2x, an Android
  Chrome user agent, touch on; cold cache, a fresh profile per load.
- **Builds**: "before" is `6556aee3` (feat/bots), "after" is this branch, both `vite build`, served side by side by a
  small static server that sends brotli like Vercel does (quality 11, `/assets` immutable), `/api` to a dev server
  on production's data. The harness scripts are listed at the end.
- **Language shown**: the moment none of "Connect wallet", "Mark Price", "Order Book" (on /points only "Connect
  wallet") is left in the page's text: the screen reads in the chosen language.
- Two before runs per English page: /trade and /points agreed to 0.1 s, / ranged 8.9-9.7 s (the table gives the
  median). After is one run per row, and so are the before language rows.

### Results

| page, language | first paint | largest paint | language shown | translations | site traffic, first 30 s |
|---|---|---|---|---|---|
| `/` English | 9.3 -> 9.2 s | 9.7 -> 9.5 s | - | - | 1,825 -> 1,003 KB |
| `/trade` English | 9.0 -> **8.0** s | 9.5 -> **8.5** s | - | - | 1,825 -> 1,003 KB |
| `/points` English | 6.3 -> **5.5** s | 7.8 -> **6.4** s | - | - | 1,757 -> 711 KB |
| `/trade` Portuguese | 8.9 -> 8.1 s | 9.6 -> 8.3 s | 16.5 -> **8.3** s | 156 -> 98 KB | 1,982 -> 1,102 KB |
| `/points` Portuguese | 6.3 -> 5.6 s | 7.8 -> 5.8 s | 18.3 -> **5.8** s | 156 -> 70 KB | 1,915 -> 782 KB |
| `/trade` German | 8.9 -> 8.2 s | 9.6 -> 8.4 s | 16.5 -> **8.3** s | 161 -> 101 KB | 1,988 -> 1,105 KB |
| `/points` German | 6.3 -> 5.7 s | 7.7 -> 5.8 s | 18.3 -> **5.8** s | 161 -> 72 KB | 1,920 -> 785 KB |

Before, the whole catalogue had arrived by 10.0 s (/trade) and 8.2 s (/points), but the page read in Portuguese only
at 16.5 s and 18.3 s. That gap is most likely the cost of building the matcher over all 9,000 entries and walking
the page on a 4x slowed CPU; it was not profiled.

What loads before the first paint did not shrink (878 KB before, 887 KB after in English, ~930 KB in Portuguese
with its landing text). It is dominated by two files every page needs: the entry script (258 KB brotli, 933 KB raw)
and the one stylesheet (129 KB brotli, 1.0 MB raw, every page's rules). On "Slow 4G" those two alone take ~2.2 s of
the line. Cutting them is the next lever and a pass of its own (the stylesheet's order is pinned by `cssOrder.ts`).

### What changed

1. **Translations in parts** (`tools/i18n-parts.mjs`, `src/i18n/store.ts`). Each chunk of the build gets the part
   of every catalogue its own modules write (the extractor already knew which file holds each string); the chunk
   names its part when it runs, and the store fetches it then. The landing page's text (the shell's parts and the
   page's own) is one prebuilt file per language, preloaded from the first second. Other pages' parts wait until
   that page is opened, or its link touched; a missing part falls back to the whole catalogue once. Only a build
   has parts: the dev server and the language audit keep reading the whole catalogue.
   - Tried and dropped on the way, both measured: one request per part, fetched as each chunk runs (Portuguese
     /trade read at 11.6 s) or preloaded all at once (12.5 s). Tens of small requests each waited a round trip
     behind their own chunk.
2. **The landing page's chunks are asked for while the HTML is read** (`tools/route-preload.mjs`): an async
   script maps the path to the page's chunks and adds a modulepreload for each. They used to be requested only
   once the 258 KB entry had downloaded and run.
3. **No wallet kit up front on phones**: AppKit (0.55 MB on the wire) was fetched on every page as the header
   mounted. On a phone outside a wallet's browser it now loads only for WalletConnect (see above).
4. **Other pages' code after the load event**, not right after the first render, and not at all (only on a touch
   of a link) when the browser says the visitor saves data or is on 2G/3G.

## Connecting a wallet

### How it was (measured at 375x812 with an Android Chrome user agent)

- Every Connect button opens our dialog. On a phone its rows were SafePal, Bitget, MetaMask, WalletConnect and
  Other Wallet: no OKX, Trust or Rabby. A stray "or" rule sat above the list with nothing on its other side.
- Opening the dialog started AppKit (about 1.8 MB of script, 0.55 MB on the wire). It was fetched on every page
  anyway, as soon as the header mounted.
- A wallet row (MetaMask) opened AppKit's "Continue in MetaMask" view, which navigated to
  `metamask://wc?uri=wc:…` (recorded with a patched `window.open`). That is a WalletConnect pairing through a custom
  scheme:
  - on Android a custom scheme does nothing when the app is missing (no store page, no error);
  - after the approval the visitor has to find their way back to the browser by hand;
  - every later signature (the site terms, the trading key) is another trip to the wallet app and back, while the
    relay socket of the backgrounded browser tab may be suspended.

### How it is now

- **A phone row opens ValueDesk inside the wallet's own browser**, by the link each wallet documents for that.
  In there the wallet injects its provider, so connecting and every later signature are prompts on the same
  screen. Each link is from the wallet's own documentation, read 2026-11-18 (`src/walletLinks.ts` has the sources):

  | wallet | link | source |
  |---|---|---|
  | MetaMask | `https://link.metamask.io/dapp/{url without scheme}` | docs.metamask.io, "Use deeplinks" |
  | OKX Wallet | `https://web3.okx.com/download?deeplink=` + enc(`okx://wallet/dapp/url?dappUrl=` + enc(url)) | OKX "App Universal Link" (page now 404; archive copy of 2025-12-06) |
  | Trust Wallet | `https://link.trustwallet.com/open_url?coin_id=60&url={url}` | Trust "Deep Linking" (archive copy of 2026-01-12) |
  | Bitget | `https://bkcode.vip?action=dapp&url={url}` (Android takes only the https form) | web3.bitget.com, "Deeplink" |
  | Rabby | none documented: the row copies the page's address and says where to paste it | Rabby support: use Rabby's own browser on a phone |
  | SafePal | none documented: copy the address, or use WalletConnect | SafePal docs: paste it into the DApp search bar |

  MetaMask's and Trust's https links go to a download page when the app is missing (their docs say so); OKX's goes
  through OKX's download page; Bitget does not document it.
- **Inside a wallet's browser, ValueDesk connects straight away**: once the welcome has been answered, the dialog
  skips its list and the wallet's prompt comes up. Not when a saved connection is being restored, not after a
  Disconnect there, and once per tab. The wallet is told apart by what it documents: OKX's `OKApp` user agent and
  `window.okxwallet`, Bitget's `window.bitkeep`, SafePal's user agent and `window.isSafePal`, then `isRabby`,
  `isTrust`, `isMetaMask`. Any other injected provider on a phone connects as "your wallet".
- WalletConnect and Other Wallet stay, under "or stay in this browser", for a visitor who wants to stay in Chrome.
- AppKit is no longer fetched up front on a phone outside a wallet's browser; WalletConnect and Other Wallet load
  it when pressed. Desktop is unchanged.
- **Not tested on a real phone with the wallet apps**: there is no phone on this laptop. The links are exactly the
  documented forms (unit-tested in `walletLinks.test.ts`). The page they open, and the in-wallet connect, were
  checked with the Android Chrome emulation and an injected provider.

## Navigation

- **Tab bar** below 761px (the width the rail gives way to the navbar's phone layout): Trade, Bots, Points,
  Portfolio, More. Each is 75x56 px on a 375px phone, above the home indicator's safe area. The page on screen is
  lit by colour and a filled icon. More opens the navbar's More rows (the same component, `NavMoreBody`) in a sheet
  from the bottom, with Explore, Copy and Scan on top. The navbar's link strip is hidden on those widths.
- **Bot setup**: on a phone, Back / Next / Start sit in a bar fixed above the tab bar, with the step and the
  reason a button is off (`PhoneActionBar.tsx`). They are the same buttons as in the receipt, so they have the
  same handlers and states.
- **Charts**: the trade chart (klinecharts 10) already pans with one finger and zooms with two; checked with real
  touch events over the DevTools protocol at 375x812 (a one-finger swipe moved the candles, a two-finger spread
  zoomed in, the page did not scroll). Nothing needed changing there.
- **Tap targets**: on a touch screen of phone width, buttons, tabs, segmented options, selects and inputs are at
  least 44px tall (styles.css had a 34px floor there); the top bar's icons are 44x44 boxes; small icon-only controls
  (a favourite's x, an indicator's eye) keep their drawn size and get a wider invisible hit area. An audit at
  375x812 went from 109 to 68 targets under 44px on /trade, 16 to 9 on /points, 24 to 14 on Bots, 33 to 9 on
  Portfolio; what is left is narrower than 44px but 44px tall, plus the order book's 29px rows, kept at their
  density on purpose.
- **Bot setup stepper** on a phone: only the current step keeps its title (five titles ran into each other in
  343px); the others keep their number or check.

## Sharing

`src/share/nativeShare.ts`: on a touch phone with `navigator.share`, the share card dialog's Share sends the
picture itself where the browser hands on files (WhatsApp and Telegram take it as an image), and the link only
where it does not (the dialog says so). The referral link (Referrals page, the bot savings card) gets Share as its
first button on a phone. A refusal falls back to Save / Copy; a browser without the sheet keeps the old buttons.

## Installing ValueDesk (not built: for the owner to decide)

What it would take to make ValueDesk an app on the home screen, with notifications:

1. **A web app manifest** (`manifest.webmanifest`): name, icons (192 and 512 px PNG, plus a maskable one), start
   URL, `display: standalone`, theme colours for both themes. Chrome on Android then offers "Install app" from its
   menu. Since Chrome 108 on Android (112 on desktop) a service worker is no longer required for that
   (developer.chrome.com, "Revisiting Chrome's installability criteria").
2. **An install button of our own** (`beforeinstallprompt`, Chrome and Edge only): when to show it, where (More's
   sheet, Settings) and how often.
3. **iPhone**: Safari has no install prompt. Installing is Share -> Add to Home Screen, so a hint that shows those
   steps once, to iOS Safari visitors only.
4. **A service worker**, only if the app should open without a network or cache the shell. It brings the one
   real risk of the whole thing: a worker that keeps serving an old build after a deploy. It needs its own
   update path (a version check against `buildInfo`, `skipWaiting` on the next navigation), a `no-store` header
   for `sw.js` on Vercel (`deploy/vercel/package.mjs`) and `worker-src 'self'` in the CSP.
5. **Push notifications** (fills, a bot stopping, a liquidation warning):
   - a VAPID key pair, a server route that stores each device's subscription per wallet, and a sender on server 1
     or 2 (the `web-push` library);
   - on iPhone, web push works only for a site added to the home screen (iOS 16.4 and later, WebKit's "Web Push
     for Web Apps on iOS and iPadOS"), so 3. comes first;
   - the browsers' push services (Google's, Apple's, Mozilla's) are free to my knowledge; not checked for this note.

Cost, all of it work rather than money (my estimates): 1-3 are about a day; 4 is one to two days with its deploy tests; 5 is two
to three days plus a decision on which events are worth a notification, and one more place a wallet's activity
is stored.

## Tests

- Typecheck: `apps/web` and `apps/web/e2e/ui`, clean.
- Web unit tests: 2,019 pass, 1 skipped, 0 fail. New: `walletLinks.test.ts` (every link against its documented
  form, wallet-browser detection, connect-once rules), `share/nativeShare.test.ts`, `i18n/parts.test.ts` (what is
  fetched when, held parts, the landing file, fallbacks, language switch, dev mode).
- Tools tests: 11 pass, among them `route-preload.test.mjs`. The extractor refactor gives a byte-identical `en.json`.
- UI e2e (Edge, `e2e/ui/run.ts`), bots, walletMenu, accountActions, referrals, onboarding, notices and portfolio,
  desktop and phone, against a local API with the indexer off and no executor (so nothing reaches production). The
  same 60 tests were run on the base commit in the same setup: desktop results are identical; on phone the branch
  first failed 4 more (the onboarding spec's own Connect helper, and the tab bar covering the notifications
  panel's backdrop), both fixed, all 4 pass now. The other failures (bot tables, swaps, positions: no indexer, no
  executor) fail on the base commit the same way.
- Not tested: the wallet apps themselves on a real phone; the share sheet on a real phone (`navigator.share` is
  unit-tested against a fake).

## Open points

- **New text is not translated yet**: `i18n/en.json` on feat/bots was already ~950 strings behind the code before
  this pass, and the phone strings ("Pick your wallet...", "Open app", the tab bar's More sheet) join them. They show
  in English until the next catalogue refresh.
- **Build size**: `dist/i18n` grows from ~11.5 MB to 71 MB raw (17 languages x 89 files; the 11 landing files hold
  most of it). Served compressed and only per visitor, but every deploy carries it. Halving it is possible by
  keeping the shell's text in one shared file instead of inside every landing file (two requests instead of one).
- **The bot setup's market table** overlaps its columns at 375px (step 2); not part of this pass.
- **The next speed lever** is the 258 KB entry script and the 129 KB stylesheet every page waits for.

## Harness

In `apps/web/tools/perf/`, next to `cdp.mjs` they use: `serve-br.mjs` (a built dist served with brotli like Vercel,
`/api` to a dev server on production's data), `phone-load.mjs` (the Slow 4G + 4x CPU phone loads above),
`tap-audit.mjs` (targets under 44px at 375x812) and `touch-chart.mjs` (one-finger pan, two-finger pinch). Run them
from `apps/web`. Screenshots of every changed screen, 375x812 and 1440x900, dark and light:
`desk/screenshots/phone-2026-11-18/` (gitignored).

## Cost

Figures from Vercel billing and observability for 11-11 to 11-17 (billing days 08:00-08:00 UTC) and AWS Cost
Explorer for 10-19 to 11-17, read-only; nothing in a dashboard, account or on a server was changed. "Estimate" marks a
number derived from those, not billed as such.

**Vercel today: $0.879/day** (mean of 11-15 to 11-17, ~$26/month): Pro $0.645 (73%), Deployment Storage $0.123,
Observability Events $0.028, Fluid Provisioned Memory $0.027, Build CPU $0.026 (8-day mean $0.036), Fluid Active CPU
$0.015, Function Invocations $0.008, Web Analytics $0.004, Fast Origin Transfer $0.002. CDN requests and data transfer:
$0.00 on all 8 days. The /api function cost $0.048 on 11-17 (10,039 calls, 1.416 GB-hr, 126.7 CPU-s); 62% of it was our
own monitors.

### What this branch changes in code (branch `perf/edge`)

| change | where | effect |
|---|---|---|
| The health check asks its public peers under `/api/` every 5 min while they answer (every pass while they fail); the status prober stays the one public probe, every minute | `deploy/server/bin/healthcheck.mjs`, `deploy/contabo/server*/health.env` (`HEALTH_PUBLIC_API_EVERY_S=300`) | -2,304 function calls/day (2,880 -> 576), ~23% of all; ~$0.010/day (estimate from the per-path shares) |
| Hedge invites every 60 s, only while the page is in view, at once on coming back (was every 15 s, hidden or not) | `components/bots/HedgeInvites.tsx`, `exchange/visibility.ts` pollWhileShown | 581 calls/day -> ~145 plus one per return to the tab; ~$0.0023/day |
| Fee terms asked again 3 min before they run out (7 min with the server's 10 min ttl; was every 4 min); an ask that fails while terms are held - no answer, the function's 502/504, the server's `{ok:false}` - is retried a minute later, three times | `trading/terms.ts` termsRefreshDelay, followRun | up to -43% of 728 calls/day (the share of them that are the follow's own asks is not known; the rest are asks before an order or on opening the fee schedule); ~$0.0006/day at most |
| `GET /api/copy{,-vip}/v1/algos/stream` answered 204 in the function (only tabs on a bundle from before 2026-11-13 still ask there) | `deploy/vercel/api-proxy.cjs` | a stale tab no longer holds the function: 0.384 GB-hr/day averaged over 11-15..17 (0.953 on 11-15) -> ~0; ~$0.006/day, and no repeat of 11-12's 49.5 GB-hr. Not free: such a tab falls back to the polls it runs while its stream is down, through the function and only while it is visible - the bots list every 5 s, an open bot every second (old `bots/useBots.ts` BOTS_POLL_MS, BOT_LIVE_MS), up to 72 short calls a minute - plus one stream try about every 64 s, hidden or not |
| One ONNX Runtime build (the CPU one, 14.3 MB) instead of jsep 28.4 MB + asyncify 26.9 MB; same transcripts word for word on three test clips | `vite.config.ts` alias, `fedlive/stt.worker.ts` | -41.0 MB in each deployment's output (a third of main's ~125 MB, ~22% of this branch's ~184 MB with its translations); a Fed live start downloads 14.1 MB less |
| The speech model (32.1 MB) kept in Vercel's build cache, every file checked by sha256 | `deploy/vercel/fetch-model.sh`, `model.sha256`, package.mjs `cache` | no Hugging Face download per build once the cache is filled (the build log says `8 file(s) from .cache/valuedesk-model as they were, 0 fetched`) |
| Keep-alive connections function -> origin; Server-Timing (`fn`, `oc`, `ot`, `retry`, `cold`) on every answer | `deploy/vercel/api-proxy.cjs` | per edge miss no DNS + TCP + TLS to the origin (unmeasured, est. 15-40 ms); the timings make the rest measurable |
| A past heatmap cell (`/api/vs/liquidations/at`, shown with its "As of" time) kept at the edge as long as the origin says, 5 min + 5 min stale (was capped at 60 + 60 s). The boards and the cohort pages keep the origin's own 10 + 20 s and 30 + 30 s: a longer edge window was tried and taken back, because most of their screens show no as-of time and an edge copy's age adds to the data's own | `deploy/vercel/api-proxy.cjs` EDGE_MAX_TTL_BY_PATH | fewer function calls while scrubbing the heatmap's history; unmeasured (177 /api HITs in 3 days before) |
| Content-hashed translations immutable for a year; unhashed files with a stale window, except unhashed scripts (`/theme-boot.js`, the Fed live AudioWorklet `/fedlive/tap-worklet.js`) and `/scan/`: an hour without one, so a browser never runs a script more than an hour old against a newer app | `deploy/smoke/prod-headers.mjs`, `deploy/vercel/package.mjs` | speed only (CDN transfer bills $0): a return visit in Portuguese no longer waits a round trip for its text |

Together about -$0.019/day of the $0.048/day function bill (estimate), plus the storage of 41 MB less per new
deployment ($0.00014/day per kept deployment at the derived $0.00343/GB-day) - only if Vercel stores identical files
again for every deployment: the cost map's rate assumes no dedup, which is unverified, and the wasm files have the same
content-hashed names in every build, so with dedup the 41 MB are saved once, not per deployment. A phone visit to `/trade` (375 px,
Android, 25 s incl. the after-load prefetch) requests no wasm, model or speech worker, before and after: they load only
when the Fed live widget is started.

Not moved: **`/api/edge/geo` stays in the function.** The documented edge features cannot echo the viewer's country and
region into an answer (route `transforms` take fixed text, environment variables or captures of the path, not of a
request header); Routing Middleware would answer at the edge but is billed compute per call like the function; one
static file per country (~250 routes) would drop the region everywhere but the sanctioned regions - a change to a
legal-gate input - to save one call per page load (~209 a day by the 11-17 page views, ~$0.0002/day) on a read that
is not on the render path.

### For the owner: dashboard and AWS levers (none of them done)

Vercel (project `valuedesk`, team settings):

| lever | now | saving | risk |
|---|---|---|---|
| **Deployment retention**: production ~1 month (or 2 weeks), preview/canceled/errored 1 week; remove the 119 READY previews of retired branches | Deployment Storage $0.1234/day, never falls: 417 deployments kept since 10-23 (356 READY: 237 production, 119 preview), each new one +$0.00043/day | ~$0.09-0.11/day once they age out (to ~$0.012-0.017/day for ~27 kept), full effect mid-December; the previews alone up to ~$0.04/day (estimate, sizes not verified) | no rollback older than the window; old preview URLs stop working; whether removed deployments bill during Vercel's 30-day recovery period is not verified |
| **Function memory size** (under Fluid it is set in the dashboard, not in `.vc-config.json`) | 2,048 MB provisioned; peak use 209-243 MB over 7 days | ~$0.013/day at 1 GB (Fluid memory, billed per GB-hr) | CPU scales with memory; mean CPU per call ~13 ms. Whether Pro offers 1 GB under Fluid is not verified |
| **Observability tier**: find which tier bills "Observability Events", lower or switch it off | $0.028/day (valuedesk 88% of the sampled events) | up to $0.028/day; the monitor cut above probably lowers it already (not verified) | lose the per-path calls, GB-hr and cache metrics this audit used, and the logs for incidents |
| Web Analytics + Speed Insights off (our own consent-gated `/api/vs/a` collects pages and vitals) | $0.0043/day | $0.0043/day | lose Vercel's dashboards |
| Status page's executor probe straight to server 2 (`VALUESCAN_STATUS_EXECUTOR_URL`, the d0ec50b5 config line waiting for your OK) | the prober asks `/api/copy/v1/health` through the function every minute (1,440 calls/day) | ~$0.009/day | the executor line no longer measures the visitor's way |
| Build outside Vercel (`vercel deploy --prebuilt`; package.mjs already writes the output) | Build CPU $0.036/day (8-day mean, $0.021-0.028 per 151 s build) | up to $0.036/day on Vercel | the cost moves (GitHub Actions minutes are billed for this private repo); the laptop uploads at 10 Mbit/s at most; a Vercel token in CI |
| Leave Vercel Pro (site and /api edge on our own servers) | $0.88/day, Pro alone $0.645 | all of it | large: our own GeoIP for the 451 rules and `/api/edge/geo`, no global CDN, git deploys or Vercel analytics; server 1 becomes the single point for site and API |

AWS (ValueDesk is ~$0.19-0.22/day of the account's ~$8/day; ~97% is katana, not ours):

| lever | now | saving | risk |
|---|---|---|---|
| **The VIP box's price, decide before 2026-12-31**: the t4g.small free trial (750 pooled h/month) ends then | $0.00 compute; from 2027-01-01 on-demand $0.0216/h = $0.518/day | vs on-demand: 1-year Standard RI no upfront ($0.0136/h) $0.19/day (~$70/yr); all upfront ($111/yr) ~$0.21/day; Convertible no upfront $0.0170/h; t4g.micro ($0.0108/h) $0.26/day (~$94/yr); VIP executor moved to Contabo server 2 ~$0.71/day incl. IPv4 and disk | an RI locks the type in Tokyo for a year; t4g.micro has 1 GB RAM vs 2 GB and the box's memory use was never measured (it runs the VIP and test executors, the feed and Caddy with 1 GB swap); Contabo gives up AWS Tokyo, the reason the VIP tier exists |
| Keep the 750 free t4g hours for the VIP box alone (a us-east-1 t4g.small used 34 h of the pool on 10-19/20; December needs 744 h) | - | avoids $0.518/day per extra t4g.small once the pool is used | none: a usage rule |
| The VIP box's public IPv4 (EIP 54.64.113.41) | $0.12/day (~$3.6/30 days) | $0.12/day with IPv6-only egress and an IPv6 origin | high: IPv6 support of SoDEX, Binance and the Contabo servers not checked; the address is in server 1's Caddy upstream, the SG allowlists and the sslip.io certificate |
| The VIP box's disk: 20 GB gp3 -> ~8 GB | $0.064/day | $0.038/day ($1.15/month) | gp3 cannot shrink in place: a rebuild or migration; disk use not measured |
| VIP Binance feed stays on demand (`FEED_ON_DEMAND=1`; an alarm on NetworkIn is your call, none is set in Tokyo) | under 1 GB/day in (was 76-272 GB/day) | already realised: $0.76-2.85/day | it comes back silently if the box's drop-in is lost, code without on-demand ships, or Binance-ref bots run on VIP all the time |

Nothing billable is left over in AWS (old Tokyo instance gone, Frankfurt empty, no unattached EIPs, snapshots, AMIs,
NAT gateways, load balancers or ValueDesk S3 buckets); the unused SG `valuescan-tokyo-origin` costs nothing.

**How to check after shipping**: Vercel Observability per path, a day after the release - calls of `/api/health`,
`/api/copy/v1/health`, `/api/copy/v1/algos/invites`, `/api/vs/builder/terms`, the two stream paths, and what old tabs
fall back to after the 204: `/api/copy/v1/algos` and `/api/copy{,-vip}/v1/algos/<id>` per day against the days before;
`x-vercel-cache` HIT/STALE on `/api/vs/liquidations/at`;
`curl -sD- -o /dev/null --limit-rate 2M https://www.valuedesk.so/api/health` shows the `Server-Timing`
(`oc;dur=0;desc="reused"` on a warm instance); the second Vercel build after the release logs the model taken from the
cache; Deployment Storage: its daily increase over the next two deployments against the ~$0.00043/day each added
before (11-13..16) tells whether the 41 MB are saved per deployment (no dedup) or once.
