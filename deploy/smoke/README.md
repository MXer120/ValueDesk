# Production smoke test

Two uses of one script:

- **Before a deploy, locally:** build the web for production, serve it with
  **exactly** the response headers and CSP of `deploy/aws/edge.yaml`, put a
  hosted-mode index API behind `/api` with the origin secret - the way CloudFront
  does - and walk every page in headless Chrome.
- **After a deploy:** walk the real site (`--site=https://...`), and check what
  the real edge sends.

```
node deploy/smoke/smoke.mjs --help
```

| File | |
|---|---|
| `smoke.mjs` | the run: build, API, edge stand-in, browser walk, report, teardown |
| `prod-headers.mjs` | the production header table per path (validated against `edge.yaml`) |
| `static-server.mjs` | the edge stand-in: site with those headers, SPA rewrite, `/api` forwarded with the secret |
| `audit-dist.mjs` | static audit of a build against the production policy (also run by the release scripts) |
| `net-guard.mjs` | preload that refuses every outbound connection of the spawned server |
| `mock-api.mjs` | a stand-in API that only tests this harness |
| `deployed.mjs` | the checks of a deployed site: the headers the edge sends, http to https, the origin closed |
| `cdp.mjs` | headless Chrome over the DevTools protocol, no dependencies |
| `smoke.test.mjs` | `node --test deploy/smoke/smoke.test.mjs` |

## What is checked

Per page - Trade, Explore (overview, cohorts, market map, an asset page),
Leaderboard, Copy, Portfolio, the legal pages (`/impressum`, `/privacy`, `/terms`),
Scan for one wallet on each of the five venues, the Cmd/Ctrl+K palette, and the
legacy `/scan/` redirect:

- the app renders and ends on the expected route;
- **no CSP violation**: the page's own `securitypolicyviolation` events, the
  SharedWorker's, DevTools' CSP issues and requests blocked by the policy;
- **our API**: every `/api` request is one of the 18 routes hosted mode serves
  (read from `apps/server/src/hosted.ts`), and none is answered 403 or 404;
- **WebSockets go to the exchanges, never to us**, and only to origins in
  `connect-src`;
- every direct request goes to an origin the policy lists (`prod-headers.mjs`
  `sourceAllows`: exact origins, and `http://127.0.0.1:*` / `http://localhost:*`
  for a self-hosted copy executor) - and none to the visitor's own machine, since no
  run sets up a self-hosted executor;
- every file of the site loads;
- **console**: no error beyond the known harmless ones (Lighter / Arcus answering
  400 or 403 for an address they do not know). Judged only in a full run;
  uncaught exceptions count in every run.

Once per run:

- the static audit of the build (`audit-dist.mjs`);
- **the hosted gate**, asked directly: health without the secret, an index route
  with and without it, per-user routes 404, custodial routes 410, a write refused,
  a repeated query parameter refused;
- **the SharedWorker under the production policy**: its script is served with the
  site CSP, it starts, it reports no violation, and the exchange sockets are opened
  by it and not by a page.

The report (`smoke-report.json`, with a screenshot per page) lists every request
origin, every API route, every socket and every console line per page.

## Modes

| | What it proves | What leaves this machine |
|---|---|---|
| `--api=none --offline` | headers, CSP, routing, worker start, which routes and origins the app asks for | nothing |
| `--api=spawn --no-index --server-egress=deny --offline` | the above **plus the real hosted gate** end to end | nothing |
| `--api=spawn --no-index --server-egress=deny` | plus the browser-direct pages against the live exchanges | the browser's exchange traffic |
| `--api=spawn --snapshot --server-egress=deny` | plus index data on the index pages | the browser's exchange traffic |
| `--api=spawn --snapshot --server-egress=allow` | **the full local test** | the browser's and the server's exchange traffic |
| `--api=https://staging... ` | a local build against a deployed hosted server (secret in `SMOKE_ORIGIN_SECRET`) | the browser's exchange traffic |
| `--site=https://... [--origin=...]` | **the deployed site as it is** | the browser's exchange traffic |

`--offline` makes every host but loopback unresolvable for the browser. A request
the CSP refuses is refused before any lookup, so the policy checks still hold; what
cannot be seen offline is anything the app only asks for after an answer arrived.

## Two things to know before running it next to a live Valuescan

