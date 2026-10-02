# Performance tools

The measurement harness behind `docs/PERFORMANCE.md`. No dependencies: Node 22+
(built-in `fetch` and `WebSocket`) driving a headless Chrome over the DevTools
protocol. Chrome is taken from `CHROME_PATH`, else the usual install location.

Run everything from `apps/web`. Results go wherever you point them; keep them
out of the repo.

| tool | answers |
|---|---|
| `bundle-report.mjs` | what the first render waits for, per landing page, and where those bytes come from (from the build's sourcemaps) |
| `metrics.mjs` + `summarize.mjs` | per page: FCP, LCP, data shown, TBT, TTI, heap; requests and bytes to the site, to our API and to the exchanges; WebSockets |
| `rates.mjs` + `rates-compare.mjs` | requests per minute to our API (per path) and to the exchanges; what a hidden tab sends; the catch-up on return |
| `payloads.mjs` | bytes of every index answer (raw, gzip, brotli), its cache policy, and fields no web source reads |
| `profile.mjs` | CPU profile of a page, self time per ORIGINAL source function |
| `shots.mjs` | the pixel comparison: record live data once, replay any build from it |
| `revisit.mjs` | how a page's index reads are answered: first read, polls, and the page reopened shortly after |
| `early-keys.mjs` | keys typed the moment the page appears: does the palette open with all of them |
| `smoke.mjs` | every page loads, with its console errors and failed requests |
| `preview.config.mjs` | serves one built `dist` on its own port, API proxied |

`cdp.mjs`, `pages.mjs`, `traffic.mjs` and `png.mjs` are their shared parts: the
Chrome launcher and protocol client, the page list, the request recorder (which
also attaches to the SharedWorker that holds the exchange sockets) and a PNG
codec.

## Before / after

The comparison is between two BUILDS served side by side against the same
backend, so that only the code differs.

**1. Two trees.** "Before" is a clean export of the commit to compare against;
"after" is the working tree (or another export).

```sh
mkdir -p /tmp/perf/before
git archive <commit> apps/web apps/server packages package.json | tar -x -C /tmp/perf/before
# give the export the repo's node_modules (a junction on Windows, a symlink elsewhere):
#   node_modules, apps/web/node_modules, apps/server/node_modules
cp apps/web/.env.local /tmp/perf/before/apps/web/      # the same build-time settings
```

Never delete an export with a recursive delete while those links are in it:
remove the links first.

**2. Build both** with sourcemaps that are not referenced from the files:

```sh
(cd /tmp/perf/before/apps/web && npx vite build --sourcemap hidden)
npx vite build --sourcemap hidden --outDir /tmp/perf/after-dist
```

**3. Serve both** (ports 4180-4189 are this harness's; `:5180` and `:8797` are
the dev servers and stay untouched). The proxy target defaults to the running
dev server, which adds the local API token; against a hosted-mode server set
`API=`.

```sh
DIST=/tmp/perf/before/apps/web/dist PORT=4180 node node_modules/vite/bin/vite.js preview --config tools/perf/preview.config.mjs &
DIST=/tmp/perf/after-dist           PORT=4181 node node_modules/vite/bin/vite.js preview --config tools/perf/preview.config.mjs &
```

**4. Measure.** Nothing else should be busy on the machine while the timed
runs go: one build or test suite in the middle of a run shows up in its numbers.

```sh
# bundle
node tools/perf/bundle-report.mjs /tmp/perf/before/apps/web/dist /tmp/perf/bundle-before.json before
node tools/perf/bundle-report.mjs /tmp/perf/after-dist             /tmp/perf/bundle-after.json  after

# runtime: cold loads, the two builds interleaved run by run, median of 3,
# unthrottled ("fast") and 4x CPU + 10 Mbit/s ("slow")
node tools/perf/metrics.mjs before=http://127.0.0.1:4180,after=http://127.0.0.1:4181 /tmp/perf/metrics.json
node tools/perf/summarize.mjs /tmp/perf/metrics.json

# the same for a return visit (warm HTTP cache and localStorage)
node tools/perf/metrics.mjs before=http://127.0.0.1:4180,after=http://127.0.0.1:4181 /tmp/perf/return.json --return
node tools/perf/summarize.mjs /tmp/perf/return.json

# traffic: one walk per build (they can run at the same time, on different --port)
node tools/perf/rates.mjs http://127.0.0.1:4180 /tmp/perf/rates-before.json --port=9350
node tools/perf/rates.mjs http://127.0.0.1:4181 /tmp/perf/rates-after.json  --port=9351
node tools/perf/rates-compare.mjs /tmp/perf/rates-before.json /tmp/perf/rates-after.json --paths

# payloads (a server change: run it before and after the server is swapped)
node tools/perf/payloads.mjs http://127.0.0.1:5180 /tmp/perf/payloads-before.json --web=src
node tools/perf/payloads.mjs --compare /tmp/perf/payloads-before.json /tmp/perf/payloads-after.json
```

`metrics.mjs` takes `--pages=<regex>`, `--runs=`, `--profile=fast|slow|both`.
Every load is a fresh browser profile, and every load of a Scan page reads that
wallet's history from the exchange under the visitor's own rate budget - so the
SoDEX Scan page (`scan-sodex`) is best measured on its own with few runs
(`--pages=^scan-sodex$ --runs=1`), not six times a minute.

"Data shown" is the page's own data on screen (the marker per page is in
`pages.mjs`): rows in the order book, the leaderboard, the Explore tables, the
cohort cards. FCP and LCP are the shell's; this is what a visitor waits for.

