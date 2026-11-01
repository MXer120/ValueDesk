# ValueDesk traffic: who talks to whom

Status: 2026-09-30. Owner of this inventory: the browser-direct rework.

**The rule.** Every user's exchange and chain traffic leaves from that user's own
browser and IP, straight to the exchange. The ValueDesk server serves the site and
its **index** (leaderboards, cohorts, screener, explore, the whales tape and
positioning) and nothing that is one user's exchange traffic. Nothing about a
connected wallet, a scanned wallet, an order, a fill, a deposit address or a
balance passes through ValueDesk any more, and each user spends their own per-IP
budget at each venue.

Dev and production run the same code path: the browser goes to the exchanges
directly in both. The Vite proxy only carries the index API (`/api/*`) in dev.

---

## 1. Inventory

Class: **(a)** per-user exchange/chain traffic - now browser-direct;
**(b)** index-backed - stays on the ValueDesk server; **(c)** other.

### 1.1 SoDEX market data - (a)

| Call (web) | Before | Now | Why |
|---|---|---|---|
| `api.symbols/tickers/markPrices/coins/orderbook/publicTrades`, Market.tsx polls, useSymbols | `/api/md/{engine}/*` | `https://mainnet-gw.sodex.dev/api/v1/{engine}/markets/*` (exchange/sodexMarket.ts) | public, CORS-open; server's weights, TTLs and cooldowns imported from `sodex/restCore.ts` |
| Chart candles (klines.ts, `api.klines`) | `/api/md/{engine}/klines` | gateway `/markets/{s}/klines`; mark/index candles from `mainnet-data.sodex.dev` (`sodex/priceKlinesCore.ts`) | same |
| Order book / trades / candles / tickers stream | `/ws` (server hub) | `wss://mainnet-gw.sodex.dev/ws/{perps,spot}` from ONE socket host per browser (section 3) | the hub is gone for the web |

### 1.2 SoDEX account reads (own wallet and scanned wallets) - (a)

| Call (web) | Before | Now | Why |
|---|---|---|---|
| `api.state/balances/openOrders/positions/feeRate` (Portfolio model, FeeTier, trade page panels, toasts) | `/api/acct/{engine}/*` | gateway `/api/v1/{engine}/accounts/{a}/*` (exchange/sodexAccount.ts) | public reads keyed by address |
| History tabs: `orderHistory/userTrades/fundingHistory/positionHistory` (accountData.ts) | `/api/acct/*/…history`, `/trades`, `/fundings` | gateway, through the history drip (section 2) | HARD rule: never burst `/trades` + `/orders/history` |
| `api.walletAccount`, `api.moneyOverview`, `api.onboarding` | `/api/wallet/account`, `/api/money/overview`, `/api/onboarding` | assembled in the browser from gateway reads (+ one ValueChain RPC balance for onboarding) | same answer shapes |
| Portfolio volume/rank, Leaderboard rank of a wallet | `/api/external/leaderboard/rank` | `mainnet-data.sodex.dev` (exchange/sodexData.ts) | per-address |
| SoDEX leaderboard panel | `/api/external/leaderboard` | data host direct | SoDEX's own board, public |
| Portfolio chart (performance.ts) | data host / gateway | through the shared clients (limiter, cooldowns) | same hosts, now budgeted |
| **All-time stats** (Stats panel, Portfolio lifetime figures) | `/api/stats/all-time` (server walked the whole history into SQLite) | exchange/allTime.ts: the same engine (`historySync.ts`), totals (`historyStats.ts`) and answer (`statsCore.ts`), walked from the browser, kept in IndexedDB (`vs-history`, last 6 wallets) | a wallet's entire fill history is per-user traffic; `/api/stats/*` is not in hosted mode |

### 1.3 Trading and funds - (a)

