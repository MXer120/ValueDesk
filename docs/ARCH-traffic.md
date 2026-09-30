# Valuescan traffic: who talks to whom

Status: 2026-09-30. Owner of this inventory: the browser-direct rework.

**The rule.** Every user's exchange and chain traffic leaves from that user's own
browser and IP, straight to the exchange. The Valuescan server serves the site and
its **index** (leaderboards, cohorts, screener, explore, the whales tape and
positioning) and nothing that is one user's exchange traffic. Nothing about a
connected wallet, a scanned wallet, an order, a fill, a deposit address or a
balance passes through Valuescan any more, and each user spends their own per-IP
budget at each venue.

Dev and production run the same code path: the browser goes to the exchanges
directly in both. The Vite proxy only carries the index API (`/api/*`) in dev.

---

## 1. Inventory

Class: **(a)** per-user exchange/chain traffic - now browser-direct;
**(b)** index-backed - stays on the Valuescan server; **(c)** other.

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
| `vsApi.trader/fills/openOrders/orderHistory/funding/balances` for SoDEX, Hyperliquid, trade.xyz, Lighter, Arcus (Scan pages, profiles, copy simulator, palette address lookups) | `/api/vs/trader`, `/api/vs/fills`, `/api/vs/account` | exchange/venues.ts: the server's provider code (`valuescan/sodex/traderCore.ts`, `hyperliquid/trader.ts`, `extra/providers.ts`) bound to browser clients | per-trader reads |
| Hyperliquid leaderboard row of one address (rank, aggregated PnL) | inside `/api/vs/trader` | **(b)** `/api/vs/lbrow` (to be added, see 5), meanwhile `/api/vs/leaderboard?q=` without the rank | that row lives in the server's 39 MB index |
| Cohort asset price chart (`vsApi.price`) | `/api/vs/price` | Hyperliquid `candleSnapshot` direct (`hyperliquid/price.ts`) | public market data |
| Palette search (`usePaletteData`) | `/api/vs/screener` | unchanged | **(b)** index |

### 1.5 Stays on the Valuescan server

| Call (web) | Path | Class | Why it stays |
|---|---|---|---|
| Leaderboards, Explore, cohorts (+ detail, map, focus, wallets), screener | `/api/vs/leaderboard`, `/explore`, `/cohorts*`, `/screener` | (b) | the index is the server's job |
| Whales tape, positioning | `/api/vs/whales`, `/api/vs/positioning` | (b) | aggregated server-side from venue trade streams; not one user's traffic |
| Deep link by SoDEX account id (App.tsx) | `/api/feed/account` | (b) | resolved from the index's leaderboard map, on-chain only as a fallback |
| Server status and network | `/api/health` | (c) | about Valuescan itself |
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

**All-time walk** (exchange/allTime.ts) is the lowest-priority traffic: one page
per 6 s over every tab and wallet; a `/trades` page only while at most one of the
nothing else read history in the last minute (the fill and order panels always
find a slot), so fills walk at about one page a minute; never while the gateway budget
is more than half spent; after a refused walk page, no tab walks for 30 min. One tab per wallet scope walks (Web Lock `vs-history:<scope>`);
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

- **Keep**: `/api/health`; the index routes; `/api/vs/whales`, `/api/vs/positioning`
  (index, drop their `provisional`); `/api/feed/account`;
  `/api/external/maintenance/status`, `/api/external/announcements(/:id)` (until
  they go direct).
- **Add**: `GET /api/vs/lbrow?venue=hyperliquid&address=` (cls `upstreamWhen: address`
  or `read`): one Hyperliquid leaderboard row from the index,
  `valuescan/hyperliquid/index.ts` `hlLeaderboardRow(address)` - the only index read
  the Scan profile needs. Until it exists the web falls back to
  `/api/vs/leaderboard?q=` and leaves the rank out.
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
`/api/vs/price` -> `valuescan/hyperliquid/price.ts` (`hlPriceSeries`).