The Scan pages show one public wallet per venue: the top of that venue's 30-day
board at the time of the run. To compare runs made on different days, pin them:
`PERF_ADDR_SODEX=0x... PERF_ADDR_HYPERLIQUID=0x...` (also `TRADEXYZ`, `LIGHTER`,
`ARCUS`).

`rates-compare.mjs` counts the requests that went over the network (the
browser's, minus what its HTTP cache answered). For the server's own count,
start the preview with `ACCESS_LOG=<file>`, give the same file to
`rates.mjs --access-log=<file>` and compare with `--server` - one walk per log
file, and nothing else through that port meanwhile.

**5. Where the time goes.**

```sh
# the load itself, 4x CPU slowdown, first 8 s
node tools/perf/profile.mjs http://127.0.0.1:4181/trade /tmp/perf/after-dist /tmp/perf/prof-trade.json --cpu=4 --warm=0 --secs=8
# steady state: 10 s recorded after 6 s
node tools/perf/profile.mjs http://127.0.0.1:4181/explore /tmp/perf/after-dist /tmp/perf/prof-explore.json
```

Layout that a script forces (`offsetWidth`, `getBoundingClientRect`,
`getComputedStyle`) is billed to the function that asked for it.

## Pixel compare

Nothing a user sees may change, so every change is checked against screenshots
of the baseline: 21 states (every page, all five Scan venues, the palette
opened two ways, three client-side navigations, a removed-page URL, two mobile
viewports).

```sh
# once: record the live data behind every state (the clock is frozen at this moment)
node tools/perf/shots.mjs record http://127.0.0.1:4180 /tmp/perf/fixtures

# the baseline, three times: what a pixel may be
for i in 1 2 3; do node tools/perf/shots.mjs replay http://127.0.0.1:4180 /tmp/perf/fixtures /tmp/perf/shots/base$i; done

# the build under test, and the two verdicts
node tools/perf/shots.mjs replay   http://127.0.0.1:4181 /tmp/perf/fixtures /tmp/perf/shots/after
node tools/perf/shots.mjs envelope /tmp/perf/shots/base1,/tmp/perf/shots/base2,/tmp/perf/shots/base3 /tmp/perf/shots/after /tmp/perf/shots/diff
node tools/perf/shots.mjs layout   /tmp/perf/shots/base1 /tmp/perf/shots/after
```

A replay makes no request beyond the build's own files: our API and every
exchange host are answered from the recording (always with the first answer
recorded for a request, so a poll firing just before the capture changes
nothing), each socket subscription gets the first push recorded for it, the
clock is frozen and `Math.random` seeded. Both modes switch `SharedWorker` off,
so the app hosts its exchange sockets in the page - its own fallback - where the
harness can see and fake them.

`envelope` passes a pixel when each channel lies within the range the baseline
replays took (the baseline is not perfectly reproducible itself: gradient
dithering, raster logo downscaling); what falls outside is written to the diff
folder in magenta. `compare` is the strict two-folder diff. Run the build under
test twice: a deviation that is in one run and not the other is noise of the
same kind, one that is in both is a change.

`layout` is the check the rasteriser cannot blur. Every replay also writes
`<state>.dom.json`: each element's tag, classes, box (to 1/100 px) and own
text, in document order. Two runs with equal files show the same elements in
the same places with the same text; a state that is equal here and off by a
grey level on a few edge pixels differs in how it was painted, not in what is
on the page. Compare the baseline with itself too (`layout base1 base2`): a
state that differs there is not reproducible in this harness (a chart that
waits on a request pacer under the frozen clock), and says nothing about the
build under test.

A replay that asks for something the recording does not hold lists it at the
end ("requests the recording has no answer for"). A build that reads a new
endpoint needs a new recording that both builds can be replayed from - or the
state is not comparable.

A SERVER payload change is checked the same way with two recordings of the same
data: the recording as it is, and a copy whose index answers were rewritten by
the server's own functions (the trims of 2026-10-02 were checked like that:
`perf.ts` `omitNullLabels`, `explore.ts` and `screener.ts` `wireRow`). Replaying
one build from both must give the same pixels.

## Behaviour checks

Two things a screenshot cannot show, each run on both builds:

```sh
# HTTP caching: the first read and every poll go to the network (polls as
# conditional requests), a page reopened within 30 s is answered by the HTTP
# cache. --gap is the seconds spent away, --latency an emulated round trip.
node tools/perf/revisit.mjs before=http://127.0.0.1:4180,after=http://127.0.0.1:4181 --gap=5  --latency=60
node tools/perf/revisit.mjs before=http://127.0.0.1:4180,after=http://127.0.0.1:4181 --gap=18 --latency=60
node tools/perf/revisit.mjs before=http://127.0.0.1:4180,after=http://127.0.0.1:4181 --gap=40 --latency=60

# typing the moment the page appears (1.5 Mbit/s): the whole word must arrive,
# and the search box must get the focus as soon after the first key as before
node tools/perf/early-keys.mjs before=http://127.0.0.1:4180,after=http://127.0.0.1:4181 24
node tools/perf/early-keys.mjs before=http://127.0.0.1:4180,after=http://127.0.0.1:4181 24 --gap=80 --delay=300
```

`revisit.mjs` takes `--page`, `--sel` (the page's data marker), `--api` and
`--away` for a page other than the leaderboard, e.g. the cohort list's
60-second poll: `--page=/explore?view=cohorts --sel=.coh-card__wallets
--api=/api/vs/cohorts --polls=1`.

## Checks while editing

```sh
node tools/perf/smoke.mjs http://127.0.0.1:5180        # the dev app: every page renders, console is clean
node tools/perf/smoke.mjs http://127.0.0.1:4181 --pages='^(trade|palette)$'
```