| Call (web) | Before | Now | Why |
|---|---|---|---|
| Place / cancel / modify / replace orders, leverage, margin, schedule-cancel, spot<->perps transfer, withdraw | browser-signed, sent to the gateway (unchanged) | unchanged; each write is now counted against the browser's per-IP budget (`chargeWrite`) | the gateway allows CORS on signed routes |
| Gateway reads the trading code makes (`readGateway`, session checks) | direct | through the shared gateway client (budget, dedupe, cooldown) | one budget per browser |
| Deposit addresses (`api.depositOptions`) | `/api/mirror/deposit-options` | exchange/deposits.ts: ValueChain registries by `eth_call` (batched) + sodex.com's issuer, cross-checked with the server's rules (`sodex/depositOptions.ts`) | per-wallet; identical result (41 routes checked) |
| "Confirm & update address" (`api.replaceDepositAddress`) | `/api/mirror/replace-deposit-address` | alpha-biz direct, same 30 s / flagged-only guard | per-wallet |
| ValueChain parameters (`api.depositChain`) | `/api/deposit/chain` | pinned in the bundle (`sodex/chainParams.ts`) | a compromised API cannot re-point deposits |
| Wallet balance fallback (funds.ts) | `/api/deposit/assets` | ValueChain explorer (Blockscout API, exact base units) | per-wallet |
| Wallet deposits / permits | wallet + public RPCs | unchanged | already direct |

### 1.4 Scan, trader profiles, palette - (a) unless noted

| Call (web) | Before | Now | Why |
|---|---|---|---|
| `vsApi.trader/fills/openOrders/orderHistory/funding/balances` for SoDEX, Hyperliquid, trade.xyz, Lighter, Arcus (Scan pages, profiles, copy simulator, palette address lookups) | `/api/vs/trader`, `/api/vs/fills`, `/api/vs/account` | exchange/venues.ts: the server's provider code (`valuedesk/sodex/traderCore.ts`, `hyperliquid/trader.ts`, `extra/providers.ts`) bound to browser clients | per-trader reads |
| Hyperliquid leaderboard row of one address (rank, aggregated PnL) | inside `/api/vs/trader` | **(b)** `/api/vs/lbrow` (to be added, see 5), meanwhile `/api/vs/leaderboard?q=` without the rank | that row lives in the server's 39 MB index |
| Cohort asset price chart (`vsApi.price`) | `/api/vs/price` | Hyperliquid `candleSnapshot` direct (`hyperliquid/price.ts`) | public market data |
| Palette search (`usePaletteData`) | `/api/vs/screener` | unchanged | **(b)** index |

### 1.5 Stays on the ValueDesk server