**1. The API's reader is read-only (since 2026-10-02).**
`apps/server/src/indexer/reader.ts` opens the index with `{ readOnly: true }` and
runs no statement that can change it - no journal mode, no schema, no migration
(before, it opened the file read-write and ran the writer's constructor).
`smoke.mjs` checks that in the source on every run (`readerIsReadOnly`): if an open
without `readOnly: true` ever comes back, it again refuses to start a server on the
live index. `--snapshot` (`VACUUM INTO` from a read-only connection - it reads the
whole file once, a few minutes of disk on a multi-gigabyte index) stays the gentle
choice next to a running indexer: a reader still maps the `-shm` file, and its long
reads hold the WAL from being checkpointed.

**2. The API's own exchange reads are bounded, but they are real.** Positioning is
answered from the index, the whale feeds from one buffer every client shares, and
the Hyperliquid client of an API-only process defaults to 200 weight a minute
(`apps/server/test/publicBudgets.test.ts`). Explore, the screener and the podium
curves still read the venues from the API process, and a second server on a machine
that already runs one spends that from the same address. `--server-egress=deny`
(the default) refuses every outbound connection of the spawned server; it then
answers what the index file holds and reports the rest as unavailable. Use
`--server-egress=allow` where no other Valuescan server shares the address: with the
local dev server stopped, or on a staging instance.

The browser's own traffic is modest - each page is opened once - but it is real,
and it comes from the same address: the Scan pages read account data on every
venue (Hyperliquid's and Lighter's per-address budgets are the tight ones next to
a running indexer), and SoDEX's history through the 2-per-minute drip. `--pages`
limits a run to the pages you name.

## Run it

```
# nothing leaves the machine; proves the build, the headers, the gate
node deploy/smoke/smoke.mjs --api=spawn --no-index --server-egress=deny --offline

# the full local test (stop the local dev server first, or run it on a machine without one)
node deploy/smoke/smoke.mjs --snapshot --server-egress=allow
```

Ports: the site on 4280, the API on 8890, Chrome's debugging port on 4289
(`--port`, `--api-port`, `--cdp-port`; the script refuses ports outside
4280-4289 / 8890-8899 unless `--any-port`). It never touches 5180, 8797, 5173 or
8787. Everything it starts is stopped at the end, and it says so after checking
that the ports are free again. The browser has a throwaway profile: no extension,
no wallet, nothing is ever signed.

The build goes to `deploy/.out/smoke/dist`, not to `apps/web/dist` (`--out=<dir>`
puts the build, the report and the screenshots elsewhere - useful when the
repository lives in a synced folder). The spawned server gets its own state
directory and a random origin secret; nothing under `%LOCALAPPDATA%\Valuescan` (or
`~/.local/share/valuescan`) is read or written, except the live index by
`--snapshot`, read-only.

## After a deploy

```
node deploy/smoke/smoke.mjs --site=https://valuescan.example --origin=origin.valuescan.example
# the EC2 + Vercel test environment (docs/deploy/EC2-VERCEL.md):
node deploy/smoke/smoke.mjs --site=https://valuedeskapp.vercel.app --origin=<elastic-ip-with-dashes>.sslip.io --edge=vercel
```

Nothing is built or started but the browser. On top of the page walk above:

- **the headers the edge really sends**, for the shell, an app route, `/impressum`,
  `/scan/`, `robots.txt`, both favicons, a script, a stylesheet, the SharedWorker's
  script and a logo - each against `prod-headers.mjs`, which is what `edge.yaml` and the
  publish script were written from: the security headers, the CSP of that path
  class, `Cache-Control`, and that scripts and stylesheets have a type a browser
  accepts under `nosniff`;
- **http redirects to https**;
- **the hosted gate through the edge**: health, an index route (which shows that
  CloudFront and the origin hold the same secret), per-user and diagnostics routes
  404, custodial routes gone, a write refused, a repeated parameter refused, HSTS
  on API responses;
- **`--origin`: the instance is closed to you.** From a machine that is not
  CloudFront, its port 443, the API's port (8797) and the copy executor's (8799)
  must not accept a connection, and port 80 must never serve the API. A name that
  does not resolve is an error, not a pass. With `--edge=vercel` port 443 is open on
  purpose (the Vercel function has no fixed addresses): then `/api/health`, an index
  route and `/api/copy/v1/health` asked there without the origin secret must be
  refused - Caddy's gate - and the two loopback ports must still be closed.
- On Vercel the headers come from `deploy/vercel/package.mjs`, which writes the
  same `prod-headers.mjs` table into the deployment's routes
  (`deploy/vercel/vercel.test.mjs` checks they agree path by path). Vercel adds
  its own (`server`, `x-vercel-*`, `age`); those are not judged.

The console is judged in this mode. A page fails on any error line that is not on
the harmless list - including a third party answering badly (a public RPC
returning 429 or 5xx): run it again, and if it stays, that endpoint needs
replacing.

## Tests

```
node --test deploy/smoke/smoke.test.mjs
```

The header table, the stand-ins, the egress guard (every way the server reaches
out: fetch, sockets, TLS, the http agents, HTTP/2, both WebSocket clients) and the
deployed-site checks, each against servers on loopback. Ports are assigned by the
operating system; `TEST_PORT_RANGE=4281-4288` with `--test-concurrency=1` keeps
them inside a range.

## Result of 2026-10-02

On the development machine (Chrome 154, Node 24), next to its running indexer:

| Run | Result |
|---|---|
| Build + static audit | pass (one warning: `index.html` has no meta description) |
| The real hosted server, no index, no egress; browser offline; all 15 pages | pass: gate 10 of 10, pages 15 of 15, SharedWorker |
| The same server; browser **online**; Trade, Explore, Cohorts, Market map, asset, Leaderboard, Copy, Portfolio, palette, Scan of the SoDEX market maker | pass, 10 of 10: live chart, order book and account data; the worker's socket to `wss://mainnet-gw.sodex.dev/ws/perps` open; no console error on any page but, on Scan, the two harmless ones and one HTTP 529 from Polygon's public RPC |
| `--site` against a local stand-in, and against a server without the headers | pass / fails as it should (every missing header named) |

**Not run then:** index data through the hosted server, the server's own exchange
reads, and Scan on Hyperliquid, trade.xyz, Lighter and Arcus with the browser
online - at the time the reader still opened the index read-write and the API's
exchange reads were not bounded. Both are fixed (above); the run that covers them
is `--snapshot --server-egress=allow` on a machine without another Valuescan
server. `docs/deploy/DEPLOY.md` section 13 has the details, section 14 the findings.