| Call (web) | Path | Class | Why it stays |
|---|---|---|---|
| Leaderboards, Explore, cohorts (+ detail, map, focus, wallets, the excluded wallets), liquidation heatmap (+ wallets, history, a wallet's positions; live over `/ws/liq`, browser to instance), screener | `/api/vs/leaderboard`, `/explore`, `/cohorts*`, `/excluded`, `/liquidations*`, `/ws/liq`, `/screener` | (b) | the index is the server's job |
| Who traded a candle (chart view: every wallet's volume, sides, prices, fills; one wallet's fills) | `/api/vs/flow`, `/api/vs/flow/wallet` | (b) | the venues' public prints, both parties, recorded by the indexer (apps/server/src/flow/) |
| Whales tape, positioning | `/api/vs/whales`, `/api/vs/positioning` | (b) | aggregated server-side from venue trade streams; not one user's traffic |
| Deep link by SoDEX account id (App.tsx) | `/api/feed/account` | (b) | resolved from the index's leaderboard map, on-chain only as a fallback |
| Server status and network | `/api/health` | (c) | about ValueDesk itself |
| Builder fee terms | `/api/vs/builder/terms` | (c) | the fee a wallet owes must be signed by a key the browser cannot hold (docs/BUILDER-TIERS.md) |
| Status page (`/status`) | `/api/vs/status` | (c) | the server probes the site, its own API, the executor and the indexer every minute and keeps 90 days (ops/status.ts); the same answer for everyone |
| Send feedback (a chat with the owner, screenshots), client error reports | `POST /api/vs/feedback`, `/feedback/upload`, `/feedback/thread`, `/feedback/poll`, `/feedback/unread`, `/feedback/session`, `GET /api/vs/feedback/image`, `POST /api/vs/client-errors` | (c) | what a visitor sends the owner and the owner's replies: kept on the server, forwarded by Telegram, replies read back by long polling (routes/reports.ts, docs/GO-LIVE.md) |
| Maintenance banner and page | `/api/external/maintenance/status`, `/api/external/announcements(/:id)` | (c) | global, not per-user. alpha-biz answers any origin, so this can go direct later; kept to keep the change focused |
| SoPoints sign-in | `/api/points/auth/*` | (c) | sodex.com's points API allows only its own origin (CORS), so a browser cannot call it; the page is not mounted (router: points -> trade) |
| Account switcher of the LOCAL server-signing mode | `/api/session/*` | (c) | custodial local mode only; off in hosted mode |
| No caller left: `api.depositAssets/prepareDeposit/depositTx/depositStatus/resolveDestination` | `/api/deposit/*`, `/api/money/resolve-destination` | - | kept for the local custodial mode and the e2e guard test; the UI never calls them |

**Nothing per-user was left on the server.** The web calls no `/api/acct`, `/api/md`,
`/api/stats`, `/api/mirror`, `/api/wallet`, `/api/money/overview`, `/api/onboarding`,
`/api/deposit/chain`, `/api/vs/trader|fills|account|price`,
`/api/external/leaderboard*` and no `/ws`. (Verified in a headless browser: the
network log of the trade page, Portfolio, all five Scan venues, Explore/cohorts, the
palette and the funds sheets shows no request to those paths.)

---

## 2. Budgets, pacing and caches in the browser

The server's numbers, imported rather than copied, now count one user's IP.
SoDEX's are shared by **every tab** of the browser: a sliding-window ledger in
localStorage, updated under a Web Lock (exchange/ledger.ts).

| Venue / host | Budget | Cache / dedupe | On 429, 1015, 503 |
|---|---|---|---|
| SoDEX gateway REST | 1200 weight/min, the documented weight per path (`restCore.weightFor`) | server TTL table (`restCore.ttlFor`); history pages 5 s; identical concurrent reads share one request | 429: cooldown per endpoint for every tab, 15 s doubling to 5 min, never replayed; 503/transient envelope: retry with backoff (4 attempts) |
| SoDEX `/trades` + `/orders/history` (both engines, **together**) | **2 per 60 s** over every tab (HISTORY_DRIP; see below) | last good page kept as a stale fallback | an unreadable failure there IS a 1015 from a browser (the page carries no CORS header): every history read of every tab stops for 60 s, doubling to 10 min; never replayed |
| SoDEX data host | 4 in flight, 80 ms apart (the server's Limiter) | per-path memo (dataCore) | cooldown shared by tabs, 15 s -> 5 min |
| Hyperliquid `/info` | 1000 weight/min per tab (HL: 1200/IP) | server client's caches | 429 penalty + backoff (the server's HlInfoClient) |
| Lighter / Arcus | 20 req/min / 300 weight/min per tab (the server's Pacers, queue-bounded) | same | cooldown from Retry-After, else 60 s |

Only SoDEX needs cross-tab accounting to be safe - its limits ban the whole IP,
trading included. The other venues' per-tab pacers answer overuse with a 429 and
recover by themselves.

**The history rule, measured 2026-09-30** (curl, from an IP nothing else was
reading history from): `/spot/accounts/{a}/trades?limit=1` every ~13 s answered
200, 200, 200, 200 and `error code: 1015` on the 5th request (53 s);
`/orders/history` the same, and the two mixed (T, O, T, O answered 200, the fifth
request, a `/trades`, got 1015): **one counter, about 4 per 60 s** for the pair;
the block lasts about a minute and further requests keep it up. Cloudflare
estimates the rate as the previous minute (weighted) plus the current one, so
any two adjacent minutes must hold at most 4: the drip allows **2 per 60 s**,
`/trades` and `/orders/history` of both engines together (3 per minute was seen
to trip it: three reads at 0-9 s and three at 64-69 s, the sixth refused). A page
that opens four history panels gets two at once and two a minute later, instead
of a 1015 that blanks all four. (The old server path sent such bursts unthrottled; from one IP it hit
the same rule. The indexer's `/trades` drip, off by default, should use these
numbers too.)

**What the venue still serves.** The browser's walk starts from what SoDEX serves
today. `/fundings` now answers only the last couple of days (checked 2026-09-30: 28
rows for the owner's wallet, nothing before 28 Sep, while the server's old cache
holds 4,987 rows back to June); so all-time funding totals cover what the venue
still serves, and the panel's coverage line says from when.

**History reads by priority** (exchange/historyQueue.ts). Two reads a minute is
enough for what is on screen - one history table at a time - as long as nothing
else takes the slots first:

- `visible` - a history table on screen, "load more", a read the user asked for:
  takes any free slot.
- `bulk` - many pages for one view (the copy simulator's walk through a SoDEX
  leader's fills): any free slot too, but never while a table waits - so a walk
  still running after its page was left cannot hold up the table opened next.
- `background` - the account setup's index walk, anything from a hidden tab: only
  an idle drip (checked and taken in one step, so never two at once), only after
  a minute in which no tab wanted a visible read, and not in the first 20 s after
  a page load. So background use is at most one read a minute, and a visible read
  always finds a slot.
- `walk` - the all-time statistics walk: the same conditions, after everything else.

A table that leaves the screen (another tab of the band, another engine or wallet)
gives up its place: a read of its that still waits for a slot is dropped, so the
next slot goes to the table that is shown. A read that was already sent is never
cancelled - its slot is spent - and the answer is kept for the table's next visit.
A read that waits is not sent into a cooldown that opened meanwhile (it ends as
rate-limited, like one started then). The drip's ledger counts 60.5 s: a slot is
taken a few milliseconds before its request leaves, and what is sent must never be
closer than the window.

**History tables between visits** (exchange/historyTables.ts, accountActivity.ts,
AccountHistory.tsx usePagedHistory). Orders, fills, funding and closed positions are
kept in IndexedDB (`vs-account-history`: per network, wallet, engine and kind; the
newest 500 rows of at most 64 tables), with when SoDEX was asked for them. A table
opens at once with what it showed last time. Whether that copy needs a read:

- None, when it was read less than 30 s ago AND nothing can have changed since: the
  page has listened to the wallet's account stream without a break since before the
  read was sent, and heard nothing (a fill changes trade, order and position
  history; an order update changes order history). ws.ts keeps that per wallet,
  engine and channel, from the subscriptions the page holds anyway (fill
  notifications, the account band's live data). Not listening, a dropped connection
  (the socket host reports a wallet connection that dropped as `gap`), a host that
  was away: all count as unknown, and unknown means read. So flipping between tabs,
  or a quick reload, with no trading in between costs nothing - and after a fill
  the next look always reads.
- Otherwise ONE read - for fills only those newer than the newest held
  (`startTime`), for orders the newest page again (an order can close late) - never
  answered from the gateway's 5 s cache. A trigger (a refresh after the user's own
  action, a push on the stream) that arrives while a read still waits for its slot
  is served by that read; one that arrives after it was sent gets one more read.
- While a table is on screen, a push on the account stream is a reason to read only
  if the table lacks what it reports (checked 5 s after the push): a fill it already
  holds, an order that is still open (SoDEX's order history lists filled, canceled,
  rejected and expired orders only) or a final state it already shows need none.
  A push that cannot be read reads, as before.
- After the user's own action (the app's refresh) the table on screen hears the
  stream first, for half a second: a push it lacks - a fill, an order that reached
  a final state - reads at once; a stream that reported nothing it lacks needs no
  read; a stream that says nothing reads as before. So placing an order costs no
  history read (it used to cost one at once and one 5 s later - both of the
  minute's slots, and the fill that followed showed a minute late).

Across a reload, the page that goes away leaves what it knew (localStorage) and the
next one takes it over if it listens again within 8 s. Those seconds cannot be
heard: a fill exactly then appears with the next stream event, or the next look
after 30 s. The usual stale note (clock + age) appears when a catch-up has not
landed after 3 s, when SoDEX refuses it, or at once for a copy older than 5 minutes.

**What a user can still wait for.** History reads on screen go two at a time, one
pair a minute: of reads wanted together, the third and fourth wait up to a minute,
the fifth and sixth up to two (a read waits at most 125 s, then ends as
rate-limited). A table that was open before on this browser shows its rows
meanwhile, with the stale note after 3 s; only a table never opened before shows
"Loading..." that long. Where more than two reads can be wanted within a minute:

- Scan of a SoDEX wallet reads history only through its band - the same tables,
  one read each (checked in the browser: nothing as the page opens). Only if the
  profile read fails, the fallback card adds two small `/trades` reads.
- A wallet that is trading: a fill the table on screen does not hold yet re-reads it
  (at most every 5 s), so with more than two such fills a minute the table follows
  at two reads a minute (stale note in between), and another history table opened
  then waits for a slot.
- A time filter that needs older rows than are loaded (30D, 90D): up to five more
  pages by itself, one per slot.
- The copy simulator on a SoDEX leader: one page per 1000 fills and engine, up to
  five each - two pages a minute, and a table opened meanwhile goes before the
  next page.
- Order History and Trade History of both engines, none opened before: the one shown
  reads first; all four take two minutes.
- Portfolio's "14-day volume" button: one read, like a table.
- After a background read (at most one a minute, never while a table waits): one
  slot is left for that minute.

The account setup's index walk and the all-time walk do not delay any of these:
they read only when nothing on screen has wanted history for a minute.

**All-time walk** (exchange/allTime.ts) is the lowest-priority traffic: one page
per 6 s over every tab and wallet; a `/trades` page only when a background history
read may go (above), so fills walk at about one page a minute; never while the
gateway budget is more than half spent; after a refused walk page, no tab walks
for 30 min. One tab per wallet scope walks (Web Lock `vs-history:<scope>`);
another tab waiting on it shows the walk as running and reads what was stored.

**First paint.** Nothing waits in line before it leaves: the weight budget is kept
in localStorage without a Web Lock per request (it has room to spare - 1200/min of a
6000/min header budget; only the history drip, where one request too many costs a
1015, keeps its lock), a market read by name (book, candles, trades) goes out
together with the market list instead of after it, `index.html` preconnects to the
gateway and the data host while the app loads, and quick reads get 8 s and one retry
inside the 20 s a page waits. Measured in real headless Chrome against the
pre-migration app (HEAD, served on a scratch port against the same backend), warm
runs, from navigation start: order book with prices 1.08-1.29 s now vs 1.04-1.31 s
before; mark price 1.14-1.29 s vs 1.07-1.36 s. (Before these changes the book took
1.36-1.55 s: every read queued for the budget lock, and the book waited for the
market list.)

**Hidden tabs** poll nothing: every poll goes through `pollEvery` / `visibleTimeout`
(exchange/visibility.ts), which pauses while the tab is hidden and catches up once
when it is shown.

---

## 3. Live streams

```
 tab ─┐                         ┌─ wss://mainnet-gw.sodex.dev/ws/perps   (market, shared)
 tab ─┼─ SharedWorker ─ SocketHub┼─ wss://mainnet-gw.sodex.dev/ws/spot    (market, shared)
 tab ─┘  (else a leader tab)     └─ one connection per wallet            (account channels)
```

- **One socket host per browser**: a SharedWorker (`vs-exchange-v1`); where there is
  none, the tabs elect a leader over BroadcastChannel + Web Locks, and a lone tab
  hosts its own (exchange/ws/link.ts). A leader that goes away hands over; the others
  re-subscribe on their own.
- **Connections**: at most 2 market (one per engine) + 6 wallet connections
  (ACCOUNT_CONN_CAP) = 8, under SoDEX's 10 per IP, however many tabs. A wallet
  connection closes 30 s after its last subscriber, a market one after 60 s.
- **Account routing**: SoDEX's account pushes carry no wallet, so each wallet has its
  own connection and a push is routed by the connection it arrived on
  (`sodex/wsProtocol.ts` `pushFor`/`accountPushFor`, shared with the server hub).
  Fill and order notifications come only from the connected wallet's own connection;
  a scanned wallet is subscribed only while Scan shows it.
- **Protocol**: `normaliseSubParams` / `CHANNEL_PARAM_STYLE` imported from
  `sodex/wsProtocol.ts`; keepalive `{"op":"ping"}` every 30 s; every subscription is
  re-sent on reconnect; a late subscriber is seeded with the last snapshot.
- **Only SoDEX**: the host opens nothing but the two gateway origins over wss (plus a
  gateway a build is explicitly pointed at), checked inside the worker
  (exchange/ws/allowed.ts, audit W-01).
- **Where there is no working SharedWorker** (Android Chrome has none; the Claude app's
  embedded browser pane cannot load a module SharedWorker's imports - a SharedWorker
  whose module has none starts, any with an `import` fails with "Failed to fetch a
  worker script", while the same graph runs as a dedicated Worker there and as a
  SharedWorker in real Chrome) the worker's `error` event arrives at once and the tab
  elects a leader; the socket host then runs in the leader tab. REST never depends on
  the worker.
- **Leaving**: when the last tab leaves (closed, reloaded, or into the back-forward
  cache) the host closes its connections at once instead of being cut off; a page
  restored from that cache says hello again, and if the browser stopped the worker
  meanwhile, the tabs elect a leader.
- **Status seen by the panels**: a connection being made for the first time or
  closed because nothing needs it reads as "live", as the server's always-up upstream
  did; only a dropped connection that is retrying shows as delayed.
- **A wallet connection that drops** is not an outage of the engine (nothing is
  shown), but pushes may be missing: the host tells the tabs listening on it
  (message type: `gap`) when it drops and when it is back, and a kept history
  table then counts as not current (section 2, exchange/accountActivity.ts).

---

## 4. Content Security Policy

`apps/web/index.html` lists exactly the hosts above, https and wss, no wildcard:
SoDEX gateway (mainnet, testnet), SoDEX data hosts, alpha-biz, Hyperliquid, Lighter,
Arcus, the WalletConnect relay (wss) and its wallet list (api.web3modal.org), the
ValueChain explorer and the public RPCs the funds sheets read balances from.
`worker-src 'self'`; `font-src 'self'` (the WalletConnect modal is themed with our
self-hosted font and never asks fonts.reown.com - checked in the network log);
`explorer-api.walletconnect.com` and the unused https relay origins are gone.

**A worker does not inherit the page's `<meta>` policy.** The SharedWorker's policy
comes from the HTTP headers its script is served with. Whatever serves `web/dist` in
production must send, on every response (or at least on `/assets/*.js`), a
`Content-Security-Policy` header whose `connect-src` is
`'self' wss://mainnet-gw.sodex.dev wss://testnet-gw.sodex.dev` (plus the https list if
the header is site-wide). The worker's own allow-list check stays the first line.

---

## 5. Hosted mode (`VALUESCAN_HOSTED=1`, apps/server/src/hosted.ts)

Against this inventory, HOSTED_ROUTES should be:

- **Keep**: `/api/health`; the index routes; `/api/vs/whales`, `/api/vs/positioning`,
  `/api/vs/news` (SoSoValue, cached on the process; `not_available` without `SOSOVALUE_API_KEY`),
  `/api/vs/news/sources` (the White House's RSS feeds - Watcher.Guru dropped 2026-10-28 - each read at most every
  5 minutes; valuedesk/feeds.ts), `/api/vs/logo` (a news source's site icon from the site itself - its
  apple-touch-icon or favicon, public hosts only (SSRF guard) - kept a day per site, so the page asks only this origin),
  `/api/vs/calendar` (the economic calendar: federalreserve.gov, bls.gov, bea.gov and SoSoValue,
  each read at most twice a day), `/api/vs/calendar/results` (its releases' official figures,
  read by one watcher in the API process from the publishers' pages at the release second),
  `/api/vs/fed/live` (the Fed's current Brightcove broadcast; valuedesk/releases.ts),
  `/api/vs/fedwatch` (the coming FOMC meetings' decision probabilities from Kalshi's public market
  data, Polymarket's beside; read at most once a minute; valuedesk/fedwatch.ts; OFF unless FOMC_ODDS=on -
  licence review 2026-10-28),
  `/api/vs/fedwatch/history` (one listed meeting's probabilities over 7/30/90 days from Kalshi's
  candlesticks, cached 10 minutes per meeting and range),
  `/api/vs/indicators` (the indicator catalog, no fetch), `/api/vs/indicator` (one catalog
  indicator's history from BLS, BEA, Census, DOL and the Fed Board, read at most every 6 hours; valuedesk/indicators.ts),
  and `/api/vs/etf/flows` (SoSoValue's US spot ETF flows and funds per asset, cached 30 minutes on the
  news key's budget, at most 5 calls a minute; `not_available` without `SOSOVALUE_API_KEY`;
  valuedesk/sosovalue/etf.ts), `/api/vs/oracle` (the shared price oracle for Fill fast: 19 venues' public tickers -
  Binance, Bybit, OKX, Bitget, Gate, MEXC and KuCoin futures and spot, Hyperliquid, Coinbase, Kraken, HTX, Deribit - one read per venue and coin a second
  for all callers together; routes/oracle.ts, valuedesk/oracle.ts)
  (index, drop their `provisional`); `/api/feed/account`;
  `/api/external/maintenance/status`, `/api/external/announcements(/:id)` (until
  they go direct).
- **Add**: `GET /api/vs/lbrow?venue=hyperliquid&address=` (cls `upstreamWhen: address`
  or `read`): one Hyperliquid leaderboard row from the index,
  `valuedesk/hyperliquid/index.ts` `hlLeaderboardRow(address)` - the only index read
  the Scan profile needs. Until it exists the web falls back to
  `/api/vs/leaderboard?q=` and leaves the rank out.
- **Add**: `GET /api/vs/builder/terms?address=&nonce=[&hint=1]` (cls `read`,
  `upstreamWhen: hint`): the builder fee a wallet owes, signed by this server
  (`docs/BUILDER-TIERS.md` §3). The one per-wallet route: it names the wallet the
  app trades with, and a hint makes the server read that wallet's fills from SoDEX
  itself, from its own address, on a budget of its own (§6 there).
- **Add**: `GET /api/vs/builder/volume?address=&builder=&days=` (cls `read`): one
  wallet's counted builder volume, for the hosted copy executor on the other server (its
  copy fee step). Internal: without the `X-Internal-Token` (`VALUESCAN_INTERNAL_TOKEN`)
  it is a 404 even past the gate, since the site's proxy adds the origin secret to every
  request.
- **Add**: the knowledge folders (`routes/folders.ts`), one wallet's own research:
  `POST /api/folders/session` (cls `auth`: a signed `FoldersSignIn`, free typed data,
  for a 7-day token), `GET /api/folders`, `/api/folders/item`, `/api/folders/file/url`
  (where and how big a file is) and `/api/folders/file` (cls `read`, the wallet's token),
  and the changes - `POST /api/folders/folder/{create,rename,delete,order}`,
  `/api/folders/item/{create,update,move,delete}`, `/api/folders/upload/{start,put,finish}`,
  `/api/folders/erase` (cls `write`: per client here, per wallet in the route, and the
  site's Origin). A file's bytes go both ways in 4 MB pieces (`upload/put?part=`,
  `file?part=`) because the Vercel function carries 4.5 MB at most; they are kept on the
  instance's data volume. (An S3 mode exists in the code, FOLDERS_S3_BUCKET, unused: it
  needs an IAM role and the bucket in the CSP.) The only POSTs of the index API; the
  Vercel function lets POST, Content-Type and Authorization through under
  `/api/folders` as under `/api/copy/`, and never caches either.
- **Add**: `GET /api/vs/status` (cls `read`): the public status page's report - each
  service's last probe and its 90 days, built from `status.db` at most every 30 s and
  cacheable at the edge as long (`perf.ts`); no input (routes/status.ts, ops/status.ts).
  It carries the owner's incidents and maintenance too (ops/statusNotices.ts).
- **Add**: `GET /api/vs/status/feed` (cls `read`): the same incidents and maintenance as an
  Atom feed, built from the same cached report, `Cache-Control: public, max-age=300`; no
  input. `/api/health` carries the open ones (at most three, read at most every 30 s) for
  the app's banner, so the banner adds no request.
- **Add**: the feedback chat and the error reports (routes/reports.ts): `POST /api/vs/feedback`
  (a message, 16 KB), `POST /api/vs/feedback/upload` (one screenshot as raw bytes, 2 MiB; PNG,
  JPEG or WebP judged by its bytes, ops/imageCheck.ts), `POST /api/vs/feedback/thread` and
  `POST /api/vs/feedback/poll` (the thread, and the owner's reply counts for up to 10 threads),
  `POST /api/vs/feedback/unread` (1 KB, a browser token: one bit, a new reply since it last saw
  its chat - the unread dot without a signature), all cls `write`; `POST /api/vs/feedback/session` (cls `auth`, 4 KB: a wallet's free signature
  for its chat, ops/feedbackAuth.ts, like `/api/folders/session`);
  `GET /api/vs/feedback/image?id=` (cls `read`), and `POST /api/vs/client-errors`
  (cls `write`, 8 KB, `application/json` or `text/plain` for sendBeacon). The thread token is
  `Authorization: Bearer` (poll: in the body), never in a URL. POSTs need the site's exact Origin;
  each route has far tighter limits of its own. The Vercel function must let these through: POST
  and `Content-Type` and `Authorization` under `/api/vs/feedback` (body up to 2,113,536 bytes on
  `/upload`, 16 KB elsewhere) and POST + `Content-Type` on `/api/vs/client-errors` (8 KB), never
  cached; an image answer is up to 2 MiB (docs/GO-LIVE.md).
- **Add**: `POST /api/vs/a` (cls `write`, 16 KB, `application/json` or `text/plain`): the app's own
  analytics, sent only after the visitor allowed analytics (ops/analyticsModel.ts says what one batch
  holds; routes/analytics.ts). The Vercel function lets POST + `Content-Type` through on this path and adds
  `X-Viewer-Country` / `X-Viewer-Region` from its edge; no IP address is stored, nothing is cached.
- **Add**: the owner's admin suite on dev.valuedesk.so (routes/admin.ts, cls `admin`), 18 routes, every
  one a POST: `/api/admin/session` (the builder wallet's `AdminSignIn` + the password, for a 24 h
  session), `/me`, `/signout`, `/sessions/revoke`, `/tickets`, `/ticket`, `/ticket/image`,
  `/ticket/reply`, `/ticket/status`, `/builder`, `/users`, `/analytics`, `/status`, `/audit`,
  `/page-error` (an error the page hit, into the audit log), `/beta`, `/beta/add`, `/beta/remove` (the
  wallets that may use beta.valuedesk.so; add and remove signed). The gate
  takes only the suite's Origin for them (VALUESCAN_ADMIN_ORIGINS, never the site's); the route answers
  404 to everything while no admin password is set, needs the session on every route but the sign-in and
  a fresh `AdminAction` signature on every write. The Vercel function passes POST, `Content-Type` and
  `Authorization` under `/api/admin/` only for requests to the dev host, never cached.
- **Add**: the beta channel's sign-in (routes/beta.ts), registered by the beta API only
  (`VALUESCAN_CHANNEL=beta`, a 404 on the main API): `POST /api/beta/session` (cls `auth`, 8 KB: a listed
  wallet's `BetaSignIn` for a 7-day token) and `GET /api/beta/me` (cls `read`). The beta API answers every
  other route only with the token of a wallet still on the admin suite's beta list (beta/gate.ts); the
  beta site's Vercel function sends it as `x-vs-beta` from the site's `vs_beta` cookie and adds
  `x-vs-channel: beta`, which Caddy routes to the beta API's port.
- **Remove** (the web no longer calls them): `/api/vs/price`, `/api/vs/trader`,
  `/api/vs/fills`, `/api/vs/account`, `/api/external/leaderboard`,
  `/api/external/leaderboard/rank`, `/api/external/resolve-account`,
  `/api/deposit/chain`.
- **Stay unlisted**: `/ws`, `/api/md/*`, `/api/acct/*`, `/api/stats/*`,
  `/api/mirror/*`, `/api/onboarding`, `/api/wallet/*`, `/api/money/*`,
  `/api/deposit/*`, `/api/points/*`, `/api/session/*`.

Server code that now has a shared, pure core the routes can call instead of their own
copies: `routes/stats.ts` -> `statsCore.ts` (`headlineReader`, `allTimeStatsBody`);
`hub.ts` -> `sodex/wsProtocol.ts` (`pushFor`, `accountPushFor`); `routes/mirror.ts` ->
`sodex/depositOptions.ts` (`buildDepositOptions`, `newDepositAddressRequester`);
`/api/vs/price` -> `valuedesk/hyperliquid/price.ts` (`hlPriceSeries`).
